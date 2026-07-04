import net from 'net';
import { Interface } from '../shared/rns/index.js';
import { hdlcFrame, HdlcFrameDecoder } from './hdlc.js';

// Matches RNS.Reticulum.HEADER_MINSIZE (2 + 1 + 16 bytes): TCPInterface silently
// drops frames at or below this size rather than passing them on.
const HEADER_MINSIZE = 19;

export class TCPServerInterface extends Interface {
  constructor(port) {
    super(`TCPServerInterface:${port}`);
    this.port = port;
    this.clients = new Set();
  }

  connect() {
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      const decoder = new HdlcFrameDecoder();

      socket.on('data', (data) => {
        if (!this.rns) return;
        for (const frame of decoder.push(data)) {
          if (frame.length > HEADER_MINSIZE) {
            this.rns.onPacketReceived(new Uint8Array(frame), this, socket);
          }
        }
      });

      socket.on('error', (err) => {
        console.error(`[TCPServerInterface] Socket error:`, err);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.port, () => {
      console.log(`[TCPServerInterface] Listening on port ${this.port}`);
    });
  }

  sendData(data) {
    // Frame each outgoing packet HDLC-style, matching TCPInterface, so a real
    // Reticulum node's TCP interface (or this gateway itself) can find frame
    // boundaries in the byte stream.
    const framed = hdlcFrame(Buffer.from(data));
    for (const socket of this.clients) {
      if (socket.writable) {
        socket.write(framed);
      }
    }
  }

  // peerId is the specific client socket a packet should be forwarded to,
  // for point-to-point next-hop forwarding (see Reticulum._forward()).
  sendDataToPeer(peerId, data) {
    if (peerId && peerId.writable) {
      peerId.write(hdlcFrame(Buffer.from(data)));
    }
  }
}

export function createTCPGateway(port, rns) {
  const tcpInterface = new TCPServerInterface(port);
  rns.addInterface(tcpInterface);
  return tcpInterface;
}
