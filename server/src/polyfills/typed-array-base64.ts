// Polyfill for TC39 Stage-3 Uint8Array base64/hex methods.
//
// `Uint8Array.fromBase64`, `Uint8Array.prototype.toBase64`, and
// `Uint8Array.prototype.toHex` are Stage-3 proposals available in modern
// browsers (Safari 17+, Chrome 117+) but not yet shipped by default in any
// Node.js release (V8 has them behind `--js-base-64`; Node has not enabled
// this flag by default through Node 24).
//
// The vendored `@proton/srp` code targets browsers and uses these methods.
// This polyfill backs them with `Buffer` so the same source runs in Node.
// Import this file as the FIRST line of the application entry point, before
// any module that may load vendor code.

import { Buffer } from 'node:buffer';

interface FromBase64Options {
    alphabet?: 'base64' | 'base64url';
    lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial';
}

interface ToBase64Options {
    alphabet?: 'base64' | 'base64url';
    omitPadding?: boolean;
}

const bufferEncoding = (alphabet: 'base64' | 'base64url' | undefined): BufferEncoding =>
    alphabet === 'base64url' ? 'base64url' : 'base64';

if (!('fromBase64' in Uint8Array)) {
    Object.defineProperty(Uint8Array, 'fromBase64', {
        value(input: string, options?: FromBase64Options): Uint8Array {
            const buf = Buffer.from(input, bufferEncoding(options?.alphabet));
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
        writable: true,
        configurable: true,
    });
}

if (!('fromHex' in Uint8Array)) {
    Object.defineProperty(Uint8Array, 'fromHex', {
        value(input: string): Uint8Array {
            const buf = Buffer.from(input, 'hex');
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
        writable: true,
        configurable: true,
    });
}

if (!('toBase64' in Uint8Array.prototype)) {
    Object.defineProperty(Uint8Array.prototype, 'toBase64', {
        value(this: Uint8Array, options?: ToBase64Options): string {
            const enc = bufferEncoding(options?.alphabet);
            return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString(enc);
        },
        writable: true,
        configurable: true,
    });
}

if (!('toHex' in Uint8Array.prototype)) {
    Object.defineProperty(Uint8Array.prototype, 'toHex', {
        value(this: Uint8Array): string {
            return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('hex');
        },
        writable: true,
        configurable: true,
    });
}
