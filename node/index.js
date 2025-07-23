import { WebRTCNode } from './webrtc-node.js';
import { RNS } from '../browser/rns.js';
import { createTCPGateway } from './tcp-gateway.js';

const rns = new RNS();
const webrtc = new WebRTCNode((from, data) => {
  rns.receivePacket(data, from);
});

rns.setInterface({
  sendPacket: (peerId, packet) => webrtc.send(peerId, packet)
});

createTCPGateway(4242, rns);