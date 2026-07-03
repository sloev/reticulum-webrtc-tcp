import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip04 } from 'nostr-tools';

export class NostrSignaling {
    constructor(relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://nostr.mom']) {
        this.relays = relays;
        this.pool = new SimplePool();
        this.secretKey = generateSecretKey();
        this.publicKey = getPublicKey(this.secretKey);
        this.onMessage = null;
        this.peers = new Set();
    }

    async connect() {
        console.log(`[NostrSignaling] Connecting to Nostr relays. My pubkey: ${this.publicKey}`);

        // SimplePool.subscribeMany() takes a single Filter object, not an array of
        // filters — passing an array here silently produces a malformed REQ that
        // never matches anything, so direct messages and announces need separate
        // subscriptions.
        const onDirectMessage = async (event) => {
            try {
                const decrypted = await nip04.decrypt(this.secretKey, event.pubkey, event.content);
                const msg = JSON.parse(decrypted);
                if (this.onMessage) {
                    this.onMessage(event.pubkey, msg);
                }
            } catch (e) {
                console.error("Failed to decrypt NIP-04 message", e);
            }
        };

        const onAnnounce = (event) => {
            if (event.pubkey !== this.publicKey && !this.peers.has(event.pubkey)) {
                this.peers.add(event.pubkey);
                if (this.onPeerDiscovered) {
                    this.onPeerDiscovered(event.pubkey);
                }
            }
        };

        this.dmSub = this.pool.subscribeMany(
            this.relays,
            { kinds: [4], '#p': [this.publicKey] },
            { onevent: onDirectMessage }
        );

        this.announceSub = this.pool.subscribeMany(
            this.relays,
            { kinds: [30000], '#t': ['reticulum-webrtc-mesh'] },
            { onevent: onAnnounce }
        );

        this.announce();
        setInterval(() => this.announce(), 60000);
    }

    // pool.publish() returns one promise per relay; a relay rejecting (e.g. rate
    // limiting) must not become an unhandled rejection as long as at least one
    // relay accepts the event.
    _publish(signedEvent) {
        for (const result of this.pool.publish(this.relays, signedEvent)) {
            result.catch((e) => console.warn('[NostrSignaling] Relay rejected event:', e?.message || e));
        }
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
        this._publish(signedEvent);
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
        this._publish(signedEvent);
    }
}
