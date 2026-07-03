import { Reticulum, Identity } from '../shared/rns/index.js';
import { WebRTCNode } from './webrtc-node.js';
import { createTCPGateway } from './tcp-gateway.js';

const rns = new Reticulum();
const webrtc = new WebRTCNode();
rns.addInterface(webrtc);

// Identity is not strictly needed for the TCP bridge interface itself, as it just passes raw bytes
// But we can create one if we wanted the Node.js peer to also announce itself
const identity = Identity.create();

createTCPGateway(4242, rns);
