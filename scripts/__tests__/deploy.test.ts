// @vitest-environment node
import {
  main,
  parseDest,
  planDeploy,
  shellQuote,
  validateConfig,
  type PlanOptions,
} from '../deploy.ts';

const opts: PlanOptions = {
  repoRoot: '/repo',
  configPath: '/repo/deploy.config.json',
  build: true,
  dryRun: false,
};

describe('parseDest', () => {
  it('treats a colon before the first slash as an SSH host', () => {
    expect(parseDest('host:/srv/www', '/cfg')).toEqual({ host: 'host', path: '/srv/www' });
    expect(parseDest('me@host:/srv/www', '/cfg')).toEqual({ host: 'me@host', path: '/srv/www' });
    expect(parseDest('host:www', '/cfg')).toEqual({ host: 'host', path: 'www' });
  });

  it('resolves local paths against the config directory', () => {
    expect(parseDest('/srv/www', '/cfg')).toEqual({ path: '/srv/www' });
    expect(parseDest('../www', '/cfg/sub')).toEqual({ path: '/cfg/www' });
    expect(parseDest('./odd:name', '/cfg')).toEqual({ path: '/cfg/odd:name' });
  });

  it('rejects daemon destinations, empty paths and the root', () => {
    expect(() => parseDest('host::module', '/cfg')).toThrow(/daemon/);
    expect(() => parseDest('rsync://host/module', '/cfg')).toThrow(/daemon/);
    expect(() => parseDest('host:', '/cfg')).toThrow(/needs a path/);
    expect(() => parseDest('host:/', '/cfg')).toThrow(/root/);
    expect(() => parseDest('/', '/cfg')).toThrow(/root/);
  });
});

describe('shellQuote', () => {
  it('leaves safe words alone and single-quotes the rest', () => {
    expect(shellQuote('/opt/gremlinofa-server')).toBe('/opt/gremlinofa-server');
    expect(shellQuote('has space')).toBe(`'has space'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('$HOME')).toBe(`'$HOME'`);
  });
});

describe('validateConfig', () => {
  it('accepts a full target entry', () => {
    const config = validateConfig(
      { server: { dest: 'h:/p', postDeploy: 'npm i', exclude: ['x/'], rsyncArgs: ['-v'] } },
      'cfg'
    );
    expect(config.server).toEqual({
      dest: 'h:/p',
      postDeploy: 'npm i',
      exclude: ['x/'],
      rsyncArgs: ['-v'],
    });
  });

  it('rejects unknown targets and fields', () => {
    expect(() => validateConfig({ frontned: { dest: '/x' } }, 'cfg')).toThrow(/unknown target/);
    expect(() => validateConfig({ server: { dest: '/x', postdeploy: 'npm i' } }, 'cfg')).toThrow(
      /unknown field "server.postdeploy"/
    );
  });

  it('rejects bad field types', () => {
    expect(() => validateConfig([], 'cfg')).toThrow(/JSON object/);
    expect(() => validateConfig({ server: {} }, 'cfg')).toThrow(/dest/);
    expect(() => validateConfig({ server: { dest: 42 } }, 'cfg')).toThrow(/dest/);
    expect(() => validateConfig({ server: { dest: '/x', postDeploy: [] } }, 'cfg')).toThrow(
      /postDeploy/
    );
    expect(() => validateConfig({ server: { dest: '/x', exclude: 'x/' } }, 'cfg')).toThrow(
      /exclude/
    );
    expect(() => validateConfig({ server: { dest: '/x', rsyncArgs: [1] } }, 'cfg')).toThrow(
      /rsyncArgs/
    );
  });
});

describe('planDeploy', () => {
  it('skips unconfigured targets and fails when nothing is left', () => {
    const { steps, skipped } = planDeploy(
      { frontend: { dest: '/www' } },
      ['frontend', 'server'],
      opts
    );
    expect(skipped).toEqual(['server']);
    expect(steps.every(step => step.target === 'frontend')).toBe(true);
    expect(() => planDeploy({}, ['server'], opts)).toThrow(/nothing to deploy/);
  });

  it('runs every build before the first sync', () => {
    const { steps } = planDeploy(
      { frontend: { dest: '/www' }, server: { dest: 'h:/srv', postDeploy: 'npm i' } },
      ['frontend', 'server'],
      opts
    );
    expect(steps.map(step => `${step.target}:${step.phase}`)).toEqual([
      'frontend:build',
      'server:build',
      'frontend:sync',
      'server:sync',
      'server:postDeploy',
    ]);
    expect(steps[1].argv).toEqual(['npm', 'run', 'build:server']);
  });

  it('drops build steps with build: false', () => {
    const { steps } = planDeploy({ frontend: { dest: '/www' } }, ['frontend'], {
      ...opts,
      build: false,
    });
    expect(steps.map(step => step.phase)).toEqual(['sync']);
  });

  it('protects server runtime state behind user excludes, then appends rsync args', () => {
    const { steps } = planDeploy(
      { server: { dest: 'me@h:/srv', exclude: ['logs/'], rsyncArgs: ['--chown=g:g'] } },
      ['server'],
      { ...opts, build: false }
    );
    expect(steps[0]).toEqual({
      target: 'server',
      phase: 'sync',
      argv: [
        'rsync',
        '-rc',
        '--delete',
        '--exclude=logs/',
        '--filter=+ .env.example',
        '--filter=- .env',
        '--filter=- .env.*',
        '--filter=- *.env',
        '--filter=- /data',
        '--filter=- /node_modules',
        '--filter=- /package-lock.json',
        '--chown=g:g',
        '/repo/dist/server/',
        'me@h:/srv',
      ],
      requires: '/repo/dist/server/server.js',
    });
  });

  it('resolves a relative local dest against the config file', () => {
    const { steps } = planDeploy({ frontend: { dest: '../www' } }, ['frontend'], {
      ...opts,
      build: false,
    });
    expect(steps[0].argv.at(-1)).toBe('/www');
  });

  it('runs a local postDeploy in the dest dir', () => {
    const { steps } = planDeploy(
      { 'vfs-server': { dest: '/opt/vfs', postDeploy: 'npm install --omit=dev' } },
      ['vfs-server'],
      { ...opts, build: false }
    );
    expect(steps[1]).toEqual({
      target: 'vfs-server',
      phase: 'postDeploy',
      argv: ['sh', '-c', 'npm install --omit=dev'],
      cwd: '/opt/vfs',
      printOnly: false,
    });
  });

  it('runs a remote postDeploy through the login shell over ssh', () => {
    const { steps } = planDeploy(
      { server: { dest: 'me@h:/opt/my server', postDeploy: 'npm install' } },
      ['server'],
      { ...opts, build: false }
    );
    expect(steps[1].argv).toEqual([
      'ssh',
      'me@h',
      `exec "$SHELL" -lc 'cd '\\''/opt/my server'\\'' && npm install'`,
    ]);
    expect(steps[1].cwd).toBeUndefined();
  });

  it('makes rsync itemize and postDeploy print-only on dry run', () => {
    const { steps } = planDeploy({ server: { dest: 'h:/srv', postDeploy: 'npm i' } }, ['server'], {
      ...opts,
      dryRun: true,
    });
    const sync = steps.find(step => step.phase === 'sync')!;
    expect(sync.argv.slice(0, 5)).toEqual([
      'rsync',
      '-rc',
      '--delete',
      '--dry-run',
      '--itemize-changes',
    ]);
    expect(steps.find(step => step.phase === 'postDeploy')!.printOnly).toBe(true);
    expect(steps.find(step => step.phase === 'build')!.printOnly).toBeUndefined();
  });

  it('reports which target has a bad dest', () => {
    expect(() => planDeploy({ server: { dest: 'h::mod' } }, ['server'], opts)).toThrow(
      /^server: rsync daemon/
    );
  });
});

describe('main', () => {
  it('rejects missing and unknown targets without touching anything', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([])).toBe(1);
    expect(main(['backend'])).toBe(1);
    expect(main(['frontend', '--config', '/nonexistent/deploy.config.json'])).toBe(1);
    expect(errorSpy.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringMatching(/no target given/),
      expect.stringMatching(/unknown target "backend"/),
      expect.stringMatching(/no deploy config at \/nonexistent\/deploy\.config\.json/),
    ]);
    errorSpy.mockRestore();
  });
});
