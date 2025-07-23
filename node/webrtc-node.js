import wrtc from '@roamhq/wrtc';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

export class WebRTCNode {
  constructor(onData) {
    this.id = uuidv4();
    this.onData = onData;
    this.peers = new Map();
    this.ws = new WebSocket('ws://localhost:8888');

    this.ws.on('message', async (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'welcome') {
        this.id = msg.id;
      } else if (msg.type === 'offer') {
        const pc = this._createPeer(msg.from);
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(msg.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send(msg.from, { type: 'answer', answer });
      } else if (msg.type === 'answer') {
        const pc = this.peers.get(msg.from)?.pc;
        await pc?.setRemoteDescription(new wrtc.RTCSessionDescription(msg.answer));
      } else if (msg.type === 'candidate') {
        const pc = this.peers.get(msg.from)?.pc;
        await pc?.addIceCandidate(new wrtc.RTCIceCandidate(msg.candidate));
      }
    });

    this.ws.on('open', () => console.log('[WebRTCNode] Signaling connected'));
  }

  async connectTo(peerId) {
    const pc = this._createPeer(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._send(peerId, { type: 'offer', offer });
  }

  _createPeer(id) {
    const pc = new wrtc.RTCPeerConnection();
    const dc = pc.createDataChannel('rns');
    dc.onmessage = (e) => this.onData(id, new Uint8Array(e.data));
    dc.onopen = () => console.log('[Peer]', id, 'connected');
    pc.onicecandidate = (e) => {
      if (e.candidate) this._send(id, { type: 'candidate', candidate: e.candidate });
    };
    this.peers.set(id, { pc, dc });
    return pc;
  }

  send(peerId, data) {
    this.peers.get(peerId)?.dc.send(data);
  }

  _send(to, msg) {
    this.ws.send(JSON.stringify({ ...msg, to }));
  }
}