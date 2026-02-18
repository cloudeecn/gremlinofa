/**
 * FS Polyfill for QuickJS
 *
 * Provides Node.js-like async filesystem operations that integrate with
 * the QuickJS event loop. Uses the VFS service for persistence.
 *
 * Key features:
 * - Async methods return promises resolved during event loop processing
 * - Readonly paths enforcement (/memories is readonly)
 * - Aliased to globalThis.fs and globalThis.__fs
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import * as vfs from '../../vfs/vfsService';
import { VfsError, normalizePath } from '../../vfs/vfsService';

/** Readonly paths - any write/delete to these paths throws EROFS */
const READONLY_PATHS = ['/memories'];

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
    case 'PATH_NOT_FOUND':
    case 'IS_DELETED':
      return `ENOENT: no such file or directory, '${path}'`;
    case 'FILE_EXISTS':
    case 'DIR_EXISTS':
    case 'DESTINATION_EXISTS':
      return `EEXIST: file already exists, '${path}'`;
    case 'NOT_A_FILE':
      return `EISDIR: illegal operation on a directory, '${path}'`;
    case 'NOT_A_DIRECTORY':
      return `ENOTDIR: not a directory, '${path}'`;
    case 'DIR_NOT_EMPTY':
      return `ENOTEMPTY: directory not empty, '${path}'`;
    case 'INVALID_PATH':
    case 'INVALID_LINE':
      return `EINVAL: invalid argument, '${path}'`;
    case 'STRING_NOT_FOUND':
    case 'STRING_NOT_UNIQUE':
      // These are for str_replace, not used in fs operations
      return `EIO: ${error.message}`;
    case 'BINARY_FILE':
      return `EINVAL: binary file, '${path}'`;
    default:
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
  private namespace?: string;
  private pendingOps: PendingFsOp[] = [];

  constructor(projectId: string, context: QuickJSContext, namespace?: string) {
    this.projectId = projectId;
    this.context = context;
    this.namespace = namespace;
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

    // fs.readFile(path, encoding?) -> Promise<Buffer | string>
    // Without encoding: returns Buffer (ArrayBuffer for binary, or UTF-8 encoded for text)
    // With encoding: returns string (decodes binary as that encoding)
    const readFileFn = this.context.newFunction(
      'readFile',
      (pathHandle: QuickJSHandle, encodingHandle?: QuickJSHandle) => {
        const path = this.context.getString(pathHandle);
        const encoding = encodingHandle ? this.context.getString(encodingHandle) : undefined;
        return this.queueOp(async () => {
          try {
            const result = await vfs.readFileWithMeta(this.projectId, path, this.namespace);

            if (result.isBinary) {
              // Binary file
              if (encoding) {
                // With encoding, decode base64 and convert to string
                // Most common case: 'utf-8' or 'utf8'
                const buffer = result.buffer!;
                const decoder = new TextDecoder(encoding);
                return { ok: true, value: decoder.decode(buffer) };
              }
              // No encoding: return as ArrayBuffer (Node.js Buffer behavior)
              return { ok: true, value: result.buffer!, isArrayBuffer: true };
            } else {
              // Text file - content is already string
              if (encoding) {
                return { ok: true, value: result.content };
              }
              // No encoding: return as Buffer (encode string to ArrayBuffer)
              const encoder = new TextEncoder();
              return {
                ok: true,
                value: encoder.encode(result.content).buffer,
                isArrayBuffer: true,
              };
            }
          } catch (error) {
            if (error instanceof VfsError) {
              return { ok: false, error: vfsErrorToErrno(error, path) };
            }
            throw error;
          }
        });
      }
    );
    this.context.setProp(fsObj, 'readFile', readFileFn);
    readFileFn.dispose();

    // fs.writeFile(path, data) -> Promise<void>
    // data must be string or ArrayBuffer/TypedArray (strict Node.js behavior)
    const writeFileFn = this.context.newFunction(
      'writeFile',
      (pathHandle: QuickJSHandle, dataHandle: QuickJSHandle) => {
        const path = this.context.getString(pathHandle);

        // Strict Node.js behavior: only accept string or ArrayBuffer/TypedArray
        let data: string | ArrayBuffer;

        // 1. Try ArrayBuffer directly
        let gotBuffer = false;
        try {
          const uint8 = this.context.getArrayBuffer(dataHandle).value;
          const buffer = new ArrayBuffer(uint8.byteLength);
          new Uint8Array(buffer).set(uint8);
          data = buffer;
          gotBuffer = true;
        } catch {
          // Not an ArrayBuffer, continue checking
        }

        if (!gotBuffer) {
          // 2. Check for TypedArray's .buffer property (Uint8Array, Int8Array, etc.)
          const bufferHandle = this.context.getProp(dataHandle, 'buffer');
          const bufferType = this.context.typeof(bufferHandle);

          if (bufferType === 'object') {
            try {
              const uint8 = this.context.getArrayBuffer(bufferHandle).value;
              const buffer = new ArrayBuffer(uint8.byteLength);
              new Uint8Array(buffer).set(uint8);
              data = buffer;
              gotBuffer = true;
            } catch {
              // .buffer exists but isn't an ArrayBuffer
            }
          }
          bufferHandle.dispose();
        }

        if (!gotBuffer) {
          // 3. Check if it's a string
          const dataType = this.context.typeof(dataHandle);
          if (dataType === 'string') {
            data = this.context.getString(dataHandle);
          } else {
            // 4. Invalid type - return error (no silent stringify)
            return this.queueOp(async () => ({
              ok: false,
              error: `EINVAL: invalid argument, data must be string or buffer, '${path}'`,
            }));
          }
        }

        return this.queueOp(async () => {
          // Check readonly
          if (isReadonly(path)) {
            return { ok: false, error: `EROFS: read-only file system, write '${path}'` };
          }
          try {
            // Use vfs.writeFile which handles both string and ArrayBuffer
            await vfs.writeFile(this.projectId, path, data, this.namespace);
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
        const exists = await vfs.exists(this.projectId, path, this.namespace);
        return { ok: true, value: exists };
      });
    });
    this.context.setProp(fsObj, 'exists', existsFn);
    existsFn.dispose();

    // fs.mkdir(path) -> Promise<void>
    const mkdirFn = this.context.newFunction('mkdir', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        // Check readonly
        if (isReadonly(path)) {
          return { ok: false, error: `EROFS: read-only file system, mkdir '${path}'` };
        }
        try {
          await vfs.mkdir(this.projectId, path, this.namespace);
          return { ok: true, value: undefined };
        } catch (error) {
          if (error instanceof VfsError) {
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
          const entries = await vfs.readDir(this.projectId, path, false, this.namespace);
          const names = entries.map(e => e.name);
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
          await vfs.deleteFile(this.projectId, path, this.namespace);
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
          await vfs.rmdir(this.projectId, path, true, this.namespace);
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
            await vfs.rename(this.projectId, oldPath, newPath, this.namespace);
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

    // fs.stat(path) -> Promise<{isFile, isDirectory, size, readonly, mtime, isBinary, mime}>
    const statFn = this.context.newFunction('stat', (pathHandle: QuickJSHandle) => {
      const path = this.context.getString(pathHandle);
      return this.queueOp(async () => {
        try {
          const st = await vfs.stat(this.projectId, path, this.namespace);
          return {
            ok: true,
            value: {
              isFile: st.isFile,
              isDirectory: st.isDirectory,
              size: st.size,
              readonly: isReadonly(path),
              mtime: st.updatedAt,
              isBinary: st.isBinary,
              mime: st.mime,
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
   * Handles isArrayBuffer flag for binary data returns
   */
  resultToHandle(result: {
    ok: boolean;
    value?: unknown;
    error?: string;
    isArrayBuffer?: boolean;
  }): {
    handle: QuickJSHandle;
    isError: boolean;
  } {
    if (result.ok) {
      if (result.isArrayBuffer && result.value instanceof ArrayBuffer) {
        // Return as ArrayBuffer for Node.js Buffer-like behavior
        return { handle: this.context.newArrayBuffer(result.value), isError: false };
      }
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
    // Handle ArrayBuffer
    if (value instanceof ArrayBuffer) {
      return this.context.newArrayBuffer(value);
    }
    // Handle TypedArrays (Uint8Array, etc.)
    if (ArrayBuffer.isView(value)) {
      // Copy the relevant portion to a new ArrayBuffer
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const buffer = new ArrayBuffer(bytes.length);
      new Uint8Array(buffer).set(bytes);
      return this.context.newArrayBuffer(buffer);
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
