import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip04 } from 'nostr-tools';

export class NostrSignaling {
    constructor(relays = ['wss://relay.damus.io', 'wss://nos.lol']) {
        this.relays = relays;
        this.pool = new SimplePool();
        this.secretKey = generateSecretKey();
        this.publicKey = getPublicKey(this.secretKey);
        this.onMessage = null;
        this.peers = new Set();
    }

    async connect() {
        console.log(`[NostrSignaling] Connecting to Nostr relays. My pubkey: ${this.publicKey}`);
        this.sub = this.pool.subscribeMany(
            this.relays,
            [
                {
                    kinds: [4],
                    '#p': [this.publicKey],
                },
                {
                    kinds: [30000],
                    '#t': ['reticulum-webrtc-mesh'],
                }
            ],
            {
                onevent: async (event) => {
                    if (event.kind === 4) {
                        try {
                            const decrypted = await nip04.decrypt(this.secretKey, event.pubkey, event.content);
                            const msg = JSON.parse(decrypted);
                            if (this.onMessage) {
                                this.onMessage(event.pubkey, msg);
                            }
                        } catch (e) {
                            console.error("Failed to decrypt NIP-04 message", e);
                        }
                    } else if (event.kind === 30000) {
                        if (event.pubkey !== this.publicKey && !this.peers.has(event.pubkey)) {
                            this.peers.add(event.pubkey);
                            if (this.onPeerDiscovered) {
                                this.onPeerDiscovered(event.pubkey);
                            }
                        }
                    }
                },
            }
        );

        this.announce();
        setInterval(() => this.announce(), 60000);
    }

    async announce() {
        const event = {
            kind: 30000,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'reticulum-mesh-node'],
                ['t', 'reticulum-webrtc-mesh']
            ],
            content: '',
        };
        const signedEvent = finalizeEvent(event, this.secretKey);
        this.pool.publish(this.relays, signedEvent);
    }

    async send(toPubkey, msg) {
        const encrypted = await nip04.encrypt(this.secretKey, toPubkey, JSON.stringify(msg));
        const event = {
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', toPubkey]],
            content: encrypted,
        };
        const signedEvent = finalizeEvent(event, this.secretKey);
        this.pool.publish(this.relays, signedEvent);
    }
}
