import { Reticulum } from '../shared/rns/index.js';
import { WebRTCNode } from './webrtc-node.js';
import { createTCPGateway } from './tcp-gateway.js';

const rns = new Reticulum();
const webrtc = new WebRTCNode();
rns.addInterface(webrtc);

createTCPGateway(4242, rns);
