import { Reticulum, Destination, Identity } from '../shared/rns/index.js';
import { WebRTCBrowser } from './webrtc-browser.js';
import * as crypto from '../shared/rns/crypto.js';

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

// Handle LXMF messages
dest.on('lxmf', (lxmf) => {
  const from = crypto.bytesToHex(lxmf.source_hash).slice(0, 12);
  try {
    const msg = new TextDecoder().decode(lxmf.content);
    log('recv', `from ${from}…: ${msg}`);
  } catch (e) {
    log('recv', `from ${from}…: [binary data]`);
  }
});

// Periodically announce so others can cache our identity for encryption
setInterval(() => dest.announce(), 10000);
dest.announce();

document.getElementById('copy-rid').onclick = async () => {
  await navigator.clipboard.writeText(ridHex);
  log('system', 'RID copied to clipboard');
};

const send = () => {
  const toHex = destInput.value.trim();
  const msg = msgInput.value;
  if (!toHex || !msg) return;

  const toHash = crypto.hexToBytes(toHex);
  const outDest = new Destination(rns, identity, Destination.OUT, Destination.SINGLE, 'webrtc_demo', 'chat');
  outDest.hash = toHash;

  const payload = new TextEncoder().encode(msg);

  if (knownPeers.has(toHex)) {
    outDest.sendLXMF(dest, 'Chat', payload);
    log('sent', `to ${toHex.slice(0, 12)}…: ${msg}`);
    msgInput.value = '';
  } else {
    log('system', `Haven't heard an announce from ${toHex.slice(0, 12)}… yet — re-announcing to prompt them.`);
    dest.announce();
  }
};

document.getElementById('send').onclick = send;
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send();
});

renderKnownPeers();
