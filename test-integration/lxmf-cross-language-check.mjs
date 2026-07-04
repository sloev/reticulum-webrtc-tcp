// Manual, throwaway check: a real Python `lxmf`/`rns` process and our JS
// Reticulum + LXMF implementation exchange genuine LXMF messages over real
// TCP + HDLC, in both directions, each side validating the other's Ed25519
// signature. Confirms shared/rns/protocol.js's lxmf_build/lxmf_parse (and the
// msgpack.js encoder they depend on) aren't just internally self-consistent,
// but wire-compatible with the actual reference LXMF implementation.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination } from '../shared/rns/index.js';
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

py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
