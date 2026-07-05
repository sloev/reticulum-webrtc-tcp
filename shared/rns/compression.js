// bz2 compression/decompression, matching real RNS's use of Python's `bz2`
// module for Resource and Buffer/Channel stream chunks (see protocol.js's
// "RNS.Resource" and "RNS.Buffer" sections).
//
// Decoding a real peer's compressed payload uses the pure-JS `seek-bzip`
// package (no native bindings, so it works in the browser build too — see
// vite.config.js/browser/main.js for the global `Buffer` shim it needs).
//
// Encoding uses `bzip2-wasm`, a WebAssembly build of the actual reference
// `libbzip2` C library (the same one Python's own `bz2` module wraps) —
// deliberately not a from-scratch JS reimplementation, so its output is
// guaranteed to decode correctly anywhere a real bz2 decoder is used
// (confirmed directly against Python's `bz2.decompress()`). Also
// deliberately not `compressjs` (the obvious pure-JS alternative, from the
// same author as seek-bzip): it's GPL-licensed, which would attach copyleft
// obligations to this project's MIT-licensed browser bundle once linked in.
// `libbzip2` itself carries a permissive BSD-style license, same as this
// project's other native-code-derived dependencies.
import bzip2 from 'seek-bzip';
import BZip2 from 'bzip2-wasm';

// Mirrors RNS.Resource.AUTO_COMPRESS_MAX_SIZE (64MiB): a real receiver caps
// how much a compressed blob is allowed to decompress to, as a basic
// decompression-bomb guard. Thrown as an Error if exceeded, matching real
// RNS logging the resource as failed rather than silently truncating it.
// Also used as the ceiling below which sending ever attempts to compress in
// the first place (matching RNS.Resource.AUTO_COMPRESS_MAX_SIZE's dual use).
export const MAX_DECOMPRESSED_SIZE = 64 * 1024 * 1024;

export function bz2_decompress(data, max_length = MAX_DECOMPRESSED_SIZE) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoded = bzip2.decode(input);
    if (decoded.length > max_length) {
        throw new Error(`Decompressed data exceeds maximum allowed size of ${max_length} bytes`);
    }
    return new Uint8Array(decoded);
}

// bzip2-wasm's WASM module is instantiated lazily (it's an async fetch/
// compile step) and shared across every call — there's exactly one
// (de)compressor for the whole process/page, matching how there's exactly
// one Python `bz2` module import.
let bzip2InstancePromise = null;
function getBzip2Instance() {
    if (!bzip2InstancePromise) {
        const instance = new BZip2();
        bzip2InstancePromise = instance.init().then(() => instance);
    }
    return bzip2InstancePromise;
}

export async function bz2_compress(data) {
    const instance = await getBzip2Instance();
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    // libbzip2's own documented worst-case output bound for
    // BZ2_bzBuffToBuffCompress (bzlib.h): input size plus 1% plus a 600-byte
    // safety margin. bzip2-wasm's default guess (input.length) isn't big
    // enough for incompressible data, which throws BZ_OUTBUFF_FULL — this
    // is *not* a decompression-bomb-style guard, just sizing the output
    // buffer correctly. Block size 9 (900k, the largest) matches Python
    // bz2.compress()'s own default, which is what real RNS calls.
    const worstCaseSize = input.length + Math.ceil(input.length / 100) + 600;
    return instance.compress(input, 9, worstCaseSize);
}

// Matches RNS.Resource's actual compression policy exactly (Resource.py's
// __init__): always attempt compression (unless the input is already bigger
// than MAX_DECOMPRESSED_SIZE, in which case don't bother), and only actually
// use the compressed bytes if they're smaller than the original — otherwise
// send the original uncompressed. Returns `{ data, compressed }` where
// `data` is whichever of the two should actually be sent.
export async function bz2_compress_if_beneficial(data, max_length = MAX_DECOMPRESSED_SIZE) {
    if (data.length > max_length) return { data, compressed: false };
    const compressed = await bz2_compress(data);
    if (compressed.length < data.length) return { data: compressed, compressed: true };
    return { data, compressed: false };
}
