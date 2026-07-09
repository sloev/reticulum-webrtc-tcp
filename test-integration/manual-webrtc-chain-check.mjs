// Manual check: real WebRTC between 3 headless Chromium pages, each running
// a real Reticulum + Destination (not just a bare WebRTC interface), wired
// sparsely (1<->2<->3, no direct 1<->3). Signaling is relayed directly by
// this script (bypassing Nostr, since public relays aren't reachable here).
// Confirms an announce from page1 reaches page3 only via page2's real
// Reticulum.onPacketReceived rebroadcast logic. A minimal smoke test;
// sparse-mesh-check.mjs covers this more thoroughly (mixed transports, real
// Python peers included).
//
// Run with: node test-integration/manual-webrtc-chain-check.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function makePage(name) {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[${name}]`, m.text()));
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR`, e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  return page;
}

const page1 = await makePage('p1');
const page2 = await makePage('p2');
const page3 = await makePage('p3');
const pages = { p1: page1, p2: page2, p3: page3 };

async function setupNode(page) {
  return page.evaluate(async () => {
    const { Reticulum, Destination, Identity } = await import('/@fs/home/user/reticulum-webrtc-tcp/shared/rns/index.js');
    const { WebRTCBrowser } = await import('/webrtc-browser.js');

    const rns = new Reticulum();
    const webrtc = new WebRTCBrowser();
    webrtc.signaling.connect = async () => {};
    rns.addInterface(webrtc);

    const identity = Identity.create();
    const dest = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'test', 'sparsemesh');
    window.__rns = rns;
    window.__webrtc = webrtc;
    window.__dest = dest;
    return { pubkey: webrtc.signaling.publicKey, destHash: Array.from(dest.hash) };
  });
}

const info = { p1: await setupNode(page1), p2: await setupNode(page2), p3: await setupNode(page3) };
console.log('nodes set up:', JSON.stringify(info));

const pubkeys = { p1: info.p1.pubkey, p2: info.p2.pubkey, p3: info.p3.pubkey };
const routes = { p1: ['p2'], p2: ['p1', 'p3'], p3: ['p2'] }; // sparse chain: no direct p1<->p3

for (const name of Object.keys(pages)) {
  await pages[name].exposeFunction('__deliver', async (targetName, from, msg) => {
    await pages[targetName].evaluate(([from, msg]) => window.__webrtc.signaling.onMessage(from, msg), [from, msg]);
  });
}

for (const name of Object.keys(pages)) {
  const neighbors = routes[name];
  await pages[name].evaluate(({ name, neighbors, pubkeys }) => {
    window.__webrtc.signaling.send = (toPubkey, msg) => {
      const targetName = Object.keys(pubkeys).find((n) => pubkeys[n] === toPubkey);
      if (targetName && neighbors.includes(targetName)) window.__deliver(targetName, pubkeys[name], msg);
    };
  }, { name, neighbors, pubkeys });
}

await page1.evaluate((peerPub) => window.__webrtc.connectTo(peerPub), pubkeys.p2);
await page2.evaluate((peerPub) => window.__webrtc.connectTo(peerPub), pubkeys.p3);
await new Promise((r) => setTimeout(r, 3000));

const counts = await Promise.all([
  page1.evaluate(() => window.__webrtc.dataChannels.size),
  page2.evaluate(() => window.__webrtc.dataChannels.size),
  page3.evaluate(() => window.__webrtc.dataChannels.size),
]);
console.log('data channel counts (expect 1, 2, 1):', counts);

// page3 listens for a real RNS 'announce' event (not raw bytes).
await page3.evaluate(() => {
  window.__gotAnnounce = new Promise((resolve) => window.__rns.once('announce', resolve));
});

await page2.evaluate(() => window.__rns.once('announce', (a) => console.log('p2 got announce', Array.from(a.destination_hash))));
await page1.evaluate(() => window.__dest.announce());
await new Promise((r) => setTimeout(r, 1000));

const announceOnP3 = await page3.evaluate(async () => {
  const a = await Promise.race([window.__gotAnnounce, new Promise((r) => setTimeout(() => r(null), 3000))]);
  return a ? Array.from(a.destination_hash) : null;
});

console.log('announceOnP3 raw:', JSON.stringify(announceOnP3), 'expected:', JSON.stringify(info.p1.destHash));
console.log(
  'page3 received announce for page1 dest (via page2 relay, no direct p1<->p3 link):',
  JSON.stringify(announceOnP3) === JSON.stringify(info.p1.destHash)
);

await browser.close();
