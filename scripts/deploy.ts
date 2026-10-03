/**
 * Build and rsync the deployable bundles to the destinations in
 * `deploy.config.json` (gitignored; see `deploy.config.example.json`).
 *
 *   node scripts/deploy.ts <target...> [--dry-run] [--no-build] [--config <path>]
 *
 * Runs via Node's built-in type stripping (Node >= 22.18).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type TargetName = 'frontend' | 'server' | 'vfs-server';

interface TargetSpec {
  buildScript: string;
  distDir: string;
  /** Must exist in `distDir` before syncing: rsync --delete from an empty source wipes the dest. */
  sanityFile: string;
  /** rsync filter rules (first match wins) that keep runtime state on the dest out of the sync's reach. */
  protect: readonly string[];
}

// .env.example ships in every server dist, so it syncs; any other .env.* (.env.local,
// .env.production) belongs to the operator. Its include has to come before '- .env.*'.
// No trailing slash on /data and /node_modules: `/data/` only matches a directory,
// so --delete would remove a `data` symlink pointing at another disk.
const SERVER_RUNTIME_STATE = [
  '+ .env.example',
  '- .env',
  '- .env.*',
  '- *.env',
  '- /data',
  '- /node_modules',
  '- /package-lock.json',
];

export const TARGETS: Record<TargetName, TargetSpec> = {
  frontend: {
    buildScript: 'build:frontend',
    distDir: 'dist/frontend',
    sanityFile: 'index.html',
    protect: [],
  },
  server: {
    buildScript: 'build:server',
    distDir: 'dist/server',
    sanityFile: 'server.js',
    protect: SERVER_RUNTIME_STATE,
  },
  'vfs-server': {
    buildScript: 'build:vfs-server',
    distDir: 'dist/vfs-server',
    sanityFile: 'index.js',
    protect: SERVER_RUNTIME_STATE,
  },
};

const TARGET_NAMES = Object.keys(TARGETS) as TargetName[];

export interface TargetConfig {
  dest: string;
  postDeploy?: string;
  exclude?: string[];
  rsyncArgs?: string[];
}

export type DeployConfig = Partial<Record<TargetName, TargetConfig>>;

const TARGET_FIELDS = new Set(['dest', 'postDeploy', 'exclude', 'rsyncArgs']);

export interface Dest {
  /** `[user@]host` for SSH destinations; absent for the local machine. */
  host?: string;
  path: string;
}

export interface Step {
  target: TargetName;
  phase: 'build' | 'sync' | 'postDeploy';
  argv: string[];
  cwd?: string;
  /** Checked right before running, after the build steps had their chance to create it. */
  requires?: string;
  printOnly?: boolean;
}

export interface PlanOptions {
  repoRoot: string;
  configPath: string;
  build: boolean;
  dryRun: boolean;
}

function isTargetName(name: string): name is TargetName {
  return Object.hasOwn(TARGETS, name);
}

/**
 * Splits an rsync-style destination the way rsync does: a colon before the
 * first slash means `[user@]host:path` over SSH, anything else is local.
 * Relative local paths resolve against the config file's directory.
 */
export function parseDest(dest: string, configDir: string): Dest {
  if (dest.startsWith('rsync://')) {
    throw new Error(`rsync daemon destinations aren't supported: ${dest}`);
  }
  const colon = dest.indexOf(':');
  const slash = dest.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const host = dest.slice(0, colon);
    const remotePath = dest.slice(colon + 1);
    if (remotePath.startsWith(':')) {
      throw new Error(`rsync daemon destinations aren't supported: ${dest}`);
    }
    if (remotePath === '') {
      throw new Error(`dest "${dest}" needs a path after the colon`);
    }
    if (/^\/+$/.test(remotePath)) {
      throw new Error(`refusing to deploy to the filesystem root: ${dest}`);
    }
    return { host, path: remotePath };
  }
  if (dest === '') {
    throw new Error('dest is empty');
  }
  const localPath = path.resolve(configDir, dest);
  if (localPath === path.parse(localPath).root) {
    throw new Error(`refusing to deploy to the filesystem root: ${dest}`);
  }
  return { path: localPath };
}

export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function isStringArray(field: unknown): field is string[] {
  return Array.isArray(field) && field.every(entry => typeof entry === 'string');
}

/** Strict on purpose: a typo'd field like `postdeploy` should fail, not silently skip the step. */
export function validateConfig(raw: unknown, source: string): DeployConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object keyed by target name`);
  }
  const config: DeployConfig = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isTargetName(name)) {
      throw new Error(`${source}: unknown target "${name}" (expected ${TARGET_NAMES.join(', ')})`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${source}: "${name}" must be an object`);
    }
    for (const field of Object.keys(entry)) {
      if (!TARGET_FIELDS.has(field)) {
        throw new Error(
          `${source}: unknown field "${name}.${field}" (expected ${[...TARGET_FIELDS].join(', ')})`
        );
      }
    }
    const { dest, postDeploy, exclude, rsyncArgs } = entry as Record<string, unknown>;
    if (typeof dest !== 'string' || dest === '') {
      throw new Error(`${source}: "${name}.dest" must be a non-empty string`);
    }
    if (postDeploy !== undefined && typeof postDeploy !== 'string') {
      throw new Error(`${source}: "${name}.postDeploy" must be a string`);
    }
    if (exclude !== undefined && !isStringArray(exclude)) {
      throw new Error(`${source}: "${name}.exclude" must be an array of strings`);
    }
    if (rsyncArgs !== undefined && !isStringArray(rsyncArgs)) {
      throw new Error(`${source}: "${name}.rsyncArgs" must be an array of strings`);
    }
    config[name] = { dest, postDeploy, exclude, rsyncArgs };
  }
  return config;
}

export function loadConfig(configPath: string): DeployConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `no deploy config at ${configPath}. Copy deploy.config.example.json to deploy.config.json and point it at your hosts.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath}: invalid JSON (${(err as Error).message})`);
  }
  return validateConfig(raw, configPath);
}

/**
 * Builds every selected target before syncing any of them, so a failing
 * server build never leaves a fresh frontend talking to a stale server.
 */
export function planDeploy(
  config: DeployConfig,
  requested: TargetName[],
  opts: PlanOptions
): { steps: Step[]; skipped: TargetName[] } {
  const configDir = path.dirname(opts.configPath);
  const selected = requested.filter(name => config[name]);
  const skipped = requested.filter(name => !config[name]);
  if (selected.length === 0) {
    throw new Error(
      `nothing to deploy: ${requested.join(', ')} not configured in ${opts.configPath}`
    );
  }

  const resolved = selected.map(name => {
    const targetConfig = config[name]!;
    try {
      return { name, targetConfig, dest: parseDest(targetConfig.dest, configDir) };
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
  });

  const steps: Step[] = [];
  if (opts.build) {
    for (const { name } of resolved) {
      steps.push({
        target: name,
        phase: 'build',
        argv: ['npm', 'run', TARGETS[name].buildScript],
      });
    }
  }

  for (const { name, targetConfig, dest } of resolved) {
    const spec = TARGETS[name];
    const sourceDir = path.join(opts.repoRoot, spec.distDir);
    steps.push({
      target: name,
      phase: 'sync',
      argv: [
        'rsync',
        '-rc',
        '--delete',
        ...(opts.dryRun ? ['--dry-run', '--itemize-changes'] : []),
        // User excludes first, so excluding .env.example beats the protect list's include.
        ...(targetConfig.exclude ?? []).map(pattern => `--exclude=${pattern}`),
        ...spec.protect.map(rule => `--filter=${rule}`),
        ...(targetConfig.rsyncArgs ?? []),
        `${sourceDir}/`,
        dest.host ? `${dest.host}:${dest.path}` : dest.path,
      ],
      requires: path.join(sourceDir, spec.sanityFile),
    });

    if (targetConfig.postDeploy) {
      steps.push(
        dest.host
          ? {
              target: name,
              phase: 'postDeploy',
              // Remote login shell, so whatever puts node/npm on PATH at login (nvm, profile) applies.
              argv: [
                'ssh',
                dest.host,
                `exec "$SHELL" -lc ${shellQuote(`cd ${shellQuote(dest.path)} && ${targetConfig.postDeploy}`)}`,
              ],
              printOnly: opts.dryRun,
            }
          : {
              target: name,
              phase: 'postDeploy',
              argv: ['sh', '-c', targetConfig.postDeploy],
              cwd: dest.path,
              printOnly: opts.dryRun,
            }
      );
    }
  }

  return { steps, skipped };
}

const USAGE = `usage: node scripts/deploy.ts <target...> [--dry-run] [--no-build] [--config <path>]
targets: ${TARGET_NAMES.join(', ')}`;

export function main(argv: string[]): number {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'no-build': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    if (positionals.length === 0) {
      throw new Error(`no target given\n${USAGE}`);
    }
    for (const name of positionals) {
      if (!isTargetName(name)) {
        throw new Error(`unknown target "${name}"\n${USAGE}`);
      }
    }
    const requested = [...new Set(positionals as TargetName[])];
    const configPath = values.config
      ? path.resolve(values.config)
      : path.join(repoRoot, 'deploy.config.json');

    const { steps, skipped } = planDeploy(loadConfig(configPath), requested, {
      repoRoot,
      configPath,
      build: !values['no-build'],
      dryRun: values['dry-run'],
    });
    for (const name of skipped) {
      console.log(`[${name}] skipped: not in ${configPath}`);
    }

    for (const step of steps) {
      const shown = step.argv.map(shellQuote).join(' ');
      const where = step.cwd ? ` (in ${step.cwd})` : '';
      if (step.printOnly) {
        console.log(`[${step.target}] ${step.phase}, dry run, would run${where}: ${shown}`);
        continue;
      }
      if (step.requires && !existsSync(step.requires)) {
        throw new Error(
          `${step.requires} is missing. Build first (or drop --no-build); refusing to rsync --delete from an empty source.`
        );
      }
      console.log(`[${step.target}] ${step.phase}${where}: ${shown}`);
      const run = spawnSync(step.argv[0], step.argv.slice(1), {
        stdio: 'inherit',
        cwd: step.cwd ?? repoRoot,
      });
      if (run.error) {
        throw new Error(`[${step.target}] could not start ${step.argv[0]}: ${run.error.message}`);
      }
      if (run.status !== 0) {
        console.error(
          `deploy: [${step.target}] ${step.phase} failed (exit ${run.status ?? run.signal})`
        );
        return run.status ?? 1;
      }
    }
    return 0;
  } catch (err) {
    console.error(`deploy: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
