import { Reticulum, Identity } from '@liamcottle/rns.js';
import { WebRTCNode } from './webrtc-node.js';
import { createTCPGateway } from './tcp-gateway.js';

const rns = new Reticulum();
const webrtc = new WebRTCNode();
rns.addInterface(webrtc);

const identity = Identity.create();
createTCPGateway(4242, rns, identity);
