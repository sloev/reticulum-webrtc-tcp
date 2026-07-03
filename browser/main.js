import { Reticulum, Destination, Identity } from '../shared/rns/index.js';
import { WebRTCBrowser } from './webrtc-browser.js';
import * as crypto from '../shared/rns/crypto.js';

const log = (txt) => {
  document.getElementById('log').value += txt + '\n';
};

const rns = new Reticulum();
const webrtc = new WebRTCBrowser();

rns.addInterface(webrtc);

const identity = Identity.create();
const dest = new Destination(rns, identity, Destination.IN, Destination.SINGLE, "webrtc_demo", "chat");

// Handle standard data packets
dest.on("packet", (event) => {
    try {
        const msg = new TextDecoder().decode(event.data);
        log(`From mesh: ${msg}`);
    } catch(e) {
        log(`From mesh: [Binary Data]`);
    }
});

// Handle LXMF messages
dest.on("lxmf", (lxmf) => {
    try {
        const msg = new TextDecoder().decode(lxmf.content);
        log(`[LXMF] From ${crypto.bytesToHex(lxmf.source_hash).slice(0, 6)}...: ${msg}`);
    } catch(e) {
        log(`[LXMF] [Binary Data]`);
    }
});

const ridHex = crypto.bytesToHex(dest.hash);
document.getElementById('rid').textContent = ridHex;
console.log('My RID:', ridHex);
console.log('My Public Key:', crypto.bytesToHex(identity.public));

// Periodically announce so others can cache our identity for encryption
setInterval(() => dest.announce(), 10000);
dest.announce();

window.send = () => {
  const toHex = document.getElementById('dest').value;
  const msg = document.getElementById('msg').value;

  if (!toHex) return;

  const toHash = crypto.hexToBytes(toHex);
  const outDest = new Destination(rns, identity, Destination.OUT, Destination.SINGLE, "webrtc_demo", "chat");
  outDest.hash = toHash;

  const payload = new TextEncoder().encode(msg);

  const known = rns.identities.get(toHex);
  if (known) {
      // Send as LXMF
      outDest.sendLXMF("Chat", payload);
      log(`Sent LXMF to ${toHex.slice(0, 6)}...: ${msg}`);
  } else {
      // We don't have their pub key, we'll try to broadcast announce
      log(`Waiting for announce from ${toHex.slice(0, 6)}... to send encrypted message.`);
      // Send an announce to prompt them (a real implementation would send a path request)
      dest.announce();
  }
};
