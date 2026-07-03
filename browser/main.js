import { Reticulum, Destination, Identity } from '@liamcottle/rns.js';
import { WebRTCBrowser } from './webrtc-browser.js';

const log = (txt) => {
  document.getElementById('log').value += txt + '\n';
};

const rns = new Reticulum();
const webrtc = new WebRTCBrowser();

rns.addInterface(webrtc);

const identity = Identity.create();
const dest = rns.registerDestination(identity, Destination.IN, Destination.SINGLE, "webrtc_demo", "chat");

dest.on("packet", (event) => {
    const msg = event.data.toString();
    log(`From ${event.packet.destinationHash.toString('hex').slice(0, 6)}...: ${msg}`);
});

document.getElementById('rid').textContent = dest.hash.toString('hex');
console.log('My RID:', dest.hash.toString('hex'));

window.send = () => {
  const toHex = document.getElementById('dest').value;
  const msg = document.getElementById('msg').value;

  if (!toHex) return;

  const toHash = Buffer.from(toHex, 'hex');
  const payload = Buffer.from(msg);

  // Create an OUT destination to send the packet
  const outDest = rns.registerDestination(null, Destination.OUT, Destination.SINGLE, "webrtc_demo", "chat");
  outDest.hash = toHash; // Hack to set hash since identity is unknown

  outDest.send(payload);
  log(`Sent to ${toHex.slice(0, 6)}...: ${msg}`);
};
