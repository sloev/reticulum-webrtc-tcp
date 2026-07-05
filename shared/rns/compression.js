// bz2 decompression, matching real RNS's use of Python's `bz2` module for
// Resource and Buffer/Channel stream chunks (see protocol.js's "RNS.Resource"
// and "RNS.Buffer" sections). Decode-only: this project's own sender never
// compresses outgoing data (there's no reason to — WebRTC/TCP are already
// reliable, ordered transports, unlike the slow radio links RNS targets),
// so only decoding a real peer's bz2-compressed payload is implemented, via
// the pure-JS `seek-bzip` package (no native bindings, so it works in the
// browser build too — see vite.config.js/browser/main.js for the global
// `Buffer` shim it needs).
import bzip2 from 'seek-bzip';

// Mirrors RNS.Resource.AUTO_COMPRESS_MAX_SIZE (64MiB): a real receiver caps
// how much a compressed blob is allowed to decompress to, as a basic
// decompression-bomb guard. Thrown as an Error if exceeded, matching real
// RNS logging the resource as failed rather than silently truncating it.
export const MAX_DECOMPRESSED_SIZE = 64 * 1024 * 1024;

export function bz2_decompress(data, max_length = MAX_DECOMPRESSED_SIZE) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoded = bzip2.decode(input);
    if (decoded.length > max_length) {
        throw new Error(`Decompressed data exceeds maximum allowed size of ${max_length} bytes`);
    }
    return new Uint8Array(decoded);
}
