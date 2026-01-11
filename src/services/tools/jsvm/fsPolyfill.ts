/**
 * FS Polyfill for QuickJS
 *
 * Provides Node.js-like async filesystem operations that integrate with
 * the QuickJS event loop. Uses the VFS service for persistence.
 *
 * Key features:
 * - Async methods return promises resolved during event loop processing
 * - Readonly paths enforcement (/memories is readonly)
 * - Directory creation via .newdir marker file
 * - Aliased to globalThis.fs and globalThis.__fs
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import * as vfs from '../../vfs/vfsService';
import { VfsError, VfsErrorCode, normalizePath } from '../../vfs/vfsService';

/** Readonly paths - any write/delete to these paths throws EROFS */
const READONLY_PATHS = ['/memories'];

/** Marker file for directories created via fs.mkdir */
const DIR_MARKER = '.newdir';

/** Pending fs operation to be resolved during event loop */
export interface PendingFsOp {
  execute: () => Promise<unknown>;
  resolve: (value: QuickJSHandle) => void;
  reject: (error: QuickJSHandle) => void;
}

/**
 * Check if a path is readonly
 */
function isReadonly(path: string): boolean {
  const normalized = normalizePath(path);
  return READONLY_PATHS.some(
    roPath => normalized === roPath || normalized.startsWith(roPath + '/')
  );
}

/**
 * Convert VfsError to Node.js style errno
 */
function vfsErrorToErrno(error: VfsError, path: string): string {
  switch (error.code) {
    case VfsErrorCode.PATH_NOT_FOUND:
    case VfsErrorCode.IS_DELETED:
      return `ENOENT: no such file or directory, '${path}'`;
    case VfsErrorCode.FILE_EXISTS:
    case VfsErrorCode.DIR_EXISTS:
    case VfsErrorCode.DESTINATION_EXISTS:
      return `EEXIST: file already exists, '${path}'`;
    case VfsErrorCode.NOT_A_FILE:
      return `EISDIR: illegal operation on a directory, '${path}'`;
    case VfsErrorCode.NOT_A_DIRECTORY:
      return `ENOTDIR: not a directory, '${path}'`;
    case VfsErrorCode.DIR_NOT_EMPTY:
      return `ENOTEMPTY: directory not empty, '${path}'`;
    case VfsErrorCode.INVALID_PATH:
    case VfsErrorCode.INVALID_LINE:
      return `EINVAL: invalid argument, '${path}'`;
    case VfsErrorCode.STRING_NOT_FOUND:
    case VfsErrorCode.STRING_NOT_UNIQUE:
      // These are for str_replace, not used in fs operations
      return `EIO: ${error.message}`;
  }
}

/**
 * FS Bridge for QuickJS
 *
 * Manages pending async operations and provides fs methods to the context.
 */
export class FsBridge {
  private projectId: string;
  private context: QuickJSContext;
  private pendingOps: PendingFsOp[] = [];

  constructor(projectId: string, context: QuickJSContext) {
    this.projectId = projectId;
    this.context = context;
  }

  /**
   * Get pending operations to be processed during event loop
   */
  getPendingOps(): PendingFsOp[] {
    const ops = this.pendingOps;
    this.pendingOps = [];
    return ops;
  }

  /**
   * Check if there are pending fs operations
   */
  hasPendingOps(): boolean {
    return this.pendingOps.length > 0;
  }

  /**
   * Queue an async operation and return a promise handle
   */
  private queueOp(execute: () => Promise<unknown>): QuickJSHandle {
    const deferred = this.context.newPromise();
    this.pendingOps.push({
      execute,
      resolve: (value: QuickJSHandle) => {
        deferred.resolve(value);
        value.dispose();
      },
      reject: (error: QuickJSHandle) => {
        deferred.reject(error);
        error.dispose();
      },
    });
    return deferred.handle;
  }

  /**
   * Create an error handle with Node.js errno style
   */
  private createError(message: string): QuickJSHandle {
    return this.context.newError(message);
  }

  /**
   * Inject fs object into context as globalThis.fs and globalThis.__fs
   */
  injectFs(): void {
    const fsObj = this.context.newObject();

    // fs.readFile(path) -> Promise<string>
    const readFileFn = this.context.newFunction('readFile', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        try {
          const content = await vfs.readFile(this.projectId, path);
          return { ok: true, value: content };
        } catch (error) {
          if (error instanceof VfsError) {
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'readFile', readFileFn);
    readFileFn.dispose();

    // fs.writeFile(path, data) -> Promise<void>
    const writeFileFn = this.context.newFunction(
      'writeFile',
      (pathHandle: QuickJSHandle, dataHandle: QuickJSHandle) => {
        const path = this.context.getString(pathHandle);
        const data = this.context.getString(dataHandle);
        return this.queueOp(async () => {
          // Check readonly
          if (isReadonly(path)) {
            return { ok: false, error: `EROFS: read-only file system, write '${path}'` };
          }
          try {
            const fileExists = await vfs.isFile(this.projectId, path);
            if (fileExists) {
              await vfs.updateFile(this.projectId, path, data);
            } else {
              await vfs.createFile(this.projectId, path, data);
            }
            return { ok: true, value: undefined };
          } catch (error) {
            if (error instanceof VfsError) {
              return { ok: false, error: vfsErrorToErrno(error, path) };
            }
            throw error;
          }
        });
      }
    );
    this.context.setProp(fsObj, 'writeFile', writeFileFn);
    writeFileFn.dispose();

    // fs.exists(path) -> Promise<boolean>
    const existsFn = this.context.newFunction('exists', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        const exists = await vfs.exists(this.projectId, path);
        return { ok: true, value: exists };
      });
    });
    this.context.setProp(fsObj, 'exists', existsFn);
    existsFn.dispose();

    // fs.mkdir(path) -> Promise<void>
    // Creates a directory by creating a .newdir marker file inside it
    const mkdirFn = this.context.newFunction('mkdir', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        // Check readonly
        if (isReadonly(path)) {
          return { ok: false, error: `EROFS: read-only file system, mkdir '${path}'` };
        }
        try {
          const normalized = normalizePath(path);
          const markerPath = `${normalized}/${DIR_MARKER}`;

          // Create the marker file (vfs.createFile will create parent dirs)
          await vfs.createFile(this.projectId, markerPath, '');
          return { ok: true, value: undefined };
        } catch (error) {
          if (error instanceof VfsError) {
            // FILE_EXISTS on marker means dir exists
            if (error.code === VfsErrorCode.FILE_EXISTS) {
              return { ok: false, error: `EEXIST: file already exists, '${path}'` };
            }
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'mkdir', mkdirFn);
    mkdirFn.dispose();

    // fs.readdir(path) -> Promise<string[]>
    const readdirFn = this.context.newFunction('readdir', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        try {
          const entries = await vfs.readDir(this.projectId, path);
          // Filter out .newdir marker files
          const names = entries.filter(e => e.name !== DIR_MARKER).map(e => e.name);
          return { ok: true, value: names };
        } catch (error) {
          if (error instanceof VfsError) {
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'readdir', readdirFn);
    readdirFn.dispose();

    // fs.unlink(path) -> Promise<void>
    const unlinkFn = this.context.newFunction('unlink', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        // Check readonly
        if (isReadonly(path)) {
          return { ok: false, error: `EROFS: read-only file system, unlink '${path}'` };
        }
        try {
          await vfs.deleteFile(this.projectId, path);
          return { ok: true, value: undefined };
        } catch (error) {
          if (error instanceof VfsError) {
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'unlink', unlinkFn);
    unlinkFn.dispose();

    // fs.rmdir(path) -> Promise<void> (recursive)
    const rmdirFn = this.context.newFunction('rmdir', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        // Check readonly
        if (isReadonly(path)) {
          return { ok: false, error: `EROFS: read-only file system, rmdir '${path}'` };
        }
        try {
          await vfs.rmdir(this.projectId, path, true);
          return { ok: true, value: undefined };
        } catch (error) {
          if (error instanceof VfsError) {
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'rmdir', rmdirFn);
    rmdirFn.dispose();

    // fs.rename(oldPath, newPath) -> Promise<void>
    const renameFn = this.context.newFunction(
      'rename',
      (oldPathHandle: QuickJSHandle, newPathHandle: QuickJSHandle) => {
        const oldPath = this.context.getString(oldPathHandle);
        const newPath = this.context.getString(newPathHandle);
        return this.queueOp(async () => {
          // Check readonly for both source and destination
          if (isReadonly(oldPath)) {
            return { ok: false, error: `EROFS: read-only file system, rename '${oldPath}'` };
          }
          if (isReadonly(newPath)) {
            return { ok: false, error: `EROFS: read-only file system, rename '${newPath}'` };
          }
          try {
            await vfs.rename(this.projectId, oldPath, newPath);
            return { ok: true, value: undefined };
          } catch (error) {
            if (error instanceof VfsError) {
              return { ok: false, error: vfsErrorToErrno(error, oldPath) };
            }
            throw error;
          }
        });
      }
    );
    this.context.setProp(fsObj, 'rename', renameFn);
    renameFn.dispose();

    // fs.stat(path) -> Promise<{isFile, isDirectory, size, readonly, mtime}>
    const statFn = this.context.newFunction('stat', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        try {
          const st = await vfs.stat(this.projectId, path);
          return {
            ok: true,
            value: {
              isFile: st.isFile,
              isDirectory: st.isDirectory,
              size: st.size,
              readonly: isReadonly(path),
              mtime: st.updatedAt,
            },
          };
        } catch (error) {
          if (error instanceof VfsError) {
            return { ok: false, error: vfsErrorToErrno(error, path) };
          }
          throw error;
        }
      });
    });
    this.context.setProp(fsObj, 'stat', statFn);
    statFn.dispose();

    // Set globalThis.fs and globalThis.__fs
    this.context.setProp(this.context.global, 'fs', fsObj);
    this.context.setProp(this.context.global, '__fs', fsObj);
    fsObj.dispose();
  }

  /**
   * Convert result object to QuickJS handle
   */
  resultToHandle(result: { ok: boolean; value?: unknown; error?: string }): {
    handle: QuickJSHandle;
    isError: boolean;
  } {
    if (result.ok) {
      return { handle: this.valueToHandle(result.value), isError: false };
    } else {
      return { handle: this.createError(result.error!), isError: true };
    }
  }

  /**
   * Convert a JS value to QuickJS handle
   */
  private valueToHandle(value: unknown): QuickJSHandle {
    if (value === undefined) {
      return this.context.undefined;
    }
    if (value === null) {
      return this.context.null;
    }
    if (typeof value === 'boolean') {
      return value ? this.context.true : this.context.false;
    }
    if (typeof value === 'number') {
      return this.context.newNumber(value);
    }
    if (typeof value === 'string') {
      return this.context.newString(value);
    }
    if (Array.isArray(value)) {
      const arr = this.context.newArray();
      for (let i = 0; i < value.length; i++) {
        const elemHandle = this.valueToHandle(value[i]);
        this.context.setProp(arr, i, elemHandle);
        elemHandle.dispose();
      }
      return arr;
    }
    if (typeof value === 'object') {
      const obj = this.context.newObject();
      for (const [k, v] of Object.entries(value)) {
        const propHandle = this.valueToHandle(v);
        this.context.setProp(obj, k, propHandle);
        propHandle.dispose();
      }
      return obj;
    }
    return this.context.undefined;
  }
}
