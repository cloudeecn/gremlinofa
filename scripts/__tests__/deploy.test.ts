// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  main,
  parseDest,
  planDeploy,
  shellQuote,
  TARGETS,
  validateConfig,
  type PlanOptions,
} from '../deploy.ts';

function readRepoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));
}

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

  it('accepts the committed example config with every target', () => {
    const config = validateConfig(
      readRepoJson('deploy.config.example.json'),
      'deploy.config.example.json'
    );
    expect(Object.keys(config).sort()).toEqual(Object.keys(TARGETS).sort());
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

describe('TARGETS', () => {
  it('builds every target with a root npm script', () => {
    const { scripts } = readRepoJson('package.json') as { scripts: Record<string, string> };
    for (const spec of Object.values(TARGETS)) {
      expect(scripts).toHaveProperty([spec.buildScript]);
    }
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

  it('syncs touch-grass from its package dist and keeps its database', () => {
    const { steps } = planDeploy(
      { 'touch-grass': { dest: 'h:/opt/gremlinofa-touch-grass' } },
      ['touch-grass'],
      opts
    );
    expect(steps[0].argv).toEqual(['npm', 'run', 'build:touch-grass']);
    expect(steps[1].argv).toEqual([
      'rsync',
      '-rc',
      '--delete',
      '--filter=+ .env.example',
      '--filter=- .env',
      '--filter=- .env.*',
      '--filter=- *.env',
      '--filter=- /data',
      '--filter=- /node_modules',
      '--filter=- /package-lock.json',
      '--filter=- /*.db*',
      '/repo/touch-grass-backend/dist/',
      'h:/opt/gremlinofa-touch-grass',
    ]);
    expect(steps[1].requires).toBe('/repo/touch-grass-backend/dist/index.js');
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

const hasRsync = spawnSync('rsync', ['--version']).status === 0;

describe.skipIf(!hasRsync)('planned rsync against a real destination', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'deploy-rsync-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('keeps runtime state, including symlinked data and node_modules, and deletes stale files', () => {
    const repoRoot = path.join(scratch, 'repo');
    const distDir = path.join(repoRoot, 'touch-grass-backend/dist');
    mkdirSync(path.join(distDir, 'static'), { recursive: true });
    writeFileSync(path.join(distDir, 'index.js'), 'new');
    writeFileSync(path.join(distDir, 'static/app.js'), 'new');
    writeFileSync(path.join(distDir, '.env.example'), 'new');

    const dest = path.join(scratch, 'dest');
    const elsewhere = path.join(scratch, 'elsewhere');
    mkdirSync(path.join(elsewhere, 'data'), { recursive: true });
    mkdirSync(path.join(elsewhere, 'node_modules'), { recursive: true });
    mkdirSync(path.join(dest, 'static'), { recursive: true });
    symlinkSync(path.join(elsewhere, 'data'), path.join(dest, 'data'));
    symlinkSync(path.join(elsewhere, 'node_modules'), path.join(dest, 'node_modules'));
    const operatorFiles = [
      '.env',
      '.env.local',
      '.env.production',
      'prod.env',
      'touch-grass.db',
      'package-lock.json',
    ];
    for (const file of [...operatorFiles, '.env.example', 'index.js', 'stale.js']) {
      writeFileSync(path.join(dest, file), 'old');
    }
    writeFileSync(path.join(dest, 'static/removed.css'), 'old');

    const { steps } = planDeploy({ 'touch-grass': { dest } }, ['touch-grass'], {
      repoRoot,
      configPath: path.join(repoRoot, 'deploy.config.json'),
      build: false,
      dryRun: false,
    });
    const [sync] = steps;
    const rsync = spawnSync(sync.argv[0], sync.argv.slice(1), { encoding: 'utf8' });
    expect(rsync.stderr).toBe('');
    expect(rsync.status).toBe(0);

    expect(readlinkSync(path.join(dest, 'data'))).toBe(path.join(elsewhere, 'data'));
    expect(readlinkSync(path.join(dest, 'node_modules'))).toBe(
      path.join(elsewhere, 'node_modules')
    );
    for (const file of operatorFiles) {
      expect(readFileSync(path.join(dest, file), 'utf8')).toBe('old');
    }
    expect(readFileSync(path.join(dest, '.env.example'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(dest, 'index.js'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(dest, 'static/app.js'), 'utf8')).toBe('new');
    expect(existsSync(path.join(dest, 'stale.js'))).toBe(false);
    expect(existsSync(path.join(dest, 'static/removed.css'))).toBe(false);
  });

  it('lets a user exclude keep .env.example out of the sync', () => {
    const repoRoot = path.join(scratch, 'repo');
    const distDir = path.join(repoRoot, 'dist/server');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'server.js'), 'new');
    writeFileSync(path.join(distDir, '.env.example'), 'new');
    const dest = path.join(scratch, 'dest');
    mkdirSync(dest);
    writeFileSync(path.join(dest, '.env.example'), 'old');

    const { steps } = planDeploy({ server: { dest, exclude: ['.env.example'] } }, ['server'], {
      repoRoot,
      configPath: path.join(repoRoot, 'deploy.config.json'),
      build: false,
      dryRun: false,
    });
    const rsync = spawnSync(steps[0].argv[0], steps[0].argv.slice(1), { encoding: 'utf8' });
    expect(rsync.status).toBe(0);
    expect(readFileSync(path.join(dest, '.env.example'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(dest, 'server.js'), 'utf8')).toBe('new');
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
