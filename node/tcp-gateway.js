import net from 'net';
import { Interface } from '../shared/rns/index.js';

export class TCPServerInterface extends Interface {
  constructor(port) {
    super(`TCPServerInterface:${port}`);
    this.port = port;
    this.clients = new Set();
  }

  connect() {
    this.server = net.createServer((socket) => {
      this.clients.add(socket);

      socket.on('data', (data) => {
        // TCP interfaces in reticulum send raw frames or packets directly
        // We will pass the raw byte buffer straight into the RNS stack
        if (this.rns) {
           this.rns.onPacketReceived(new Uint8Array(data), this);
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
    // Write out the raw reticulum packet to all TCP clients (bridging)
    const buf = Buffer.from(data);
    for (const socket of this.clients) {
      if (socket.writable) {
        socket.write(buf);
      }
    }
  }
}

export function createTCPGateway(port, rns) {
  const tcpInterface = new TCPServerInterface(port);
  rns.addInterface(tcpInterface);
  return tcpInterface;
}
