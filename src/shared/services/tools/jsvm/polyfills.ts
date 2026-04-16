/**
 * Polyfills for QuickJS browser compatibility
 *
 * Injects common browser/Node.js globals that libraries expect.
 * QuickJS-ng has ES2023 core but lacks Web APIs.
 */

import type { QuickJSContext } from 'quickjs-emscripten-core';

/**
 * Inject all polyfills into a QuickJS context.
 */
export function injectPolyfills(context: QuickJSContext): void {
  injectSelfGlobal(context);
  injectTextEncoderDecoder(context);
  injectBase64(context);
}

/**
 * Set `self` to point to globalThis.
 * UMD/IIFE libraries use `self` as a browser environment indicator.
 */
function injectSelfGlobal(context: QuickJSContext): void {
  context.setProp(context.global, 'self', context.global);
}

/**
 * TextEncoder/TextDecoder polyfill for UTF-8 string ↔ bytes conversion.
 *
 * Many libraries use these for binary data handling.
 */
function injectTextEncoderDecoder(context: QuickJSContext): void {
  // TextEncoder - string to UTF-8 bytes
  const textEncoderCode = `
(function() {
  globalThis.TextEncoder = class TextEncoder {
    constructor() {
      this.encoding = 'utf-8';
    }
    encode(str) {
      if (typeof str !== 'string') str = String(str);
      const utf8 = [];
      for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        if (charCode < 0x80) {
          utf8.push(charCode);
        } else if (charCode < 0x800) {
          utf8.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
        } else if (charCode >= 0xd800 && charCode <= 0xdbff) {
          // Surrogate pair
          i++;
          const low = str.charCodeAt(i);
          const codePoint = 0x10000 + ((charCode - 0xd800) << 10) + (low - 0xdc00);
          utf8.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f)
          );
        } else {
          utf8.push(
            0xe0 | (charCode >> 12),
            0x80 | ((charCode >> 6) & 0x3f),
            0x80 | (charCode & 0x3f)
          );
        }
      }
      return new Uint8Array(utf8);
    }
  };
})();
`;

  // TextDecoder - UTF-8 bytes to string
  const textDecoderCode = `
(function() {
  globalThis.TextDecoder = class TextDecoder {
    constructor(encoding = 'utf-8') {
      this.encoding = encoding.toLowerCase();
      if (this.encoding !== 'utf-8' && this.encoding !== 'utf8') {
        throw new RangeError('Only UTF-8 encoding is supported');
      }
    }
    decode(input) {
      if (!input) return '';
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let result = '';
      let i = 0;
      while (i < bytes.length) {
        const byte = bytes[i];
        if (byte < 0x80) {
          result += String.fromCharCode(byte);
          i++;
        } else if ((byte & 0xe0) === 0xc0) {
          result += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
          i += 2;
        } else if ((byte & 0xf0) === 0xe0) {
          result += String.fromCharCode(
            ((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
          );
          i += 3;
        } else if ((byte & 0xf8) === 0xf0) {
          const codePoint =
            ((byte & 0x07) << 18) |
            ((bytes[i + 1] & 0x3f) << 12) |
            ((bytes[i + 2] & 0x3f) << 6) |
            (bytes[i + 3] & 0x3f);
          // Convert to surrogate pair
          const adjusted = codePoint - 0x10000;
          result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
          i += 4;
        } else {
          // Invalid UTF-8, skip byte
          i++;
        }
      }
      return result;
    }
  };
})();
`;

  const encResult = context.evalCode(textEncoderCode);
  if (encResult.error) {
    console.error('Failed to inject TextEncoder polyfill');
    encResult.error.dispose();
  } else {
    encResult.value.dispose();
  }

  const decResult = context.evalCode(textDecoderCode);
  if (decResult.error) {
    console.error('Failed to inject TextDecoder polyfill');
    decResult.error.dispose();
  } else {
    decResult.value.dispose();
  }
}

/**
 * atob/btoa polyfill for Base64 encoding/decoding.
 */
function injectBase64(context: QuickJSContext): void {
  const base64Code = `
(function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  globalThis.btoa = function btoa(str) {
    if (typeof str !== 'string') str = String(str);
    let output = '';
    for (let i = 0; i < str.length; i += 3) {
      const a = str.charCodeAt(i);
      const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
      
      if (a > 255 || b > 255 || c > 255) {
        throw new DOMException('Invalid character', 'InvalidCharacterError');
      }
      
      const bitmap = (a << 16) | (b << 8) | c;
      output += chars.charAt((bitmap >> 18) & 63);
      output += chars.charAt((bitmap >> 12) & 63);
      output += i + 1 < str.length ? chars.charAt((bitmap >> 6) & 63) : '=';
      output += i + 2 < str.length ? chars.charAt(bitmap & 63) : '=';
    }
    return output;
  };

  globalThis.atob = function atob(str) {
    if (typeof str !== 'string') str = String(str);
    str = str.replace(/=+$/, '');
    if (str.length % 4 === 1) {
      throw new DOMException('Invalid base64 string', 'InvalidCharacterError');
    }
    let output = '';
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
      const idx = chars.indexOf(str[i]);
      if (idx === -1) {
        throw new DOMException('Invalid character', 'InvalidCharacterError');
      }
      buffer = (buffer << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output += String.fromCharCode((buffer >> bits) & 0xff);
      }
    }
    return output;
  };
})();
`;

  const result = context.evalCode(base64Code);
  if (result.error) {
    console.error('Failed to inject Base64 polyfill');
    result.error.dispose();
  } else {
    result.value.dispose();
  }
}
