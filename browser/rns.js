import sodium from 'libsodium-wrappers';
import { v4 as uuidv4 } from 'uuid';

export class RNS {
  constructor() {
    this.routingTable = new Map(); // peerId => { rid, key, lastSeen }
    this.links = new Map(); // rid => peerId
    this.k = 4;

    this.ready = this.init();
  }

  async init() {
    await sodium.ready;
    const keypair = sodium.crypto_sign_keypair();
    this.secretKey = keypair.privateKey;
    this.publicKey = keypair.publicKey;
    this.rid = sodium.crypto_generichash(20, this.publicKey).toString('hex');
  }

  setInterface({ sendPacket }) {
    this.sendPacket = sendPacket;
  }

  receivePacket(packet, fromPeer) {
    const type = packet[0];

    if (type === 0x01) {
      // Link request
      const peerPub = packet.slice(1, 33);
      const nonce = packet.slice(33, 57);
      const rid = sodium.crypto_generichash(20, peerPub).toString('hex');
      const shared = sodium.crypto_scalarmult(this.secretKey.slice(0, 32), peerPub);
      const encrypted = sodium.crypto_secretbox_easy(this.publicKey, nonce, shared);

      this.links.set(rid, fromPeer);
      this.routingTable.set(fromPeer, { rid, key: shared, lastSeen: Date.now() });

      this.sendPacket(fromPeer, new Uint8Array([
        0x02,
        ...this.publicKey,
        ...nonce,
        ...encrypted
      ]));
    }

    else if (type === 0x02) {
      // Link proof
      const peerPub = packet.slice(1, 33);
      const nonce = packet.slice(33, 57);
      const encrypted = packet.slice(57);
      const rid = sodium.crypto_generichash(20, peerPub).toString('hex');
      const shared = sodium.crypto_scalarmult(this.secretKey.slice(0, 32), peerPub);
      const plain = sodium.crypto_secretbox_open_easy(encrypted, nonce, shared);

      this.links.set(rid, fromPeer);
      this.routingTable.set(fromPeer, { rid, key: shared, lastSeen: Date.now() });
    }

    else if (type === 0x04) {
      // LXMF message
      const rid = packet.slice(1, 21).toString('hex');
      const nonce = packet.slice(21, 45);
      const ciphertext = packet.slice(45);

      const entry = this.routingTable.get(fromPeer);
      if (!entry) return;
      const shared = entry.key;
      const plain = sodium.crypto_secretbox_open_easy(ciphertext, nonce, shared);
      if (this.onReceive) this.onReceive(rid, plain);
    }
  }

  sendData(destRid, data) {
    const peerId = this.links.get(destRid);
    if (!peerId) {
      console.warn('[RNS] No route to', destRid);
      return;
    }

    const entry = this.routingTable.get(peerId);
    if (!entry) return;

    const nonce = sodium.randombytes_buf(24);
    const msg = new TextEncoder().encode(data);
    const encrypted = sodium.crypto_secretbox_easy(msg, nonce, entry.key);

    const packet = new Uint8Array([
      0x04,
      ...sodium.from_hex(destRid),
      ...nonce,
      ...encrypted
    ]);

    this.sendPacket(peerId, packet);
  }

  connect(peerId) {
    const nonce = sodium.randombytes_buf(24);
    const packet = new Uint8Array([
      0x01,
      ...this.publicKey,
      ...nonce
    ]);

    this.sendPacket(peerId, packet);
  }
}