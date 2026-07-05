import { Buffer } from 'buffer';
// Some dependencies (e.g. seek-bzip, used by shared/rns/compression.js) and
// a couple of this project's own modules assume a global `Buffer`, as in
// Node — the `buffer` package (already a dependency, aliased in
// vite.config.js) provides a browser-compatible implementation, it's just
// not exposed as a global by default.
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

import { Reticulum, Destination, Identity, Link } from '../shared/rns/index.js';
import { WebRTCBrowser } from './webrtc-browser.js';
import * as crypto from '../shared/rns/crypto.js';

// Chat messages are sent as a Channel message over an established Link, not
// as one-shot LXMF packets — this is what actually exercises Link/Channel's
// reliable delivery (and Link.identify(), so the recipient can show who a
// message is from) in the demo, rather than just being available as a
// verified API nothing here used.
const CHAT_MSGTYPE = 0x0001;

const logEl = document.getElementById('log');
const knownPeersEl = document.getElementById('known-peers');
const peerCountEl = document.getElementById('peer-count');
const knownCountEl = document.getElementById('known-count');
const destInput = document.getElementById('dest');
const msgInput = document.getElementById('msg');

const log = (tag, text) => {
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${tag}`;
  line.innerHTML = `<span class="ts">${ts}</span><span class="tag">[${tag}]</span> ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
};

const rns = new Reticulum();
const webrtc = new WebRTCBrowser();
rns.addInterface(webrtc);

const identity = Identity.create();
const dest = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'webrtc_demo', 'chat');

const ridHex = crypto.bytesToHex(dest.hash);
document.getElementById('rid').textContent = ridHex;
console.log('My RID:', ridHex);
console.log('My Public Key:', crypto.bytesToHex(identity.public));

log('system', `Your RID is ${ridHex}`);
log('system', 'Announcing every 10s and connecting to Nostr relays for signaling…');

// Track peers we've received an announce from, keyed by RID hex.
const knownPeers = new Set();

const renderKnownPeers = () => {
  knownCountEl.textContent = knownPeers.size;
  knownPeersEl.innerHTML = '';
  if (knownPeers.size === 0) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'No peers announced yet — waiting for announces…';
    knownPeersEl.appendChild(hint);
    return;
  }
  for (const rid of knownPeers) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'peer-chip';
    chip.textContent = `${rid.slice(0, 12)}…`;
    chip.title = rid;
    chip.onclick = () => {
      destInput.value = rid;
    };
    knownPeersEl.appendChild(chip);
  }
};

rns.on('announce', (announce) => {
  const rid = crypto.bytesToHex(announce.destination_hash);
  if (rid === ridHex || knownPeers.has(rid)) return;
  knownPeers.add(rid);
  log('system', `Announce received from ${rid.slice(0, 12)}…`);
  renderKnownPeers();
});

webrtc.on('peer-connected', () => {
  peerCountEl.textContent = webrtc.dataChannels.size;
  log('system', 'WebRTC link established');
});

webrtc.on('peer-disconnected', () => {
  peerCountEl.textContent = webrtc.dataChannels.size;
  log('system', 'WebRTC link closed');
});

// Handle standard data packets
dest.on('packet', (event) => {
  try {
    const msg = new TextDecoder().decode(event.data);
    log('recv', msg);
  } catch (e) {
    log('recv', '[binary data]');
  }
});

// Handle LXMF messages (kept for interop with an older/different peer that
// still sends this way — this demo's own send() now uses Link/Channel below)
dest.on('lxmf', (lxmf) => {
  const from = crypto.bytesToHex(lxmf.source_hash).slice(0, 12);
  try {
    const msg = new TextDecoder().decode(lxmf.content);
    log('recv', `from ${from}…: ${msg}`);
  } catch (e) {
    log('recv', `from ${from}…: [binary data]`);
  }
});

// A peer establishing a Link to us for chat: wire up its Channel to receive
// CHAT_MSGTYPE messages, and note who it's from once (if) the initiator
// identifies themselves via Link.identify().
dest.on('link', (link) => {
  log('system', 'Incoming chat link established');
  let fromRid = null;
  link.on('remote-identified', (remoteIdentity) => {
    fromRid = crypto.bytesToHex(remoteIdentity.hash).slice(0, 12);
  });
  link.getChannel().addMessageHandler((msgtype, data) => {
    if (msgtype !== CHAT_MSGTYPE) return false;
    try {
      const msg = new TextDecoder().decode(data);
      log('recv', fromRid ? `from ${fromRid}…: ${msg}` : msg);
    } catch (e) {
      log('recv', fromRid ? `from ${fromRid}…: [binary data]` : '[binary data]');
    }
    return true;
  });
});

// Outgoing chat Links, keyed by the recipient's RID hex — established
// lazily on first send to a peer and reused afterward.
const outgoingLinks = new Map();

function getOrCreateChatLink(toHex) {
  const existing = outgoingLinks.get(toHex);
  if (existing && existing.status !== Link.CLOSED) {
    if (existing.status === Link.ACTIVE) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      existing.once('established', () => resolve(existing));
      existing.once('closed', () => reject(new Error('Link closed before it was established')));
    });
  }

  const toHash = crypto.hexToBytes(toHex);
  const outDest = new Destination(rns, identity, Destination.OUT, Destination.SINGLE, 'webrtc_demo', 'chat');
  outDest.hash = toHash;

  const link = new Link(rns, outDest);
  outgoingLinks.set(toHex, link);
  link.on('closed', () => {
    if (outgoingLinks.get(toHex) === link) outgoingLinks.delete(toHex);
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Link establishment timed out')), 15000);
    link.once('established', () => {
      clearTimeout(timer);
      link.identify(identity); // lets the recipient show who this chat is from
      resolve(link);
    });
  });
}

// Periodically announce so others can cache our identity for encryption
setInterval(() => dest.announce(), 10000);
dest.announce();

document.getElementById('copy-rid').onclick = async () => {
  await navigator.clipboard.writeText(ridHex);
  log('system', 'RID copied to clipboard');
};

const send = async () => {
  const toHex = destInput.value.trim();
  const msg = msgInput.value;
  if (!toHex || !msg) return;

  if (!knownPeers.has(toHex)) {
    log('system', `Haven't heard an announce from ${toHex.slice(0, 12)}… yet — re-announcing to prompt them.`);
    dest.announce();
    return;
  }

  msgInput.value = '';
  const payload = new TextEncoder().encode(msg);

  try {
    const link = await getOrCreateChatLink(toHex);
    const channel = link.getChannel();
    while (!channel.isReadyToSend()) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    channel.send(CHAT_MSGTYPE, payload);
    log('sent', `to ${toHex.slice(0, 12)}…: ${msg}`);
  } catch (e) {
    log('system', `Failed to send to ${toHex.slice(0, 12)}…: ${e.message}`);
  }
};

document.getElementById('send').onclick = send;
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send();
});

renderKnownPeers();
