import 'node-datachannel/polyfill';
import { NostrSignaling } from '../shared/nostr-signaling.js';
import { WebRTCInterface } from '../shared/webrtc-rns-interface.js';

export class WebRTCNode extends WebRTCInterface {
    constructor() {
        super("WebRTCNode");
        this.signaling = new NostrSignaling();
        this.k = 4; // Max outgoing connections
        this.outgoingConnections = 0;
        this.makingOffer = false;
        this.ignoreOffer = false;
    }

    async connect() {
        this.signaling.onMessage = async (from, msg) => {
            let pc = this.peers.get(from);

            const polite = this.signaling.publicKey.localeCompare(from) > 0;

            if (msg.type === 'offer') {
                const offerCollision = this.makingOffer || (pc && pc.signalingState !== 'stable');
                this.ignoreOffer = !polite && offerCollision;
                if (this.ignoreOffer) {
                    console.log(`[WebRTC] Ignoring offer from ${from} due to collision (impolite)`);
                    return;
                }

                if (!pc) {
                    pc = this._createPeer(from, false);
                }

                await pc.setRemoteDescription(new global.RTCSessionDescription(msg.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.signaling.send(from, { type: 'answer', answer });
            } else if (msg.type === 'answer') {
                await pc?.setRemoteDescription(new global.RTCSessionDescription(msg.answer));
            } else if (msg.type === 'candidate') {
                try {
                    await pc?.addIceCandidate(new global.RTCIceCandidate(msg.candidate));
                } catch (e) {
                    if (!this.ignoreOffer) console.error("Error adding ICE candidate", e);
                }
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
        this.makingOffer = true;
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.signaling.send(peerPubkey, { type: 'offer', offer });
        } finally {
            this.makingOffer = false;
        }
    }

    _createPeer(id, initiator) {
        const pc = new global.RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
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
