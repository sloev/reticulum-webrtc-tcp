export class WebRTCBrowser {
  constructor(onData) {
    this.id = null;
    this.onData = onData;
    this.peers = new Map();
    this.ws = new WebSocket('ws://localhost:8888');

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'welcome') {
        this.id = msg.id;
      } else if (msg.type === 'offer') {
        const pc = this._createPeer(msg.from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send(msg.from, { type: 'answer', answer });
      } else if (msg.type === 'answer') {
        const pc = this.peers.get(msg.from)?.pc;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
      } else if (msg.type === 'candidate') {
        const pc = this.peers.get(msg.from)?.pc;
        await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    };

    this.ws.onopen = () => console.log('[WebRTC] Connected to signaling');
  }

  async connectTo(peerId) {
    const pc = this._createPeer(peerId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._send(peerId, { type: 'offer', offer });
  }

  _createPeer(id, initiator) {
    const pc = new RTCPeerConnection();
    let dc;

    if (initiator) {
      dc = pc.createDataChannel('rns');
      dc.onopen = () => console.log('[Browser] Link to', id);
      dc.onmessage = (e) => this.onData(id, new Uint8Array(e.data));
    } else {
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.onmessage = (e) => this.onData(id, new Uint8Array(e.data));
      };
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this._send(id, { type: 'candidate', candidate: e.candidate });
    };

    this.peers.set(id, { pc, dc });
    return pc;
  }

  send(peerId, data) {
    this.peers.get(peerId)?.dc?.send(data);
  }

  _send(to, msg) {
    this.ws.send(JSON.stringify({ ...msg, to }));
  }
}