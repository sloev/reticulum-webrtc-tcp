// Verifies this stack's LXMF wire compatibility against a real, unmodified
// `nomadnet` (NomadNet) client — an actual end-user application, not just
// the bare `rns`/`lxmf` libraries the other integration checks use.
//
// NomadNet runs headless via its own `-d`/`--daemon` mode (no virtual
// display or TUI automation needed) — real identity file, real LXMRouter,
// real delivery destination, real start-of-day announce, exactly as an end
// user would run it. Confirms:
//   1. JS -> NomadNet: NomadNet's real, unmodified daemon receives and
//      stores (under storage/conversations/<hash>/) an OPPORTUNISTIC LXMF
//      message sent by this stack, and its own announce (parsed with
//      protocol.lxmf_stamp_cost_from_app_data/compression parsing) is
//      genuine NomadNet-produced app_data, not a synthetic vector.
//   2. NomadNet -> JS: since NomadNet has no scriptable send API and driving
//      its TUI headlessly isn't practical, this direction is driven via
//      test-integration/nomadnet_driver.py, which runs NomadNet's own
//      NomadNetworkApp (same identity/init path as `nomadnet -d`) and calls
//      `message_router.handle_outbound()` directly — the same call
//      NomadNet's own Conversation/compose code makes internally — rather
//      than a synthetic LXMF payload. See that file's module docstring and
//      README's Compliance section for what this does and doesn't prove
//      relative to a fully TUI-driven interop test.
//
// Run with: PYLIBS=/path/to/site-packages npm run test:integration:nomadnet
// (requires: pip install --target=$PYLIBS rns lxmf nomadnet)
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { Reticulum, Identity, Destination } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as protocol from '../shared/rns/protocol.js';
import * as msgpack from '../shared/rns/msgpack.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf nomadnet)');
  process.exit(1);
}

const PORT = 18990;
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

const nomadConfigDir = '/tmp/nomadnet-interop-check-cfg';
const nomadRnsConfigDir = '/tmp/nomadnet-interop-check-rnscfg';
rmSync(nomadConfigDir, { recursive: true, force: true });
rmSync(nomadRnsConfigDir, { recursive: true, force: true });
mkdirSync(nomadRnsConfigDir, { recursive: true });
writeFileSync(`${nomadRnsConfigDir}/config`, `[reticulum]
enable_transport = True
share_instance = False
panic_on_interface_error = False

[logging]
loglevel = 3

[interfaces]
[[Bridge]]
  type = TCPClientInterface
  interface_enabled = True
  target_host = 127.0.0.1
  target_port = ${PORT}
`);

const py = spawn('python3', [
  'test-integration/nomadnet_driver.py',
  '--configdir', nomadConfigDir,
  '--rnsconfigdir', nomadRnsConfigDir,
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[nomadnet stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 20000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for nomadnet event')), timeoutMs);
    waiters.push({ predicate, resolve, timer });
  });
}
py.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    console.log('[nomadnet]', line);
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

const ready = await waitFor((m) => m.event === 'ready', 15000);
console.log('real nomadnet client ready:', ready);

// --- JS -> NomadNet ---
console.log("waiting for NomadNet's own start-of-day announce (NomadNetworkApp.START_ANNOUNCE_DELAY=3s)...");
const nomadAnnounce = await new Promise((resolve) => {
  rns.on('announce', function handler(a) {
    if (crypto.bytesToHex(a.destination_hash) === ready.dest_hash) { rns.off('announce', handler); resolve(a); }
  });
});
assertEqual(crypto.bytesToHex(nomadAnnounce.destination_hash), ready.dest_hash, "JS received NomadNet's real lxmf.delivery announce");

// NomadNet's real announce app_data is [display_name_bytes, stamp_cost, [...]]
// (the same shape protocol.js's lxmf_*_from_app_data() functions parse) —
// confirm the display name genuinely round-trips from NomadNet's own
// peer_settings, not a synthetic vector.
const [nomadAppDisplayName] = msgpack.unpack(nomadAnnounce.app_data);
assertEqual(new TextDecoder().decode(nomadAppDisplayName), ready.display_name, "NomadNet's real announce app_data display_name matches its own configured peer_settings display name");
assertEqual(protocol.lxmf_compression_supported(nomadAnnounce.app_data), true, "protocol.lxmf_compression_supported() parses NomadNet's real announce app_data correctly (NomadNet supports compression, declared or by default)");

const nomadIdentity = { public: crypto.hexToBytes(ready.public_key) };
const nomadDest = new Destination(rns, nomadIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
assertEqual(crypto.bytesToHex(nomadDest.hash), ready.dest_hash, 'JS derives the same lxmf.delivery destination hash NomadNet itself reports');

nomadDest.sendLXMF(self, 'hello from JS', 'this is a real lxmf message sent to an actual nomadnet client', { via: 'js-stack' });

// NomadNet has no JSON event channel — confirm receipt by polling its own
// on-disk conversation store (Conversation.ingest()'s write_to_directory())
// for a new file under storage/conversations/<our source hash>/.
const conversationDir = `${nomadConfigDir}/storage/conversations/${crypto.bytesToHex(self.hash)}`;
let received = false;
for (let i = 0; i < 100; i++) {
  if (existsSync(conversationDir) && readdirSync(conversationDir).some((f) => !['unread', 'failed'].includes(f))) {
    received = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
assertTrue(received, `NomadNet's real, unmodified daemon received and stored the JS-sent LXMF message (checked ${conversationDir})`);

// --- NomadNet -> JS ---
// NomadNet's own RNS.Identity cache needs to have learned JS's identity
// (via an announce) before it can encrypt to it — announce now and give the
// real Reticulum instance underneath NomadNet a moment to receive and cache it.
const jsGotLxmf = new Promise((resolve) => self.once('lxmf', resolve));
self.announce();
await new Promise((r) => setTimeout(r, 1000));
py.stdin.write(JSON.stringify({ cmd: 'send_to', dest_hash: crypto.bytesToHex(self.hash), title: 'hello from nomadnet', content: 'this is a real lxmf message sent via a real nomadnet identity/router' }) + '\n');
const jsReceived = await jsGotLxmf;
assertTrue(jsReceived.valid, "JS validated the signature of a message sent via NomadNet's own real identity/LXMRouter");
assertEqual(new TextDecoder().decode(jsReceived.title), 'hello from nomadnet', 'JS received the correct title from NomadNet');
assertEqual(new TextDecoder().decode(jsReceived.content), 'this is a real lxmf message sent via a real nomadnet identity/router', 'JS received the correct content from NomadNet');

py.kill('SIGKILL'); // NomadNet's own signal/cleanup handling can hang on plain SIGTERM
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
