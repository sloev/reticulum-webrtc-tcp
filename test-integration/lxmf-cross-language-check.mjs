// Manual, throwaway check: a real Python `lxmf`/`rns` process and our JS
// Reticulum + LXMF implementation exchange genuine LXMF messages over real
// TCP + HDLC, in both directions, each side validating the other's Ed25519
// signature. Confirms shared/rns/protocol.js's lxmf_build/lxmf_parse (and the
// msgpack.js encoder they depend on) aren't just internally self-consistent,
// but wire-compatible with the actual reference LXMF implementation.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf)');
  process.exit(1);
}

const PORT = 18870;
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
const self = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

rmSync('/tmp/pynode-lxmf-check', { recursive: true, force: true });
const configdir = '/tmp/pynode-lxmf-check';
const py = spawn('python3', [
  'test-integration/rns_node.py',
  '--configdir', configdir,
  '--app-name', 'test',
  '--aspect', 'lxmfcheck',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[py stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 5000) {
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
    const msg = JSON.parse(line);
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

// Exchange announces both ways so each side learns the other's identity.
const pyGotAnnounce = waitFor((m) => m.event === 'announce_received', 5000);
self.announce();
await pyGotAnnounce;

// Python's "announce" command announces both its plain test destination and
// its lxmf.delivery destination — wait for both before proceeding.
let jsAnnounceCount = 0;
const jsGotBothAnnounces = new Promise((resolve) => {
  rns.on('announce', () => { jsAnnounceCount++; if (jsAnnounceCount >= 2) resolve(); });
});
py.stdin.write(JSON.stringify({ cmd: 'announce' }) + '\n');
await jsGotBothAnnounces;

// --- JS -> Python ---
const pyGotLxmf = waitFor((m) => m.event === 'lxmf_received', 5000);
// Destination derives its hash from identity.public itself; pass just the
// public key (matching python's identity) and confirm it lands on the same
// hash python itself reported for its lxmf delivery destination.
const pyIdentity = { public: crypto.hexToBytes(ready.public_key) };
const jsToPyDest = new Destination(rns, pyIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
assertEqual(crypto.bytesToHex(jsToPyDest.hash), ready.lxmf_dest_hash, 'JS derives the same lxmf.delivery destination hash for the Python identity that Python itself reports');
jsToPyDest.sendLXMF(self, 'hello from JS', 'this is a real lxmf message from the JS stack', { hello: 'world' });

const pyReceived = await pyGotLxmf;
assertTrue(pyReceived.valid, 'Python validated the JS-signed LXMF message');
assertEqual(pyReceived.title, 'hello from JS', 'Python received the correct LXMF title');
assertEqual(pyReceived.content, 'this is a real lxmf message from the JS stack', 'Python received the correct LXMF content');

// --- Python -> JS ---
const jsGotLxmf = new Promise((resolve) => self.once('lxmf', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_lxmf', dest_hash: crypto.bytesToHex(self.hash), title: 'hello from Python', content: 'this is a real lxmf message from the real rns/lxmf packages' }) + '\n');

const jsReceived = await jsGotLxmf;
assertTrue(jsReceived.valid, 'JS validated the Python-signed LXMF message');
assertEqual(new TextDecoder().decode(jsReceived.title), 'hello from Python', 'JS received the correct LXMF title');
assertEqual(new TextDecoder().decode(jsReceived.content), 'this is a real lxmf message from the real rns/lxmf packages', 'JS received the correct LXMF content');

// --- DIRECT delivery (over a real RNS.Link), both directions, both
// packet-sized and Resource-sized (compliance.md Phase 5.1) ---

// JS -> Python, single packet.
const pyGotDirectLxmf1 = waitFor((m) => m.event === 'lxmf_received' && m.title === 'direct js small', 5000);
const jsToPyLink1 = new Link(rns, jsToPyDest);
await new Promise((resolve) => jsToPyLink1.once('established', resolve));
await jsToPyLink1.sendLXMF(self, 'direct js small', 'a small DIRECT message from JS over a real Link', {});
const pyDirect1 = await pyGotDirectLxmf1;
assertTrue(pyDirect1.valid, "Python validated the JS-signed DIRECT LXMF message (single packet)");
assertEqual(pyDirect1.content, 'a small DIRECT message from JS over a real Link', 'Python received the correct DIRECT (packet) content');
jsToPyLink1.close();

// JS -> Python, forced into a Resource by exceeding a single link packet.
const bigContent = 'padding to force a DIRECT LXMF message into a Resource transfer instead of a single link packet. '.repeat(10);
const pyGotDirectLxmf2 = waitFor((m) => m.event === 'lxmf_received' && m.title === 'direct js big', 10000);
const jsToPyLink2 = new Link(rns, jsToPyDest);
await new Promise((resolve) => jsToPyLink2.once('established', resolve));
await jsToPyLink2.sendLXMF(self, 'direct js big', bigContent, {});
const pyDirect2 = await pyGotDirectLxmf2;
assertTrue(pyDirect2.valid, 'Python validated the JS-signed DIRECT LXMF message (Resource fallback)');
assertEqual(pyDirect2.content, bigContent, 'Python received the correct DIRECT (Resource) content, forced over the size of a single link packet');
jsToPyLink2.close();

// Python -> JS, single packet: JS accepts an incoming Link (registerRequestHandler
// not needed — any Link to `self` surfaces via the 'link' event) and listens for 'lxmf'.
const jsLinkPromise1 = new Promise((resolve) => self.once('link', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_lxmf_direct', dest_hash: crypto.bytesToHex(self.hash), title: 'direct py small', content: 'a small DIRECT message from real lxmf over a real Link' }) + '\n');
const jsDirectLink1 = await jsLinkPromise1;
const jsDirect1 = await new Promise((resolve) => jsDirectLink1.on('lxmf', resolve));
assertTrue(jsDirect1.valid, 'JS validated the Python-signed DIRECT LXMF message (single packet)');
assertEqual(new TextDecoder().decode(jsDirect1.content), 'a small DIRECT message from real lxmf over a real Link', 'JS received the correct DIRECT (packet) content');

// Python -> JS, Resource fallback.
const jsLinkPromise2 = new Promise((resolve) => self.once('link', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_lxmf_direct', dest_hash: crypto.bytesToHex(self.hash), title: 'direct py big', content: bigContent }) + '\n');
const jsDirectLink2 = await jsLinkPromise2;
const jsDirect2 = await new Promise((resolve) => jsDirectLink2.on('lxmf', resolve));
assertTrue(jsDirect2.valid, 'JS validated the Python-signed DIRECT LXMF message (Resource fallback)');
assertEqual(new TextDecoder().decode(jsDirect2.content), bigContent, 'JS received the correct DIRECT (Resource) content, forced over the size of a single link packet, from real lxmf');

// --- Compression negotiation (compliance.md Phase 5.2): Python re-announces
// its lxmf.delivery destination with a real get_announce_app_data()-shaped
// app_data explicitly declaring no SF_COMPRESSION support; JS must honor
// that on its next oversized DIRECT send, skipping compression entirely —
// confirmed from Python's own side via the resource's `compressed` flag. ---
const jsSawNoCompressionAnnounce = new Promise((resolve) => {
  rns.on('announce', function handler(a) {
    if (crypto.bytesToHex(a.destination_hash) === ready.lxmf_dest_hash) { rns.off('announce', handler); resolve(); }
  });
});
py.stdin.write(JSON.stringify({ cmd: 'announce_lxmf_no_compression' }) + '\n');
await jsSawNoCompressionAnnounce;

const pyGotDirectLxmf3 = waitFor((m) => m.event === 'lxmf_received' && m.title === 'direct js no compress', 10000);
const jsToPyLink3 = new Link(rns, jsToPyDest);
await new Promise((resolve) => jsToPyLink3.once('established', resolve));
await jsToPyLink3.sendLXMF(self, 'direct js no compress', bigContent, {});
const pyDirect3 = await pyGotDirectLxmf3;
assertTrue(pyDirect3.valid, 'Python validated the JS-signed DIRECT LXMF message sent after negotiating no compression');
assertEqual(pyDirect3.content, bigContent, 'Python received the correct content with compression negotiated off');
assertEqual(pyDirect3.compressed, false, "the real RNS.Resource Python received reports compressed=False — JS genuinely read Python's real announce app_data and skipped compression, not just decoded it correctly either way");
jsToPyLink3.close();

// --- Ratchet rotation (RNS.Destination.rotate_ratchets): JS rotates its
// destination's ratchet WITHOUT re-announcing — the situation of a peer
// holding a stale announce. Python keeps encrypting against the previous
// ratchet; the retained key must decrypt it. Then JS re-announces the fresh
// ratchet and Python's next message uses it. ---
self.latestRatchetTime = Date.now() - Destination.RATCHET_INTERVAL_MS - 1;
self._rotateRatchets();
assertEqual(self.ratchets.length, 2, 'JS destination rotated in a fresh ratchet and retained the old one');

const jsGotStaleRatchetLxmf = new Promise((resolve) => self.once('lxmf', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_lxmf', dest_hash: crypto.bytesToHex(self.hash), title: 'stale ratchet', content: 'encrypted against the pre-rotation announce' }) + '\n');
const staleReceived = await jsGotStaleRatchetLxmf;
assertTrue(staleReceived.valid, 'JS decrypted and validated a message Python encrypted against the pre-rotation ratchet (retained-key path)');
assertEqual(new TextDecoder().decode(staleReceived.title), 'stale ratchet', 'stale-ratchet message content is intact');

const pySawFreshAnnounce = waitFor((m) => m.event === 'announce_received' && m.dest_hash === crypto.bytesToHex(self.hash), 5000);
self.announce();
await pySawFreshAnnounce;

const jsGotFreshRatchetLxmf = new Promise((resolve) => self.once('lxmf', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_lxmf', dest_hash: crypto.bytesToHex(self.hash), title: 'fresh ratchet', content: 'encrypted against the post-rotation announce' }) + '\n');
const freshReceived = await jsGotFreshRatchetLxmf;
assertTrue(freshReceived.valid, "JS decrypted and validated a message Python encrypted against the rotated ratchet's announce");
assertEqual(new TextDecoder().decode(freshReceived.title), 'fresh ratchet', 'fresh-ratchet message content is intact');

py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
