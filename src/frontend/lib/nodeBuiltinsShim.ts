/**
 * Browser/worker shim for Node.js built-in modules (`node:fs`, `node:fs/promises`,
 * `node:path`, `node:os`, `node:crypto`).
 *
 * Some third-party SDKs we bundle for the client — `@anthropic-ai/sdk`'s agent
 * file-tools (`BetaToolRunner` → `agent-toolset/fs-util`) and the `@aws-sdk`
 * credential providers pulled in by `@anthropic-ai/bedrock-sdk` — statically
 * import these Node built-ins. We only ever call those SDKs' HTTP message APIs,
 * never their filesystem/credential code, so those imports are dead weight in
 * the browser. Vite aliases every `node:` builtin to this module so the bundle
 * resolves: the pure-JS `path` helpers work for real (modules may call them at
 * import time), while `fs`/`os`/`crypto` operations throw a clear error if ever
 * actually invoked. `crypto.randomUUID` delegates to Web Crypto since it's free.
 *
 * This file is never imported by our own source — it exists solely as the alias
 * target configured in `vite.config.ts`. The Node server build (esbuild) keeps
 * the real built-ins.
 */

const unavailable =
  (api: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`[nodeBuiltinsShim] "${api}" is not available in the browser build`);
  };

// --- node:path (pure string math — implement for real) ----------------------

export const sep = '/';
export const delimiter = ':';

export function isAbsolute(p: string): boolean {
  return p.charCodeAt(0) === 47; // '/'
}

function normalizeSegments(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
    } else {
      out.push(part);
    }
  }
  return out;
}

export function normalize(p: string): string {
  if (!p) return '.';
  const absolute = isAbsolute(p);
  const trailingSlash = p.length > 1 && p.charCodeAt(p.length - 1) === 47;
  let joined = normalizeSegments(p.split('/'), !absolute).join('/');
  if (!joined && !absolute) joined = '.';
  if (joined && trailingSlash) joined += '/';
  return (absolute ? '/' : '') + joined;
}

export function join(...parts: string[]): string {
  const joined = parts.filter(part => part && part.length).join('/');
  return joined ? normalize(joined) : '.';
}

export function resolve(...parts: string[]): string {
  let resolved = '';
  let absolute = false;
  for (let i = parts.length - 1; i >= -1 && !absolute; i--) {
    const segment = i >= 0 ? parts[i] : '/'; // cwd is root in the browser
    if (!segment) continue;
    resolved = `${segment}/${resolved}`;
    absolute = isAbsolute(segment);
  }
  const normalized = normalizeSegments(resolved.split('/'), !absolute).join('/');
  return (absolute ? '/' : '') + normalized || '/';
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

export function basename(p: string, ext?: string): string {
  const trimmed = p.replace(/\/+$/, '');
  let base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
}

export function parse(p: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  const base = basename(p);
  const ext = extname(base);
  return {
    root: isAbsolute(p) ? '/' : '',
    dir: dirname(p),
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  )
    common++;
  const up = fromParts.slice(common).map(() => '..');
  return [...up, ...toParts.slice(common)].join('/') || '.';
}

// --- node:crypto ------------------------------------------------------------

export function randomUUID(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  throw new Error('[nodeBuiltinsShim] crypto.randomUUID is unavailable in this environment');
}
export const createHash = unavailable('crypto.createHash');
export const createPrivateKey = unavailable('crypto.createPrivateKey');
export const createPublicKey = unavailable('crypto.createPublicKey');
export const sign = unavailable('crypto.sign');

// --- node:fs / node:fs/promises ---------------------------------------------

export const promises = new Proxy(
  {},
  { get: (_target, prop) => unavailable(`fs.promises.${String(prop)}`) }
);
export const realpath = unavailable('fs.realpath');
export const lstat = unavailable('fs.lstat');
export const stat = unavailable('fs.stat');
export const readlink = unavailable('fs.readlink');
export const readFile = unavailable('fs.readFile');
export const writeFile = unavailable('fs.writeFile');
export const mkdir = unavailable('fs.mkdir');
export const access = unavailable('fs.access');
export const glob = unavailable('fs.glob');
export const open = unavailable('fs.open');
export const readdir = unavailable('fs.readdir');
export const rm = unavailable('fs.rm');
export const rename = unavailable('fs.rename');
export const unlink = unavailable('fs.unlink');
export const createReadStream = unavailable('fs.createReadStream');
export const createWriteStream = unavailable('fs.createWriteStream');
// File access / open flags some modules read at import time — plain values so
// they don't throw on access (the I/O that would use them is never reached).
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  COPYFILE_EXCL: 1,
};

// --- node:readline ----------------------------------------------------------

export const createInterface = unavailable('readline.createInterface');

// --- node:os ----------------------------------------------------------------

export const homedir = unavailable('os.homedir');
export const tmpdir = unavailable('os.tmpdir');

// --- node:util / node:child_process / node:stream ---------------------------

// `promisify` is often called at import time (`const x = promisify(execFile)`),
// so it must return a function rather than throw — the returned function throws
// only if actually invoked.
export const promisify =
  (_fn: unknown) =>
  (..._args: unknown[]): Promise<never> =>
    Promise.reject(
      new Error('[nodeBuiltinsShim] promisified Node API is unavailable in the browser')
    );
export const execFile = unavailable('child_process.execFile');
export const exec = unavailable('child_process.exec');
export const spawn = unavailable('child_process.spawn');
export class Readable {
  constructor() {
    throw new Error('[nodeBuiltinsShim] stream.Readable is not available in the browser build');
  }
}
export const pipeline = (..._args: unknown[]): Promise<never> =>
  Promise.reject(
    new Error('[nodeBuiltinsShim] stream.pipeline is not available in the browser build')
  );

// Default export for `import fs from 'node:fs'` / `import path from 'node:path'`
// style consumers — carries every named member above.
export default {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  parse,
  relative,
  randomUUID,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  promises,
  realpath,
  lstat,
  stat,
  readlink,
  readFile,
  writeFile,
  mkdir,
  access,
  glob,
  open,
  readdir,
  rm,
  rename,
  unlink,
  createReadStream,
  createWriteStream,
  constants,
  createInterface,
  homedir,
  tmpdir,
  promisify,
  execFile,
  exec,
  spawn,
  Readable,
  pipeline,
};
