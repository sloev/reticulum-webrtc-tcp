// Manual, throwaway check: a real Python `rns` process and this JS stack
// establish a genuine RNS.Link over real TCP + HDLC, then exchange
// RNS.Resource transfers in both directions — this JS stack's Resource
// implementation was rewritten to use a fixed-size request window (matching
// RNS.Resource.request_next()'s algorithm, just without its adaptive rate
// scaling) specifically so it could interoperate with a real RNS peer,
// instead of just with itself. This confirms that actually works: a real
// Python RNS.Resource receiver correctly reassembles data sent by
// Link.sendResource() here, and this stack's receiver correctly reassembles
// a real RNS.Resource sent by Python.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns)');
  process.exit(1);
}

const PORT = 18880;
let failed = false;
function assertTrue(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failed = true;
}
function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`, ok ? '' : `(got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  if (!ok) failed = true;
}

const rns = new Reticulum();
const gateway = createTCPGateway(PORT, rns);

const identity = Identity.create();
const self = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'test', 'resourcecheck');

rmSync('/tmp/pynode-resource-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/rns_node.py',
  '--configdir', '/tmp/pynode-resource-check',
  '--app-name', 'test',
  '--aspect', 'resourcecheck',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[py stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 10000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for python event')), timeoutMs);
    waiters.push({ predicate, resolve, timer });
  });
}
// A large event (e.g. a multi-segment resource's hex-encoded payload) can
// arrive split across multiple stdout 'data' chunks, so a complete line
// isn't guaranteed per chunk — buffer partial output across chunks and only
// process text up to the last newline seen so far.
let stdoutBuffer = '';
py.stdout.on('data', (d) => {
  stdoutBuffer += d.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop(); // last element: text after the final newline so far, possibly incomplete

  for (const line of lines) {
    if (!line.trim()) continue;
    console.log('[py]', line.length > 500 ? `${line.slice(0, 500)}... (${line.length} chars)` : line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // RNS's own log lines, not one of our JSON events
    }
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  }
});

const ready = await waitFor((m) => m.event === 'ready', 10000);
console.log('python node ready:', ready);

// JS initiates the Link (python's Destination gets link_established for it).
const pythonIdentity = { public: crypto.hexToBytes(ready.public_key) };
const pythonDest = new Destination(rns, pythonIdentity, Destination.OUT, Destination.SINGLE, 'test', 'resourcecheck');
assertEqual(crypto.bytesToHex(pythonDest.hash), ready.dest_hash, 'JS derives the same destination hash for the Python identity that Python itself reports');

const pyGotLink = waitFor((m) => m.event === 'link_established', 10000);
const link = new Link(rns, pythonDest);
await new Promise((resolve) => link.once('established', resolve));
await pyGotLink;
console.log('real RNS.Link established in both directions');

// --- JS -> Python: a real RNS.Resource transfer, larger than one packet.
// Repetitive text like this compresses well, so this also exercises this
// stack's outgoing bz2 compression (shared/rns/compression.js) — asserting
// resource.compressed on the Python side confirms the real reference
// implementation actually recognized and decompressed it, not just that the
// content happens to match either way. ---
const pyPayloadText = 'resource payload from JS: '.repeat(80);
const pyGotResource = waitFor((m) => m.event === 'resource_received', 15000);
await link.sendResource(new TextEncoder().encode(pyPayloadText));
const pyResourceEvent = await pyGotResource;
assertEqual(Buffer.from(pyResourceEvent.data_hex, 'hex').toString('utf-8'), pyPayloadText, 'Python (real RNS.Resource) correctly reassembled the JS-sent resource');
assertTrue(pyResourceEvent.compressed === true, 'Python (real RNS.Resource) recognized the JS-sent resource as bz2-compressed');

// --- JS -> Python: high-entropy random data, which bz2 can't usefully
// compress — confirms the compress-if-beneficial decision correctly falls
// back to sending uncompressed rather than always compressing regardless. ---
const pyIncompressiblePayload = crypto.randomBytes(5000);
const pyGotIncompressibleResource = waitFor((m) => m.event === 'resource_received' && m.data_hex.length === pyIncompressiblePayload.length * 2, 15000);
await link.sendResource(pyIncompressiblePayload);
const pyIncompressibleEvent = await pyGotIncompressibleResource;
assertEqual(pyIncompressibleEvent.data_hex, crypto.bytesToHex(pyIncompressiblePayload), 'Python (real RNS.Resource) correctly reassembled a JS-sent, high-entropy resource');
assertTrue(pyIncompressibleEvent.compressed === false, 'Python (real RNS.Resource) recognized the JS-sent high-entropy resource as NOT worth compressing');

// --- JS -> Python: a real RNS.Resource transfer spanning multiple segments
// (this project segments past protocol.RESOURCE_SEGMENT_MAX_SIZE, ~55KB —
// real RNS only segments past 1MiB-1, but a real receiver just processes
// whatever segment size the sender advertises) ---
const pyMultiSegmentPayload = crypto.concat(crypto.randomBytes(60000), crypto.randomBytes(30000));
const pyGotMultiSegmentResource = waitFor((m) => m.event === 'resource_received' && m.data_hex.length === pyMultiSegmentPayload.length * 2, 20000);
await link.sendResource(pyMultiSegmentPayload);
const pyMultiSegmentEvent = await pyGotMultiSegmentResource;
assertEqual(pyMultiSegmentEvent.data_hex, crypto.bytesToHex(pyMultiSegmentPayload), 'Python (real RNS.Resource) correctly reassembled a JS-sent, multi-segment resource');

// --- Python -> JS: a real RNS.Resource transfer, sent by the reference
// implementation, using high-entropy random bytes that bz2 can't usefully
// compress (matching how a real sender behaves for already-compressed or
// encrypted data — this exercises the uncompressed path) ---
const pyToJsPayload = crypto.randomBytes(2200);
const pyToJsPayloadHex = crypto.bytesToHex(pyToJsPayload);
const jsGotResource = new Promise((resolve) => link.once('resource', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_resource', hex: pyToJsPayloadHex }) + '\n');
const jsResourceData = await jsGotResource;
assertEqual(crypto.bytesToHex(jsResourceData), pyToJsPayloadHex, 'JS correctly reassembled a resource sent by real Python RNS.Resource');

// --- Python -> JS: a real RNS.Resource transfer that real RNS actually
// bz2-compresses (highly repetitive data), exercising this project's
// decompression support (shared/rns/compression.js) rather than avoiding it ---
const pyToJsCompressiblePayload = 'compressible resource payload from real Python RNS: '.repeat(80);
const pyToJsCompressibleHex = Buffer.from(pyToJsCompressiblePayload, 'utf-8').toString('hex');
const jsGotCompressedResource = new Promise((resolve) => link.once('resource', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_resource', hex: pyToJsCompressibleHex }) + '\n');
const jsCompressedResourceData = await jsGotCompressedResource;
assertEqual(Buffer.from(jsCompressedResourceData).toString('utf-8'), pyToJsCompressiblePayload, 'JS correctly decompressed and reassembled a bz2-compressed resource sent by real Python RNS.Resource');

link.close();
py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
