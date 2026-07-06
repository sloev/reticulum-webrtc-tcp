// shared/rns/compression.js: bz2 compression and decompression, verified
// against ground truth captured directly from Python's real `bz2` module,
// not just round-tripped against itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as compression from '../shared/rns/compression.js';
import * as crypto from '../shared/rns/crypto.js';

test('bz2_decompress() correctly decodes real bz2.compress() output', () => {
  const compressed = crypto.hexToBytes(
    '425a6839314159265359f892d5550000db9380400104003ffffff03000d805000340000500034000014a94d4d3468c2686d4db52604e42644fa13227c09a89813513a09ee27d89813b09813b04d84dc27713c09d44d84f413f04c09b84c89dc4d04e426a27813413a89fc26c2682644c89d055e44f227f8bb9229c28487c496aaa80'
  );
  const decoded = compression.bz2_decompress(compressed);
  assert.equal(new TextDecoder().decode(decoded), 'The quick brown fox jumps over the lazy dog. '.repeat(40));
});

test('bz2_compress() matches real bz2.compress(data, 9) byte-for-byte for a fixed input', async () => {
  const input = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(40));
  const compressed = await compression.bz2_compress(input);

  // Ground truth: bz2.compress(input, 9) from a real Python process for
  // this exact input — confirms bzip2-wasm (a WASM build of the real
  // libbzip2 the Python bz2 module itself wraps) produces the *same* bytes
  // the reference implementation would, not just *a* valid bz2 stream.
  const expected = crypto.hexToBytes(
    '425a6839314159265359f892d5550000db9380400104003ffffff03000d805000340000500034000014a94d4d3468c2686d4db52604e42644fa13227c09a89813513a09ee27d89813b09813b04d84dc27713c09d44d84f413f04c09b84c89dc4d04e426a27813413a89fc26c2682644c89d055e44f227f8bb9229c28487c496aaa80'
  );
  assert.equal(crypto.bytesToHex(compressed), crypto.bytesToHex(expected));
});

test('bz2_compress_if_beneficial() uses the compressed form for compressible data and the original for incompressible data', async () => {
  const compressible = new TextEncoder().encode('a'.repeat(10000));
  const compressibleResult = await compression.bz2_compress_if_beneficial(compressible);
  assert.equal(compressibleResult.compressed, true);
  assert.ok(compressibleResult.data.length < compressible.length);
  assert.equal(new TextDecoder().decode(compression.bz2_decompress(compressibleResult.data)), new TextDecoder().decode(compressible));

  const incompressible = crypto.randomBytes(4000);
  const incompressibleResult = await compression.bz2_compress_if_beneficial(incompressible);
  assert.equal(incompressibleResult.compressed, false);
  assert.equal(crypto.bytesToHex(incompressibleResult.data), crypto.bytesToHex(incompressible));
});

test('bz2_decompress() throws once the decompressed size exceeds the given max_length (decompression-bomb guard)', () => {
  // bz2.compress(b'A' * 200000) — a small compressed blob that expands to
  // 200000 bytes, matching real RNS.Resource's AUTO_COMPRESS_MAX_SIZE-style
  // guard (RNS.Resource.max_decompressed_size / RawChannelWriter.MAX_CHUNK_LEN).
  const compressed = crypto.hexToBytes(
    '425a683931415926535976dce1e60001880400a0040008200030cc0529a6085b1085e2ee48a70a120edb9c3cc0'
  );
  assert.throws(() => compression.bz2_decompress(compressed, 1024));
  const decoded = compression.bz2_decompress(compressed, 200000);
  assert.equal(decoded.length, 200000);
});
