// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const INIT_SCRIPTS = [
  'touch-grass-backend/gremlinofa-touch-grass.initd',
  'storage-backend/gremlinofa-storage.initd',
  'cors-proxy/gremlinofa-cors-proxy.initd',
  'src/server/vfsFacade/deploy/gremlinofa-vfs.initd',
];

// Sources an init script with OpenRC's helpers stubbed and runs start_pre.
// The `su` stand-in runs the command as the current user, so `test -r` sees the
// same permissions the service user would on a file it owns.
const HARNESS = `
checkpath() { :; }
ewarn() { echo "WARN $*"; }
eerror() { echo "ERROR $*"; }
su() {
  [ "$1" = -s ] && [ "$3" = -c ] || { echo "unexpected su usage: $*"; return 99; }
  echo "SU_USER $5"
  _shell=$2; _cmd=$4; shift 5
  "$_shell" -c "$_cmd" "$@"
}
. "$INITD"
echo "DIRECTORY $directory"
echo "COMMAND_ARGS $command_args"
start_pre
status=$?
echo "DOTENV_CONFIG_PATH $DOTENV_CONFIG_PATH"
exit $status
`;

const runningAsRoot = process.getuid?.() === 0;

describe.each(INIT_SCRIPTS)('%s start_pre', initd => {
  let scratch: string;
  let envFile: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'initd-'));
    envFile = path.join(scratch, '.env');
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function startPre() {
    return spawnSync('sh', ['-c', HARNESS], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        INITD: path.join(repoRoot, initd),
        GREMLINOFA_DIR: scratch,
        GREMLINOFA_USER: 'svc',
      },
    });
  }

  it('runs the flat layout from the install dir and hands the env file to dotenv', () => {
    writeFileSync(envFile, 'PORT=1\n');
    const run = startPre();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`DIRECTORY ${scratch}\n`);
    expect(run.stdout).toContain(`COMMAND_ARGS ${scratch}/index.js\n`);
    expect(run.stdout).toContain(`DOTENV_CONFIG_PATH ${envFile}\n`);
    expect(run.stdout).toContain('SU_USER svc\n');
    expect(run.stdout).not.toContain('ERROR');
  });

  it.skipIf(runningAsRoot)(
    'refuses to start when the service user cannot read the env file',
    () => {
      writeFileSync(envFile, 'AUTH_PASSWORD=secret\n');
      chmodSync(envFile, 0o000);
      const run = startPre();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(`ERROR ${envFile} is not readable by svc`);
    }
  );

  it('starts without an env file', () => {
    const run = startPre();
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('ERROR');
    expect(run.stdout).not.toContain('SU_USER');
  });
});
