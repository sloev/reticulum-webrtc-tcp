// Verifies Channel/Buffer (shared/rns/channel.js, shared/rns/buffer.js)
// against a real Python `rns` process: a real RNS.Link over real TCP + HDLC,
// then RNS.Channel messages and RNS.Buffer streams in both directions,
// confirming this project's envelope header, windowed delivery (explicit
// packet proofs), and StreamDataMessage framing interoperate with a real
// RNS peer, not just with themselves.
//
// Run with: PYLIBS=/path/to/site-packages npm run test:integration:channel
// (requires: pip install --target=$PYLIBS rns)
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as protocol from '../shared/rns/protocol.js';
import * as RnsBuffer from '../shared/rns/buffer.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns)');
  process.exit(1);
}

const PORT = 18895;
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

rmSync('/tmp/pynode-channel-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/rns_node.py',
  '--configdir', '/tmp/pynode-channel-check',
  '--app-name', 'test',
  '--aspect', 'channelcheck',
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
py.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    console.log('[py]', line);
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

const pythonIdentity = { public: crypto.hexToBytes(ready.public_key) };
const pythonDest = new Destination(rns, pythonIdentity, Destination.OUT, Destination.SINGLE, 'test', 'channelcheck');
assertEqual(crypto.bytesToHex(pythonDest.hash), ready.dest_hash, 'JS derives the same destination hash for the Python identity that Python itself reports');

const pyGotLink = waitFor((m) => m.event === 'link_established', 10000);
const link = new Link(rns, pythonDest);
await new Promise((resolve) => link.once('established', resolve));
await pyGotLink;
console.log('real RNS.Link established in both directions');

const channel = link.getChannel();
const TESTMSG_TYPE = 0x0001;
const receivedFromPython = [];
channel.addMessageHandler((msgtype, data) => {
  if (msgtype === TESTMSG_TYPE) {
    receivedFromPython.push(crypto.bytesToHex(data));
    return true;
  }
  return false;
});

// --- JS -> Python: a real RNS.Channel message ---
const jsToPyPayload = crypto.randomBytes(64);
const pyGotChannelMessage = waitFor((m) => m.event === 'channel_message', 10000);
channel.send(TESTMSG_TYPE, jsToPyPayload);
const pyChannelEvent = await pyGotChannelMessage;
assertEqual(pyChannelEvent.hex, crypto.bytesToHex(jsToPyPayload), 'Python (real RNS.Channel) correctly received a message sent by Channel.send()');

// --- Python -> JS: a real RNS.Channel message, sent by the reference implementation ---
const pyToJsPayload = crypto.randomBytes(48);
py.stdin.write(JSON.stringify({ cmd: 'channel_send', hex: crypto.bytesToHex(pyToJsPayload) }) + '\n');
await new Promise((resolve) => {
  const check = () => (receivedFromPython.length >= 1 ? resolve() : setTimeout(check, 20));
  check();
});
assertEqual(receivedFromPython[0], crypto.bytesToHex(pyToJsPayload), 'JS correctly received a message sent by real RNS.Channel.send()');

// --- JS -> Python: a real RNS.Buffer stream, split across several chunks.
// Repetitive text like this compresses well, so this also exercises this
// stack's outgoing per-chunk bz2 compression (shared/rns/compression.js) —
// real RNS.Buffer only correctly reassembles this if it actually recognized
// and decompressed the compressed chunks, since the wire bytes are no
// longer the plaintext otherwise (the separate incompressible-data check
// below, in the other direction, covers the not-worth-compressing path). ---
const jsToPyStreamPayload = new TextEncoder().encode('compressible buffer stream chunk from this project\'s Buffer writer! '.repeat(50)); // several chunks at STREAM_DATA_MAX_LEN=423
const pyGotBuffer = waitFor((m) => m.event === 'buffer_received', 15000);
const writer = RnsBuffer.createWriter(1, channel);
let offset = 0;
while (offset < jsToPyStreamPayload.length) {
  while (!channel.isReadyToSend()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  offset += await writer.write(jsToPyStreamPayload.slice(offset));
}
await writer.close();
const pyBufferEvent = await pyGotBuffer;
assertEqual(pyBufferEvent.hex, crypto.bytesToHex(jsToPyStreamPayload), 'Python (real RNS.Buffer) correctly reassembled a stream written by this project\'s Buffer writer');

// --- Python -> JS: a real RNS.Buffer stream, sent by the reference
// implementation, using high-entropy random bytes bz2 can't usefully
// compress (exercises the uncompressed path) ---
const pyToJsStreamPayload = crypto.randomBytes(3000);
const reader = RnsBuffer.createReader(1, channel);
const jsChunks = [];
reader.on('data', (chunk) => jsChunks.push(chunk));
const jsStreamEnded = new Promise((resolve) => reader.once('end', resolve));
py.stdin.write(JSON.stringify({ cmd: 'buffer_send', hex: crypto.bytesToHex(pyToJsStreamPayload) }) + '\n');
await jsStreamEnded;
const reassembled = crypto.concat(...jsChunks);
assertEqual(crypto.bytesToHex(reassembled), crypto.bytesToHex(pyToJsStreamPayload), 'JS correctly reassembled a stream sent by a real RNS.Buffer writer');

// --- Python -> JS: a real RNS.Buffer stream real RNS actually bz2-compresses
// per-chunk (highly repetitive data), exercising this project's stream
// decompression support rather than avoiding it ---
const pyToJsCompressibleText = 'compressible buffer stream chunk from real Python RNS.Buffer! '.repeat(30);
const pyToJsCompressiblePayload = new TextEncoder().encode(pyToJsCompressibleText);
const compressibleReader = RnsBuffer.createReader(2, channel);
const jsCompressibleChunks = [];
compressibleReader.on('data', (chunk) => jsCompressibleChunks.push(chunk));
const jsCompressibleStreamEnded = new Promise((resolve) => compressibleReader.once('end', resolve));
py.stdin.write(JSON.stringify({ cmd: 'buffer_send', stream_id: 2, hex: crypto.bytesToHex(pyToJsCompressiblePayload) }) + '\n');
await jsCompressibleStreamEnded;
const compressibleReassembled = crypto.concat(...jsCompressibleChunks);
assertEqual(new TextDecoder().decode(compressibleReassembled), pyToJsCompressibleText, 'JS correctly decompressed and reassembled a bz2-compressed stream sent by real Python RNS.Buffer');

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
