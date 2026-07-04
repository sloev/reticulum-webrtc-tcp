// Real, heterogeneous, sparsely-connected mesh integration check spanning every
// transport this project supports at once:
//
//   PyNodeA --TCP--> BridgeA --WebRTC--\
//                                       Hub --WebRTC--> Leaf
//                                      /
//   PyNodeB --TCP--> BridgeB --WebRTC-/
//
// - PyNodeA / PyNodeB: real Python `rns` (pip install rns) processes, talking
//   real TCP + HDLC framing to this repo's gateway (exactly like a real RNS
//   TCPClientInterface would).
// - BridgeA / BridgeB: real Node.js Reticulum instances combining a real
//   TCPServerInterface (node/tcp-gateway.js) with a WebRTC leg. Real WebRTC
//   can't run inside plain Node in this sandbox (native node-datachannel
//   can't build here), so each bridge's WebRTC leg is a genuine
//   RTCPeerConnection/RTCDataChannel running in its own headless Chromium
//   page, proxied byte-for-byte into the bridge's real Reticulum instance
//   (BrowserProxyInterface below) — the protocol logic (flooding, path
//   table) still runs for real in Node, only the raw transport is proxied.
// - Hub: a full real Reticulum + WebRTCBrowser instance running in Chromium,
//   with THREE neighbors (BridgeA, BridgeB, Leaf) on the *same* WebRTCInterface
//   object — this is exactly the multi-peer-relay scenario fixed in
//   shared/rns/index.js (_broadcastExcept/sendDataExcluding): flooding an
//   announce must reach BridgeB and Leaf without echoing back to BridgeA.
// - Leaf: a WebRTC-only node (browser-only peer, no TCP), one neighbor (Hub).
//
// All links are sparse (a straight chain plus one 3-way hub) — no node has a
// direct connection to a node more than one hop away. Signaling is relayed
// directly between Playwright pages (bypassing Nostr, since public relays
// aren't reachable in this sandbox).
//
// Run with: PYLIBS=/path/to/site-packages node test-integration/sparse-mesh-check.mjs
// (vite dev server must be running: npx vite serve browser, default port 5173)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { Reticulum, Interface } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns)');
  process.exit(1);
}

const PORT_A = 18860;
const PORT_B = 18861;

let failed = false;
function assertEqual(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`, ok ? '' : `(got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  if (!ok) failed = true;
}
function assertTrue(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failed = true;
}

// A Node-side stand-in Interface whose actual bytes-on-the-wire travel over a
// real WebRTC data channel living in a dedicated headless Chromium page. Real
// protocol logic (flooding, forwarding) runs here in Node, exactly like a real
// WebRTCInterface would; only the physical transport is proxied over Playwright.
class BrowserProxyInterface extends Interface {
  constructor(name, page) {
    super(name);
    this.page = page;
  }
  connect() {}
  sendData(data) {
    this.page.evaluate((bytes) => window.__webrtc.sendData(new Uint8Array(bytes)), Array.from(data)).catch(() => {});
  }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function newPage(name) {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[${name}]`, m.text()));
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR`, e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  return page;
}

// Hub and Leaf run a full, real Reticulum + WebRTCBrowser stack in-page.
async function setupFullNode(page) {
  return page.evaluate(async () => {
    const { Reticulum } = await import('/@fs/home/user/reticulum-webrtc-tcp/shared/rns/index.js');
    const { WebRTCBrowser } = await import('/webrtc-browser.js');
    const rns = new Reticulum();
    const webrtc = new WebRTCBrowser();
    webrtc.signaling.connect = async () => {};
    rns.addInterface(webrtc);
    window.__rns = rns;
    window.__webrtc = webrtc;
    return { pubkey: webrtc.signaling.publicKey };
  });
}

// BridgeA/BridgeB's WebRTC leg: a bare WebRTCBrowser with no Reticulum of its
// own (real Reticulum lives in the Node bridge process instead) — just a real
// data channel that forwards received bytes back to Node.
async function setupProxyNode(page) {
  return page.evaluate(async () => {
    const { WebRTCBrowser } = await import('/webrtc-browser.js');
    const webrtc = new WebRTCBrowser();
    webrtc.signaling.connect = async () => {};
    webrtc.onDataReceived = (data) => window.__toNode(Array.from(data));
    await webrtc.connect();
    window.__webrtc = webrtc;
    return { pubkey: webrtc.signaling.publicKey };
  });
}

const pageBridgeA = await newPage('bridgeA-webrtc');
const pageHub = await newPage('hub');
const pageLeaf = await newPage('leaf');
const pageBridgeB = await newPage('bridgeB-webrtc');

// --- Node-side bridge Reticulum instances ---
const rnsBridgeA = new Reticulum();
const tcpGatewayA = createTCPGateway(PORT_A, rnsBridgeA);
const proxyIfaceA = new BrowserProxyInterface('BridgeA-webrtc', pageBridgeA);
await pageBridgeA.exposeFunction('__toNode', (bytes) => rnsBridgeA.onPacketReceived(new Uint8Array(bytes), proxyIfaceA));
rnsBridgeA.addInterface(proxyIfaceA);

const rnsBridgeB = new Reticulum();
const tcpGatewayB = createTCPGateway(PORT_B, rnsBridgeB);
const proxyIfaceB = new BrowserProxyInterface('BridgeB-webrtc', pageBridgeB);
await pageBridgeB.exposeFunction('__toNode', (bytes) => rnsBridgeB.onPacketReceived(new Uint8Array(bytes), proxyIfaceB));
rnsBridgeB.addInterface(proxyIfaceB);

// --- Set up all four WebRTC page-side peers ---
const infoBridgeA = await setupProxyNode(pageBridgeA);
const infoHub = await setupFullNode(pageHub);
const infoLeaf = await setupFullNode(pageLeaf);
const infoBridgeB = await setupProxyNode(pageBridgeB);

const pubkeys = { bridgeA: infoBridgeA.pubkey, hub: infoHub.pubkey, leaf: infoLeaf.pubkey, bridgeB: infoBridgeB.pubkey };
const pages = { bridgeA: pageBridgeA, hub: pageHub, leaf: pageLeaf, bridgeB: pageBridgeB };
// Sparse: hub is the only 3-way node; bridgeA, leaf, bridgeB each have exactly one neighbor.
const routes = { bridgeA: ['hub'], hub: ['bridgeA', 'leaf', 'bridgeB'], leaf: ['hub'], bridgeB: ['hub'] };

for (const name of Object.keys(pages)) {
  await pages[name].exposeFunction('__deliverSignal', async (targetName, from, msg) => {
    await pages[targetName].evaluate(([from, msg]) => window.__webrtc.signaling.onMessage(from, msg), [from, msg]);
  });
}
for (const name of Object.keys(pages)) {
  const neighbors = routes[name];
  await pages[name].evaluate(({ name, neighbors, pubkeys }) => {
    window.__webrtc.signaling.send = (toPubkey, msg) => {
      const targetName = Object.keys(pubkeys).find((n) => pubkeys[n] === toPubkey);
      if (targetName && neighbors.includes(targetName)) window.__deliverSignal(targetName, pubkeys[name], msg);
    };
  }, { name, neighbors, pubkeys });
}

await pageBridgeA.evaluate((peerPub) => window.__webrtc.connectTo(peerPub), pubkeys.hub);
await pageHub.evaluate((peerPub) => window.__webrtc.connectTo(peerPub), pubkeys.leaf);
await pageBridgeB.evaluate((peerPub) => window.__webrtc.connectTo(peerPub), pubkeys.hub);
await new Promise((r) => setTimeout(r, 3000));

const dcCounts = {
  bridgeA: await pageBridgeA.evaluate(() => window.__webrtc.dataChannels.size),
  hub: await pageHub.evaluate(() => window.__webrtc.dataChannels.size),
  leaf: await pageLeaf.evaluate(() => window.__webrtc.dataChannels.size),
  bridgeB: await pageBridgeB.evaluate(() => window.__webrtc.dataChannels.size),
};
console.log('data channel counts:', dcCounts);
assertEqual(dcCounts, { bridgeA: 1, hub: 3, leaf: 1, bridgeB: 1 }, 'sparse WebRTC topology formed (hub has 3 neighbors, everyone else has 1)');

// --- Spawn the two real Python RNS nodes, each behind its own bridge's TCP gateway ---
function spawnPyNode(configdir, port) {
  return spawn('python3', [
    'test-integration/rns_node.py',
    '--configdir', configdir,
    '--app-name', 'test',
    '--aspect', 'sparsemesh',
    '--tcp-target-host', '127.0.0.1',
    '--tcp-target-port', String(port),
  ], {
    env: { ...process.env, PYTHONPATH: PYLIBS },
    cwd: new URL('..', import.meta.url).pathname,
  });
}

import { rmSync } from 'node:fs';
rmSync('/tmp/pynode-sparse-a', { recursive: true, force: true });
rmSync('/tmp/pynode-sparse-b', { recursive: true, force: true });

const pyA = spawnPyNode('/tmp/pynode-sparse-a', PORT_A);
const pyB = spawnPyNode('/tmp/pynode-sparse-b', PORT_B);

function readEvents(proc, label) {
  const events = [];
  const waiters = []; // { predicate, resolve, timer }
  proc.stderr.on('data', (d) => console.log(`[${label} stderr]`, d.toString().trim()));
  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      console.log(`[${label}]`, line);
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
  return {
    proc,
    send: (obj) => proc.stdin.write(JSON.stringify(obj) + '\n'),
    waitFor: (predicate, timeoutMs = 5000) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for event on ${label}`)), timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

const pyANode = readEvents(pyA, 'pyA');
const pyBNode = readEvents(pyB, 'pyB');

const readyA = await pyANode.waitFor((m) => m.event === 'ready', 10000);
const readyB = await pyBNode.waitFor((m) => m.event === 'ready', 10000);
console.log('Python nodes ready:', { destA: readyA.dest_hash, destB: readyB.dest_hash });

// Give the TCP gateways a moment to register the client sockets before flooding.
await new Promise((r) => setTimeout(r, 500));

// Hub and Leaf listen for the real 'announce' event (validated in JS), not just raw bytes.
await pageHub.evaluate(() => { window.__gotAnnounce = new Promise((resolve) => window.__rns.once('announce', resolve)); });
await pageLeaf.evaluate(() => { window.__gotAnnounce = new Promise((resolve) => window.__rns.once('announce', resolve)); });

// --- The actual test: PyNodeA announces; confirm it reaches every other node
// in the sparse mesh, including PyNodeB two transport-hops and one real
// multi-peer WebRTC relay away. ---
pyANode.send({ cmd: 'announce' });

const hubAnnounce = await pageHub.evaluate(async () => {
  const a = await Promise.race([window.__gotAnnounce, new Promise((r) => setTimeout(() => r(null), 5000))]);
  return a ? Array.from(a.destination_hash) : null;
});
const leafAnnounce = await pageLeaf.evaluate(async () => {
  const a = await Promise.race([window.__gotAnnounce, new Promise((r) => setTimeout(() => r(null), 5000))]);
  return a ? Array.from(a.destination_hash) : null;
});
const pyBAnnounce = await pyBNode.waitFor((m) => m.event === 'announce_received', 5000).catch(() => null);

const expectedDestHash = Array.from(crypto.hexToBytes(readyA.dest_hash));
assertEqual(hubAnnounce, expectedDestHash, 'Hub (real WebRTC relay with 3 neighbors on one interface) received PyNodeA\'s announce');
assertEqual(leafAnnounce, expectedDestHash, 'Leaf (WebRTC-only node) received PyNodeA\'s announce, relayed through the hub');
assertTrue(!!pyBAnnounce, 'PyNodeB (real Python rns, across TCP -> WebRTC -> hub -> WebRTC -> TCP) received PyNodeA\'s announce');
if (pyBAnnounce) {
  assertEqual(pyBAnnounce.dest_hash, readyA.dest_hash, 'PyNodeB\'s announce is for the correct destination hash');
  assertTrue(pyBAnnounce.hops > 0, `PyNodeB sees a non-zero hop count (${pyBAnnounce.hops}), confirming real multi-hop relay`);
}

pyA.kill();
pyB.kill();
tcpGatewayA.server.close();
tcpGatewayB.server.close();
await browser.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
