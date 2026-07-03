import polyfill from 'node-datachannel/polyfill';
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = polyfill;

import { NostrSignaling } from '../shared/nostr-signaling.js';
import { WebRTCInterface } from '../shared/webrtc-rns-interface.js';

export class WebRTCNode extends WebRTCInterface {
    constructor() {
        super("WebRTCNode");
        this.signaling = new NostrSignaling();
        this.k = 4; // Max outgoing connections
        this.outgoingConnections = 0;
    }

    async connect() {
        this.signaling.onMessage = async (from, msg) => {
            if (msg.type === 'offer') {
                const pc = this._createPeer(from, false);
                await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.signaling.send(from, { type: 'answer', answer });
            } else if (msg.type === 'answer') {
                const pc = this.peers.get(from);
                await pc?.setRemoteDescription(new RTCSessionDescription(msg.answer));
            } else if (msg.type === 'candidate') {
                const pc = this.peers.get(from);
                await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate));
            }
        };

        this.signaling.onPeerDiscovered = async (peerPubkey) => {
            if (this.outgoingConnections < this.k && !this.peers.has(peerPubkey)) {
                this.outgoingConnections++;
                this.connectTo(peerPubkey);
            }
        };

        await this.signaling.connect();
    }

    async connectTo(peerPubkey) {
        const pc = this._createPeer(peerPubkey, true);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signaling.send(peerPubkey, { type: 'offer', offer });
    }

    _createPeer(id, initiator) {
        const pc = new RTCPeerConnection();
        let dc;

        if (initiator) {
            dc = pc.createDataChannel('rns');
            dc.onopen = () => {
                console.log('[Node] Link to', id);
                this.addPeer(id, pc, dc);
            };
        } else {
            pc.ondatachannel = (event) => {
                dc = event.channel;
                dc.onopen = () => {
                    console.log('[Node] Link to', id);
                    this.addPeer(id, pc, dc);
                };
            };
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) this.signaling.send(id, { type: 'candidate', candidate: e.candidate });
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                if (initiator) this.outgoingConnections--;
                this.peers.delete(id);
                this.dataChannels.delete(id);
            }
        };

        this.peers.set(id, pc);
        return pc;
    }
}
