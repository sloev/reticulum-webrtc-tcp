import { RNS } from './rns.js';
import { WebRTCBrowser } from './webrtc-browser.js';

const log = (txt) => {
  document.getElementById('log').value += txt + '\n';
};

const rns = new RNS();
const webrtc = new WebRTCBrowser((from, data) => {
  rns.receivePacket(data, from);
});

rns.setInterface({
  sendPacket: (peerId, packet) => webrtc.send(peerId, packet)
});

document.getElementById('rid').textContent = rns.rid;

rns.onReceive = (from, data) => {
  const msg = new TextDecoder().decode(data);
  log(`From ${from.slice(0, 6)}...: ${msg}`);
};

window.send = () => {
  const to = document.getElementById('dest').value;
  const msg = document.getElementById('msg').value;
  rns.sendData(to, msg);
};