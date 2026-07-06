# Compliance execution plan: full RNS/LXMF parity

A stepped, self-contained execution plan for closing every gap documented in
[README#compliance](./README.md#compliance), ending in a fully compliant JavaScript
port of the Reticulum Network Stack (`rns` 1.3.7) and LXMF (`lxmf` 1.0.1). It doubles
as the living **feature parity checklist**: every feature, with a reference to where it
lives in the real Python source and where it lives (or will live) here.

This document is written to be executed by Claude (or any contributor) one phase at a
time, in order. Update the checklist row and the README's Compliance section as part of
completing each step — a step is not done until both say so.

## Ground rules

**Reference sources.** Everything is verified against the real packages, never from
memory:

```bash
pip install --target=/path/to/pylibs rns==1.3.7 lxmf==1.0.1
```

Read the Python source in `pylibs/RNS/` and `pylibs/LXMF/` (or unzip the wheels).
Every step below starts by reading the referenced Python code, porting constants and
algorithms exactly, and only then implementing.

**Verification ladder.** In order of preference, each feature gets:

1. **Byte-exact unit tests** (`test/rns-compliance.test.js`, `test/lxmf-compliance.test.js`)
   whenever a wire format is involved — ground-truth bytes captured from the real
   Python package with a fixed identity/timestamp.
2. **Live cross-language checks** (`test-integration/*-cross-language-check.mjs`) that
   spawn a real Python `rns`/`lxmf` process over real TCP:
   `PYLIBS=/path/to/pylibs npm run test:integration:<name>`. Re-run 2–3× — live checks
   involving proof-of-work or timing have real variance.
3. **Full regression** before every commit: `npm test`, `npx vite build`, and the
   existing integration checks touching the changed layer
   (`test:integration:resource`, `:channel`, `:lxmf`, `:lxmf-propagation`,
   `:lxmf-peer-sync`, `:integration` for the sparse mesh).

**Process.** After each completed step: update this file's checklist row, update the
README Compliance section, commit with a descriptive message, push. Never open a PR
unless the user asks. Never claim a step done without the verification it names.

**Sandbox notes.** Public Nostr relays are blocked by the environment's egress proxy —
browser-demo verification uses an in-page loopback `Interface` bridging two `Reticulum`
instances, driven by Playwright (`/opt/pw-browsers/chromium`,
`import ... from '/opt/node22/lib/node_modules/playwright/index.mjs'`). `pip` works
through the proxy.

## Feature parity checklist

Status: **DONE** (implemented + verified) · **PARTIAL** (implemented with documented
deviations) · **MISSING** (not implemented) · **N/A** (deliberately out of scope, with
reason).

### Core wire format & identity

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Packet framing (flags/hops/dest/context) | `RNS/Packet.py` `Packet.pack()/unpack()` | `shared/rns/protocol.js` `packet_pack/packet_unpack` | DONE | byte-exact tests |
| Identity & destination hashing | `RNS/Identity.py` `full_hash/truncated_hash`, `RNS/Destination.py` `expand_name/hash` | `shared/rns/protocol.js` `identity_hash/destination_hash` | DONE | byte-exact tests |
| Announces (ratchet, random_hash, Ed25519 sig) | `RNS/Destination.py` `announce()`, `RNS/Identity.py` `validate_announce()` | `shared/rns/protocol.js` `build_announce/validate_announce` | DONE | byte-exact tests |
| Single-destination encryption (ratchet + fallback) | `RNS/Identity.py` `encrypt()/decrypt()` | `shared/rns/protocol.js` `build_data/message_decrypt` | DONE | byte-exact tests |
| Packet delivery proofs (implicit form) | `RNS/Packet.py` `prove()`, `PacketReceipt.validate_proof()` | `shared/rns/protocol.js` `build_packet_proof/validate_packet_proof` | DONE | byte-exact tests |
| MessagePack byte-compat with `umsgpack` | `RNS/vendor/umsgpack.py` | `shared/rns/msgpack.js` | DONE | byte-exact tests |
| HDLC TCP framing | `RNS/Interfaces/TCPInterface.py` `HDLC` | `node/hdlc.js` | DONE | byte-exact tests |

### Link

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Handshake (LINKREQUEST/PROOF/LRRTT), Token encryption, LINKCLOSE | `RNS/Link.py` | `shared/rns/index.js` `Link`, `shared/rns/protocol.js` | DONE | byte-exact + live |
| `identify()` / `get_remote_identity()` | `RNS/Link.py` `identify()` | `shared/rns/index.js` `Link.identify/getRemoteIdentity` | DONE | live vs real `LXMRouter` |
| Request/Response (single-packet) | `RNS/Link.py` `request()`, `RNS/Destination.py` `register_request_handler()` | `shared/rns/index.js` `Link.request`, `Destination.registerRequestHandler` | DONE | byte-exact + live |
| RTT-adaptive keepalive/stale/timeout state machine | `RNS/Link.py:75–108` (constants), `__watchdog_job` (:710–775), `__update_keepalive` (:794) | `shared/rns/index.js` `Link._watchdogTick/_updateKeepalive/_noteInbound` | DONE | unit tests (formula + STALE transition/recovery/teardown) + live (`test:integration:resource/:channel/:lxmf-propagation/:lxmf-peer-sync` re-verified) |
| Hop-scaled establishment timeout | `RNS/Link.py:75,206,284` (`ESTABLISHMENT_TIMEOUT_PER_HOP=6`) | `shared/rns/index.js` `Link` constructor/`fromRequest` | DONE | live (established links across the existing integration suite) |
| Request/Response Resource fallback (oversized payloads) | `RNS/Link.py:506` (request), `:844–850` (response) | `shared/rns/index.js` `Link.request/_handleRequest` | DONE | `test:integration:lxmf-propagation` (real `LXMRouter` `/get` fallback), unit |

### Resource / Channel / Buffer

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Resource send/receive, part hashmap, completion proof | `RNS/Resource.py` | `shared/rns/index.js` `Link.sendResource` + `shared/rns/protocol.js` | DONE | byte-exact + live both directions |
| Multi-segment transfers (send) | `RNS/Resource.py:274–310` | `shared/rns/index.js` `_sendResourceSegment` | DONE | live (real peer reassembles) |
| Incoming bz2 decompression | `RNS/Resource.py` assemble | `shared/rns/compression.js` `bz2_decompress` | DONE | live (real compressed data) |
| Rate-adaptive request window | `RNS/Resource.py:58–99` (`WINDOW=4, WINDOW_MIN=2, WINDOW_MAX_SLOW=10, WINDOW_MAX_FAST=75, WINDOW_FLEXIBILITY=4, RATE_FAST=(50*1000)/8, RATE_VERY_SLOW=(2*1000)/8`), ramp at `:900–924` | `shared/rns/index.js` `Link._growResourceWindow/_requestNextResourceParts` | PARTIAL — growth + fast/very-slow-rate window_max promotion/demotion implemented; retry-driven shrinking not (no per-part retry/timeout mechanism exists) | unit test (window grows over multiple rounds, monotonic) + live (`test:integration:resource` re-verified, incl. a real `RNS.Resource` sender's ~180KB multi-segment transfer) |
| Outgoing bz2 compression | `RNS/Resource.py` (compress-if-beneficial policy, :384-421, `AUTO_COMPRESS_MAX_SIZE=64MiB` :124,364) | `shared/rns/compression.js` `bz2_compress/bz2_compress_if_beneficial`, wired into `Link._sendResourceSegment` (Resource) and `buffer.js`'s `RawChannelWriter.write` (Buffer, per-chunk) | DONE | byte-exact (matches real `bz2.compress()` output exactly) + live (`test:integration:resource`/`:channel`: real `RNS.Resource`/`RNS.Buffer` explicitly report `compressed=True`) + real headless-Chromium production-build test |
| HMU (hashmap update) receive path, large single segments | `RNS/Resource.py:483–499` `hashmap_update_packet`, `HASHMAP_IS_EXHAUSTED=0xFF` (:140), `:953–960` | `shared/rns/index.js` `Link._onHashmapUpdate/_requestNextResourceParts`, `shared/rns/protocol.js` `build/parse_resource_hmu`, `RESOURCE_HASHMAP_MAX_LEN` | DONE — receive side only (this project's own sender still never truncates its hashmap, so it never needs to *send* HMU) | unit tests (wire round-trip + a hand-built truncated-advertisement transfer) + live (`test:integration:resource`: a real 40000-byte/~87-part `RNS.Resource` transfer, which a real sender truncates past `RESOURCE_HASHMAP_MAX_LEN`=74 entries, completes correctly via a genuine HMU exchange) |
| Channel (envelope, proofs, RTT-adaptive send window) | `RNS/Channel.py` | `shared/rns/channel.js` | DONE | byte-exact + live both directions |
| Buffer (stream reader/writer, compressed chunks) | `RNS/Buffer.py` | `shared/rns/buffer.js` | DONE | live both directions |

### Transport / routing

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Path requests/responses (wire format) | `RNS/Transport.py` `request_path/path_request_handler` (:2799–2939) | `shared/rns/index.js` `requestPath/_handlePathRequest` | DONE | byte-exact + live |
| Multi-hop DATA/PROOF forwarding | `RNS/Transport.py` inbound/outbound | `shared/rns/index.js` `_forward` | PARTIAL — simplified single-destination analog | functional 3-peer test |
| Multi-hop Link relaying (link table) | `RNS/Transport.py` link_table | `shared/rns/index.js` `_forwardLinkRequest/_forwardLinkTraffic` | DONE (functional) | 3-peer relay test |
| Path-request throttling (`PATH_REQUEST_MI`) & table expiry (`DESTINATION_TIMEOUT`) | `RNS/Transport.py:83,91,2839` | `shared/rns/index.js` `Reticulum.requestPath/_cleanupPathTable` | DONE | unit + live `test:integration:path-request` |
| Transport instance identity + 3-field path requests | `RNS/Transport.py:2811` (`dest+transport_identity.hash+tag`) | `shared/rns/index.js` `Reticulum.transportIdentity`, `protocol.js` `build_path_request` | DONE | byte-exact + live `test:integration:path-request` |
| Announce rate table (timestamps, `MAX_RATE_TIMESTAMPS`) | `RNS/Transport.py:96,1890–1911` | `shared/rns/index.js` `Reticulum.announceRateTable` | PARTIAL — mechanism ported, enforcement not (matches RNS's own default-off `announce_rate_target`) | unit |
| Path-request rebroadcast grace (`PATH_REQUEST_GRACE/RG`) & `LOCAL_REBROADCASTS_MAX` | `RNS/Transport.py:77,81–82,3012–3028` | — | SCOPED OUT | see Phase 4 writeup |

### LXMF

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Message envelope + signature (OPPORTUNISTIC) | `LXMF/LXMessage.py` `pack()` | `shared/rns/protocol.js` `lxmf_build/lxmf_parse` | DONE | byte-exact + live both directions |
| Admission stamps (message) | `LXMF/LXStamper.py` | `shared/rns/stamp.js` | DONE | byte-exact + live |
| Peering-key stamps | `LXMF/LXStamper.py` `generate_peering_key` | `shared/rns/stamp.js` `generate/validate_peering_key` | DONE | byte-exact + live |
| Propagation node store & client sync (`/get`) | `LXMF/LXMRouter.py` `message_get_request` | `shared/rns/propagation.js` `PropagationNode`, `syncFromRealPropagationNode` | DONE | live (upload + download vs real node) |
| Node-to-node peer sync (`/offer`) | `LXMF/LXMPeer.py`, `LXMRouter.offer_request` | `shared/rns/propagation.js` `syncToPeer/_onOfferRequest` | DONE | live (real node accepts + stores) |
| DIRECT delivery (over a Link; packet or Resource) | `LXMF/LXMessage.py:30–34` (methods), `:355–460` (`pack`), `:626–654` (`__as_packet`/`__as_resource`) | `shared/rns/protocol.js` `lxmf_build_direct/lxmf_parse_direct`, `shared/rns/index.js` `Link.sendLXMF` | DONE | byte-exact + live `test:integration:lxmf` (both directions, both representations) |
| Delivery announce app_data (`[display_name, stamp_cost, [SF_COMPRESSION]]`) | `LXMF/LXMRouter.py:985–1000` `get_announce_app_data`, `LXMF/LXMF.py:174` `stamp_cost_from_app_data` | `shared/rns/protocol.js` `lxmf_build_announce_app_data/lxmf_stamp_cost_from_app_data` | DONE | byte-exact |
| Compression negotiation (`SF_COMPRESSION` → `auto_compress`) | `LXMF/LXMessage.py:510–517` `determine_compression_support` | `shared/rns/protocol.js` `lxmf_compression_supported`, `shared/rns/index.js` `Link.sendLXMF` | DONE | unit + live `test:integration:lxmf` |
| Propagation-node announce app_data (7-element list) | `LXMF/LXMRouter.py:300–318` `get_propagation_node_app_data`, `LXMF/LXMF.py:224` `pn_announce_data_is_valid` | `shared/rns/protocol.js` `lxmf_build_propagation_announce_app_data/lxmf_parse_propagation_announce_app_data` | DONE | byte-exact + live (`propagateLXMF`/`syncToPeer` auto-detect from a real `LXMRouter`'s own announce) |
| Interop with end-user clients (NomadNet, Sideband) | n/a | — | UNTESTED | **Phase 6** |
| PAPER delivery method (QR-encoded messages) | `LXMF/LXMessage.py:33,446–456` | — | N/A — no meaningful use over WebRTC/TCP; revisit on request | — |

### Persistence & environment

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Browser demo identity persistence | n/a (environment adaptation) | `browser/main.js` `loadOrCreateIdentity` (sessionStorage) | DONE | Playwright (reload keeps RID, new tab differs) |
| Known-destinations / identity-cache persistence | `RNS/Identity.py:101–260` `remember/recall/save_known_destinations` | — (in-memory `Reticulum.identities`) | MISSING | **Phase 7** |
| Ratchet rotation & persistence | `RNS/Destination.py:210–243` `rotate_ratchets` | — (single static ratchet) | MISSING | **Phase 7** |
| Propagation store persistence | `LXMF/LXMRouter.py` storagepath handling | — (in-memory `PropagationNode.messages`) | MISSING | **Phase 7** |
| IFAC (interface access codes) | `RNS/Interfaces/Interface.py` | — | N/A — private-network access control for shared physical media; revisit on request | — |
| Radio/serial interfaces (RNode, LoRa, I2P, …) | `RNS/Interfaces/*` | `shared/webrtc-rns-interface.js`, `node/tcp-gateway.js` | N/A — this project's transports are WebRTC + TCP by design | — |

## Execution phases

Work strictly in order; each phase ends with the full regression suite green, this
checklist updated, README updated, and a commit.

### Phase 0 — housekeeping ✅

Commit the verified sessionStorage identity persistence (`browser/main.js`,
`browser/index.html`). Done: commit `b3f95fe`.

### Phase 1 — Link timing parity ✅

Goal: replace the fixed 15 s establishment / 30 s keepalive timers with real RNS's
state machine. **Done.**

What was implemented, in `shared/rns/index.js`'s `Link`:

- Added `STALE = 3` (RNS values 0/1/2/4 already matched); ported constants
  `KEEPALIVE_MAX=360, KEEPALIVE_MIN=5, KEEPALIVE_MAX_RTT=1.75, STALE_FACTOR=2,
  STALE_GRACE=5, KEEPALIVE_TIMEOUT_FACTOR=4, DEFAULT_PER_HOP_TIMEOUT=6,
  ESTABLISHMENT_TIMEOUT_PER_HOP=6` (seconds, matching `RNS/Link.py:75–108`;
  converted to ms at point of use).
- Replaced `_startKeepalive`/`_armEstablishmentTimeout` (fixed `setInterval`/
  `setTimeout`) with a single rescheduling watchdog (`_watchdogTick`, chained
  `setTimeout`, since JS has no per-link thread to poll on a fixed cadence the way
  `__watchdog_job` does — the next check is instead recomputed and rescheduled
  whenever something that affects it changes): PENDING/HANDSHAKE → establishment
  timeout (initiator: `DEFAULT_PER_HOP_TIMEOUT + ESTABLISHMENT_TIMEOUT_PER_HOP ×
  max(1, hops)`, hops from the path table, matching `Link.py:283–284`; responder:
  `ESTABLISHMENT_TIMEOUT_PER_HOP × max(1, request.hops) + KEEPALIVE_MAX`, matching
  `Link.py:206`, which is deliberately generous since the responder must tolerate
  however long the initiator takes to receive the PROOF and reply). ACTIVE →
  initiator sends a keepalive when idle ≥ `keepalive`, transitions to STALE when
  idle ≥ `stale_time`, then tears down with reason `TIMEOUT` after `rtt ×
  KEEPALIVE_TIMEOUT_FACTOR + STALE_GRACE`; any inbound while STALE recovers to
  ACTIVE (`_noteInbound()`, called from `onPacket`/`onProof`).
- `_updateKeepalive()`: `keepalive = clamp(rtt × KEEPALIVE_MAX/KEEPALIVE_MAX_RTT,
  KEEPALIVE_MIN, KEEPALIVE_MAX)`, `stale_time = keepalive × STALE_FACTOR` — run once
  RTT is known on both sides (`_activateWatchdog()`, called from the initiator's
  PROOF handler and the responder's LRRTT handler).
- `_teardown()` now also rejects any pending `Link.request()` calls (a pre-existing
  gap — it only cleaned up outgoing resources before), so a torn-down link fails
  fast instead of hanging until a request's own timeout fires.
- **Real bug found and fixed along the way**: `stamp.generate_stamp()`
  (`shared/rns/stamp.js`) was a tight synchronous proof-of-work loop with no
  yielding. That was harmless under the old fixed-interval keepalive, but once
  Link's keepalive is *correctly* short for a fast connection (5–10s), a long
  synchronous stamp computation (this project's LXMF admission/peering-key stamps)
  starves the event loop long enough that a real peer's own — already-compliant,
  unmodified — stale/timeout logic can legitimately close the link out from under
  it. Real `LXStamper` doesn't have this problem because it searches in separate OS
  processes. Fixed by making `generate_stamp()`/`generate_peering_key()` `async`
  and yielding every ~15ms of wall time (`propagateLXMF()`/`syncToPeer()` in
  `propagation.js` updated to `await` them) — confirmed with a peer-sync run that
  took 24 s to compute a peering key and still completed successfully.

Tests: unit (`test/rns-compliance.test.js`) — keepalive-formula vectors at the
MIN/MAX/interpolated RTT points; STALE transition, STALE→ACTIVE recovery on
inbound, and teardown-with-reason-TIMEOUT, all driven directly via `_watchdogTick()`/
`_noteInbound()` with back-dated timestamps rather than real waiting (keeps the
tests fast — real keepalive/stale timing has a 15s floor). Live — `test:integration:
resource`, `:channel`, `:lxmf-propagation`, and `:lxmf-peer-sync` all re-verified
against real `rns`/`lxmf` (the peer-sync check in particular now reliably survives
a multi-second synchronous PoW computation without the real node closing the link).

Done when: fixed-interval constants are gone, all tests green, checklist + README rows
updated.

### Phase 2 — Resource parity

**2.1 Rate-adaptive window. ✅ Done (growth half; retry-shrink still open).**
Implemented in `shared/rns/index.js`'s `Link._growResourceWindow()`/
`_requestNextResourceParts()`/`_onResourcePart()`: each incoming Resource tracks its own
`window` (starts at `RESOURCE_WINDOW=4`), `windowMax` (starts at
`RESOURCE_WINDOW_MAX_SLOW=10`), `windowMin` (`RESOURCE_WINDOW_MIN=2`), and per-round byte/
time counters. On each fully-satisfied request round: `window` grows by 1 while `window <
windowMax` (with `windowMin` creeping up once the gap exceeds `RESOURCE_WINDOW_FLEXIBILITY`,
matching `Resource.py:900-903`); the round's throughput (`bytes received this round / round
duration`) is compared against `RESOURCE_RATE_FAST`/`RESOURCE_RATE_VERY_SLOW` to promote
`windowMax` to `RESOURCE_WINDOW_MAX_FAST=75` after `RESOURCE_FAST_RATE_THRESHOLD` consecutive
fast rounds, or demote it to `RESOURCE_WINDOW_MAX_VERY_SLOW=4` after
`RESOURCE_VERY_SLOW_RATE_THRESHOLD` consecutive very-slow ones (`Resource.py:914-924`).
Constants live in `shared/rns/protocol.js`.

**Not implemented, and intentionally out of scope for this step**: retry-driven window
*shrinking* (`Resource.py:612-621`) and the part-timeout/retry mechanism it depends on
(`PART_TIMEOUT_FACTOR=4`, `_AFTER_RTT=2`, `MAX_RETRIES=16`, `MAX_ADV_RETRIES=4`) — this
project's Resource receiver has no per-part timeout/retry at all yet (it relies on the
outer `sendResource()`-level timeout only), so there's nothing for a shrink to attach to.
Adding that is a distinct, separable piece of work from window growth; revisit as its own
step if real-world packet loss on WebRTC/TCP ever makes it worth doing (it doesn't affect
interop — a real peer doesn't care how the receiver paces its own requests).

Verified: unit test (`test/rns-compliance.test.js`) sends a 30-part payload and asserts the
observed window sequence is monotonically non-decreasing and exceeds the initial window of
4. Live: `test:integration:resource` re-verified in both directions, including a real
`RNS.Resource` sender's ~180KB multi-segment transfer to our (window-adaptive) receiver.

**2.2 Outgoing bz2 compression. ✅ Done.**

`compressjs` (the obvious pure-JS bzip2 encoder, same author as `seek-bzip`) turned out to
be GPL-licensed — bundling it would attach copyleft obligations to this project's
MIT-licensed browser bundle, so it was rejected on licensing grounds rather than technical
ones. Used `bzip2-wasm` instead: a WebAssembly build of the actual reference `libbzip2` C
library (the same one Python's `bz2` module wraps), under `libbzip2`'s own permissive
BSD-style license. Being the real reference implementation rather than an independent
reimplementation, its output isn't just *a* valid bz2 stream — it's byte-identical to what
`bz2.compress()` itself produces for the same input (verified directly).

Implemented in `shared/rns/compression.js`: `bz2_compress()` (sizes the output buffer to
libbzip2's own documented worst-case bound — its own default guess of `input.length` isn't
big enough for incompressible data and throws `BZ_OUTBUFF_FULL`, which is what actually
happened first) and `bz2_compress_if_beneficial()`, matching `RNS.Resource`'s exact policy
(`Resource.py:384-421`): always attempt compression up to `AUTO_COMPRESS_MAX_SIZE` (64MiB),
use the compressed bytes only if they're smaller. Wired into `Link._sendResourceSegment()`
(Resource — the resource's hash/proof/`dataSize` are always computed over the *original*
uncompressed plaintext, matching real RNS, since compression is transparent to the
resource's own identity) and `buffer.js`'s `RawChannelWriter.write()` (Buffer, per chunk —
this made `write()` async, so its two callers now `await` it; its return value is still the
count of *uncompressed* input bytes consumed, matching real RNS's contract for offset
tracking). The advertisement/`StreamDataMessage` compressed bit (already parsed on receive)
is now also set on send.

**Known caveat, environment-specific, not a compliance gap**: `bzip2-wasm`'s Emscripten
glue resolves its `.wasm` file relative to its own script location, which doesn't survive
Vite's dev-server dependency pre-bundling cleanly in every case (`optimizeDeps.exclude:
['bzip2-wasm']` in `vite.config.js` was added to help). This doesn't affect the deployed
demo — the demo's chat UI never calls `sendResource()`/`Buffer` at all, and the actual
*production* build (`vite build`, what's deployed to GitHub Pages) was verified working
end-to-end in real headless Chromium (compress, decompress, and the incompressible-data
fallback all correct). It would only matter for a consumer directly exercising
Resource/Buffer from browser code under `vite dev`-style tooling.

Verified: byte-exact unit test (`bz2_compress()` output matches real `bz2.compress(data,
9)` for a fixed input) and a compressible-vs-incompressible decision test
(`test/compression.test.js`); live — `test:integration:resource` (real `RNS.Resource`
explicitly reports `compressed=True` for a compressible JS-sent transfer and `False` for a
high-entropy one) and `test:integration:channel` (real `RNS.Buffer` correctly reassembles a
compressed JS-sent stream); a real headless-Chromium session running the actual
`vite build` production bundle.

**2.3 HMU receive path. ✅ Done (receive side).**

Implemented in `shared/rns/protocol.js` (`CONTEXT_RESOURCE_HMU=0x04`, `RESOURCE_HASHMAP_MAX_LEN
= floor((LINK_MDU-134)/RESOURCE_MAPHASH_LEN)` = 74 at the default MTU, matching
`ResourceAdvertisement.HASHMAP_MAX_LEN` exactly; `build/parse_resource_request` extended for
the exhausted-flag-plus-last-map-hash form; `build/parse_resource_hmu` for the HMU packet
itself) and `shared/rns/index.js` (`Link._onResourceAdvertisement` now only fills in as many
`hashmapEntries` as the advertisement actually included, rather than assuming it always covers
every part; `_requestNextResourceParts` detects running out of known entries mid-window and
sends an exhausted-flagged request instead of just stopping; `_onHashmapUpdate` appends the
next chunk and resumes; `_onResourcePart`'s completion check now compares against the true
`parts.length` rather than the possibly-still-partial `hashmapEntries.length`).

**Send side intentionally not implemented**: this project's own sender still always includes
the whole hashmap in one advertisement regardless of size (see 2.1's `RESOURCE_SEGMENT_MAX_SIZE`
note) — both a real RNS receiver and this project's own receiver already tolerate that (the
`HASHMAP_MAX_LEN` limit is a real-RNS *sender's* own packet-fitting choice, not a receiver-side
rule), so there was nothing broken to fix, and truncating our sender's own advertisements would
mean also implementing genuine send-side HMU-response generation — a distinct, separable
addition with no interop benefit today, left for later. Raising send-side segmentation toward
`MAX_EFFICIENT_SIZE` (1 MiB−1) is bundled with that same later step, for the same reason.

Verified: unit tests (`test/rns-compliance.test.js`) — wire-format round-trip for both new
message shapes, and a full transfer built by hand with an advertisement hashmap deliberately
truncated to 3 of 7 entries, confirming the request-exhausted → HMU → resume flow completes
correctly end to end. Live: `test:integration:resource` — a real `RNS.Resource` sender given a
40000-byte (~87-part, safely over the 74-entry threshold) payload correctly truncates its own
advertisement and this project's receiver correctly requests, receives, and applies the HMU
packet to reassemble it (re-run twice for stability).

### Phase 3 — Request/Response Resource fallback — ✅ Done

Read `RNS/Link.py:473–508` (request path) and `:842–850` (response path). A packed
request or response that exceeds `LINK_MDU` is sent as a Resource instead of a single
packet, tagged with a `request_id`: for a request this is `Identity.truncated_hash`
of the packed `[timestamp, path_hash, data]` payload (`resource_request_id()` in
`shared/rns/protocol.js` — a plain hash of the payload itself, distinct from the
single-packet path's `packet_truncated_hash()` of the outer packet, since a Resource
has no single "packet" to hash); for a response it's the same `request_id` the
request carried. `build_resource_advertisement()`/`parse_resource_advertisement()`
(`shared/rns/protocol.js`) now carry `q` (`request_id`) and the `is_request`/
`is_response` flag bits, matching `ResourceAdvertisement`'s flags byte layout exactly.

`Link.request()` (`shared/rns/index.js`) now checks payload size before choosing a
single packet vs. `sendResource(payload, { requestId, isRequest: true })`; `_handleRequest()`
does the same for the response. On the receive side, `_assembleResource()` checks the
completed incoming Resource's `isRequest`/`isResponse` flags and routes it to
`_handleRequest()`/`_handleResponse()` instead of emitting a generic `'resource'` event —
matching how real RNS keeps these internal rather than exposing them to the application.

Verified: unit tests (`test/rns-compliance.test.js`) — advertisement round-trip of the
new flags/`request_id` field, and a full JS-to-JS request/response exchange forced
through the Resource path in both directions (`'x'.repeat(LINK_MDU * 2)` used for both
the request name and the handler's reply). Live: `test:integration:lxmf-propagation`
extended to upload 4 LXMF messages (1 original + 3 padded "bulk" messages) to a real,
unmodified `LXMF.LXMRouter` propagation node, then call `syncFromRealPropagationNode()`
— its `/get` response now exceeds `LINK_MDU`, genuinely exercising the real reference
implementation's own oversized-response-as-Resource path (not a synthetic one); all 4
messages downloaded and verified byte-for-byte (re-run 3× for stability). Full
regression also re-run clean: 59/59 unit tests, `vite build`, and the resource/channel
live checks.

### Phase 4 — Transport parity — ✅ Done

Read `RNS/Transport.py`'s `request_path()`/`path_request_handler()` (:2799–2939) and
the announce rate table (:1890–1911). Implemented in `shared/rns/index.js`'s
`Reticulum`:

1. **Path-request throttling.** `requestPath()` now records the last request time per
   destination (`pathRequestTimestamps`, matching `Transport.path_requests`) and
   suppresses a repeat call for the same destination within `PATH_REQUEST_MI_MS`
   (20s, `Transport.py:83`). Real RNS only applies this constant to its own
   *automatic* retry logic (failed-link rediscovery); this project has no such
   background retry system, so the throttle is applied directly at the public
   `requestPath()` call site instead — a more general application of the same
   constant, and the more useful place for it in a project without RNS's internal
   job loop.
2. **Transport instance identity + 3-field path requests.** Every `Reticulum`
   instance now creates a persistent `transportIdentity` (`Identity.create()`,
   in-memory only — see Phase 7) whose hash is sent in every outgoing path request,
   matching the 3-field form (`dest + transport_id + tag`) real RNS only sends when
   `transport_enabled()` (`Transport.py:2811`). This project's mesh nodes always
   forward packets for destinations they don't own (see `_forward`/
   `_forwardLinkRequest`) — i.e. they're always acting as a transport node — so the
   3-field form is used unconditionally rather than gated behind an explicit
   transport-enabled toggle real RNS has and this project doesn't model.
   `build_path_request()`/`parse_path_request()` already round-tripped both forms
   (the 2-field form is now the explicit non-transport case, still used when no
   transport identity is passed).
3. **Path table expiry.** A periodic job (`_cleanupPathTable()`, hourly) drops path
   table entries untouched for longer than `DESTINATION_TIMEOUT_MS` (7 days,
   `Transport.py:91`), so a long-running peer's path table doesn't grow unbounded
   with stale routes — real RNS's own destination-timeout mechanism, minus its
   `held_announces`/announce-table retry bookkeeping (see below).
4. **Announce rate table.** Each announce now records a timestamp in
   `announceRateTable`, capped at `MAX_RATE_TIMESTAMPS` (16, `Transport.py:96`) per
   destination — the mechanism real RNS uses to *count* announce rate. Left
   unenforced, matching real RNS's own default: an interface's
   `announce_rate_target` is `None` unless explicitly configured, so out of the box
   a real RNS node doesn't reject fast announces either. Porting the mechanism
   without inventing a default this project has no basis for keeps parity with
   RNS's actual out-of-box behavior rather than adding a restriction real RNS
   itself doesn't apply by default.

**Scoped out:** `PATH_REQUEST_GRACE`/`PATH_REQUEST_RG` (a short delay before
rebroadcasting a *cached* path-request answer, to let a more directly-reachable peer
answer first) and `LOCAL_REBROADCASTS_MAX` (capping how many times a non-owned
announce is locally rebroadcast) are both LAN-collision-avoidance optimizations tied
to `RNS.Transport`'s `announce_table`/retry/dedup state machine and roaming-mode
interface concept — neither of which this project's simpler flood-based mesh
architecture has a natural home for, and neither affects correctness or genuine
interop: a real peer's path request is answered correctly whether we take 0ms or
400ms to do it. Same category of gap as Phase 2's resource-shrink scoping — a real
mechanism intentionally not ported because nothing here depends on it.

Verified: unit tests (`test/rns-compliance.test.js`) — `requestPath()`'s 3-field form
and throttling (including a different destination's timer being unaffected),
`_cleanupPathTable()` dropping only stale entries, and the announce rate table's
16-entry cap. Live: new `test:integration:path-request` — a real, unmodified `rns`
process's own `path_request_handler()` correctly parses this stack's 3-field path
request (not the previous 2-field-only form) and answers with a valid announce for
a destination it owns, and a repeat `requestPath()` call is confirmed suppressed
rather than resent (re-run 3× for stability). Full regression re-run clean: 62/62
unit tests, `vite build`, and the sparse-mesh live check (unaffected by these
changes, still passing).

### Phase 5 — LXMF outbound parity

**5.1 DIRECT delivery — ✅ Done.** Read `LXMF/LXMessage.py:355–460` (`pack()`) and
`:626–654` (`__as_packet`/`__as_resource`). Correction to the plan as originally
written: reading the actual source shows the destination-hash prefix is the other
way around from what's stated above — **OPPORTUNISTIC** is the one that omits it
(implied by the packet's own destination), while **DIRECT** keeps the full
`destination_hash + source_hash + signature + msgpack_payload` layout (`self.packed`,
unsliced) as-is over the Link, since the Link's own outer packet is addressed to the
link_id, not the LXMF destination — confirmed both by reading `__as_packet()`
(`RNS.Packet(self.__delivery_destination, self.packed)`, no slice, vs. OPPORTUNISTIC's
`self.packed[DESTINATION_LENGTH:]`) and by capturing a real `LXMessage(desired_method=
DIRECT).pack()` byte vector for the project's fixed test identities.

Implemented: `protocol.js`'s `lxmf_build_direct()`/`lxmf_parse_direct()` (the full
4-field wire form) alongside the existing OPPORTUNISTIC `lxmf_build()`/`lxmf_parse()`
(refactored to share the common sign/hash logic via a private `lxmf_sign()` helper).
`Link.sendLXMF(source, title, content, fields)` (`shared/rns/index.js`) picks
representation exactly like `LXMessage.pack()` does: a plain link packet if the built
payload fits within `LINK_MDU`, otherwise a Resource (already auto-compressed, same as
any other Resource here — real compression *negotiation* via a peer's announced
`SF_COMPRESSION` is Phase 5.2). Receive side: `Link.onPacket()`'s `CONTEXT_NONE`
branch and `_assembleResource()`'s completed-Resource branch both now try
`tryParseLxmfDirect()` first (mirroring how `Destination.onData()` already tries
OPPORTUNISTIC `tryParseLxmf()` before falling back to a plain `'packet'` event) and
emit an `'lxmf'` event instead of `'packet'`/`'resource'` on a match — no destination
prepending needed, since DIRECT's wire form already carries its own.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the DIRECT wire form's
byte-exact match against a real `LXMessage.pack()` capture (including the
destination-hash-included layout), signature rejection, and two full JS-to-JS Link
tests (packet-sized and `LINK_MDU`-exceeding Resource-sized, confirming the `'lxmf'`
event fires instead of `'packet'`/`'resource'`). Live: `test-integration/rns_node.py`
extended with a Link-scoped LXMF packet/resource callback on its `lxmf.delivery`
destination and a `send_lxmf_direct` command (using `LXMessage.pack()` +
`RNS.Packet`/`RNS.Resource` directly against an established Link, the same primitives
`LXMessage.send()` uses internally, without needing a full `LXMRouter` for this
wire-format-focused check); `lxmf-cross-language-check.mjs` extended to exchange
DIRECT messages in both directions, both packet-sized and Resource-sized (re-run 3×
for stability). Full regression re-run clean: 66/66 unit tests, `vite build`, and the
`resource`/`lxmf-propagation`/`lxmf-peer-sync` live checks (unaffected, still passing).

**5.2 Delivery announce app_data + compression negotiation — ✅ Done.** Read
`LXMRouter.get_announce_app_data()` (LXMRouter.py:985–1000), `LXMF.stamp_cost_from_
app_data()`/`compression_support_from_app_data()` (LXMF.py:174–200), and
`LXMessage.determine_compression_support()` (LXMessage.py:510–517).

Implemented in `shared/rns/protocol.js`: `lxmf_build_announce_app_data(display_name,
stamp_cost)` builds the `[display_name|null, stamp_cost|null, [SF_COMPRESSION]]`
msgpack structure (byte-exact against a real `get_announce_app_data()`-equivalent
capture, both empty and populated); `lxmf_stamp_cost_from_app_data()` and
`lxmf_compression_supported()` parse it back out, matching the real functions'
exact semantics — including the non-obvious case where an app_data *is* present but
its functionality list doesn't include `SF_COMPRESSION` (returns `false`, not a
permissive default; only *no app_data at all* defaults to `true`, folding in
`determine_compression_support()`'s own no-app_data fallback). `Destination.announce()`
gained an `appData` option (previously always empty) so a caller can attach this.
`Link.sendLXMF()` now looks up the recipient's most recently cached announce
app_data (already stored per-destination on every announce) and passes
`autoCompress` through to `sendResource()`/`_sendResourceSegment()` (both gained the
same option, default `true`) — skipping the compression attempt entirely rather than
compressing and discarding the result, when the recipient has explicitly signaled no
support.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the app_data byte-exact
round-trip, the "present but no SF_COMPRESSION" parsing case, and a full JS-to-JS
Link test confirming the *sent advertisement's own compressed flag* is `false` (not
just that decompression still works either way) when the recipient announced no
support. Live: `lxmf-cross-language-check.mjs` extended so a real, unmodified `rns`/
`lxmf` process re-announces its `lxmf.delivery` destination with a real
`get_announce_app_data()`-shaped app_data declaring no compression support, and
confirms — from the real `RNS.Resource`'s own `compressed` attribute on the
Python side — that JS's next oversized DIRECT send genuinely skipped compression in
response to that real announce (re-run 3× for stability). Full regression re-run
clean: 69/69 unit tests, `vite build`.

**5.3 Propagation-node announce app_data — ✅ Done.** Read `LXMRouter.
get_propagation_node_app_data()` (LXMRouter.py:300–318) and `LXMF.pn_announce_data_
is_valid()`/`pn_stamp_cost_from_app_data()` (LXMF.py:174–246).

Implemented in `shared/rns/protocol.js`: `lxmf_build_propagation_announce_app_data()`
builds the 7-element `[false, timebase, node_state, per_transfer_limit_kb,
per_sync_limit, [stamp_cost, stamp_cost_flexibility, peering_cost], metadata]` list
— byte-exact against a real `get_propagation_node_app_data()`-equivalent capture,
including the metadata dict's integer-keyed `PN_META_NAME` entry (needed a `Map`
rather than a plain JS object, since a plain object's keys are always coerced to
strings — `Object.entries({1: x})` would have msgpacked the key `1` as the *string*
`"1"`, not the integer real LXMF expects, a mismatch that would have silently broken
interop). `lxmf_parse_propagation_announce_app_data()` validates and parses it back,
matching `pn_announce_data_is_valid()`'s exact rules (7 elements, decodable
timebase, strictly-boolean node_state, integer transfer/sync limits, a 3-element
integer stamp-cost list, dict-typed metadata) — returning `null` for anything that
fails, mirroring `pn_stamp_cost_from_app_data()`'s own `None` fallback rather than
throwing.

`PropagationNode.announce()` now embeds this using the node's own configured
`stampCost`/`peeringCost` (previously always empty). `propagateLXMF()`/`syncToPeer()`
both changed their `stampCost`/`peeringCost` parameter default from a fixed number to
`null`, meaning "read it from the destination's most recently cached announce
app_data" (already stored per-destination on every announce, same cache Phase 5.2
reads for compression support) — computing `stamp_cost - stamp_cost_flexibility` as
the safe target, same as a real LXMF client would; an explicit number still works as
an override for cases where the announce isn't available yet, or (as in the peer-sync
live test below) where the relevant announce belongs to a different destination than
the one being called through.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the app_data byte-exact
match (cross-checked against a real fixed-timebase capture) and validation-rejection
rules, plus two full JS-to-JS tests confirming `propagateLXMF()`/`syncToPeer()`
genuinely read the cost from a `PropagationNode.announce()` rather than needing it
passed. Live: both `lxmf-propagation-cross-language-check.mjs` and
`lxmf-propagation-peer-sync-cross-language-check.mjs` extended to make
`lxmf_propagation_node.py` call the real `LXMRouter.announce_propagation_node()`
(firing ~20s later, `NODE_ANNOUNCE_DELAY`) and have JS wait for and parse that real
announce, cross-checking every field against the test harness's own out-of-band
values before using *only* the parsed announce to drive `propagateLXMF()`/
`syncToPeer()`'s cost (re-run twice each for stability, given the added real-world
timing dependency). Full regression re-run clean: 73/73 unit tests, `vite build`,
and the `lxmf`/`resource`/`channel` live checks.

### Phase 6 — end-user client interop

1. `pip install --target=$PYLIBS nomadnet`; run headless (`nomadnet --daemon
   --config <tmp>`) attached to the TCP gateway; exchange LXMF messages with the JS
   stack both directions — direct and via a propagation node. NomadNet is textual/UI-driven;
   drive it via its config + filesystem inbox, or fall back to scripting `lxmf`
   directly with NomadNet's exact announce/app_data conventions if the TUI can't be
   automated — document which was possible.
2. Attempt Sideband (`pip install sbapp`, kivy GUI): expected infeasible headless; if
   so, record that honestly (do not claim interop).
3. Update README's "hasn't been tested" language to the actual, verified state.

### Phase 7 — persistence parity

1. Storage adapter interface (Node: filesystem under a configdir like RNS's
   `~/.reticulum`; browser: localStorage/IndexedDB — identity already session-cached).
2. Persist + reload: identity cache/known destinations (`Identity.remember/recall`,
   `save_known_destinations` msgpack format), path table, `PropagationNode.messages`
   (mirror `LXMRouter`'s `storagepath` layout: one file per transient_id, stamp
   attached).
3. Ratchet rotation per `Destination.rotate_ratchets` (interval + retained count),
   persisted.
   Marked *adaptation* in the checklist — formats need only round-trip with ourselves,
   but follow RNS's on-disk formats where practical.

### Phase 8 — docs finalization

README Compliance section rewritten against the finished checklist; demo page copy
re-checked against actual behavior; final sweep of this file — every row DONE/N/A with
its "verified by" filled in; remove stale caveats elsewhere (module comments citing
"fixed intervals", "decode-only", etc.).

## Status log

| Date | Phase | Result |
|---|---|---|
| 2026-07-05 | Phase 0 | Identity persistence committed (`b3f95fe`); this document created. |
| 2026-07-05 | Phase 1 | Link's RTT-adaptive keepalive/stale/timeout state machine implemented, plus a real bug fix (made `stamp.generate_stamp()`/`generate_peering_key()` non-blocking — see Phase 1 writeup). 51/51 unit tests pass; live `resource`/`channel`/`lxmf-propagation`/`lxmf-peer-sync` checks re-verified. |
| 2026-07-05 | Phase 2.1 | Resource's rate-adaptive request window (growth + fast/very-slow-rate `window_max` promotion/demotion) implemented; retry-driven shrinking scoped out (no per-part retry mechanism exists). 52/52 unit tests pass; live `test:integration:resource` re-verified in both directions. |
| 2026-07-05 | Phase 2.2 | Outgoing bz2 compression implemented for Resource and Buffer via `bzip2-wasm` (a WASM build of the real reference `libbzip2`, chosen over the GPL-licensed `compressjs`). Byte-exact vs real `bz2.compress()`; live checks confirm real `RNS.Resource`/`RNS.Buffer` explicitly recognize JS-compressed transfers; verified working in the actual production browser build via real headless Chromium (a dev-server-only WASM pre-bundling quirk was found and mitigated, doesn't affect the deployed demo). 54/54 unit tests pass. |
| 2026-07-05 | Phase 2.3 | Resource HMU (hashmap update) receive path implemented — this project's receiver can now complete a transfer whose advertisement doesn't include the whole hashmap upfront, matching real RNS's `HASHMAP_MAX_LEN`-based truncation exactly. Send-side truncation/HMU-response scoped out (nothing currently needs it). 57/57 unit tests pass; live `test:integration:resource` confirms a genuine HMU exchange with a real ~87-part `RNS.Resource` sender (re-verified twice). Phase 2 (Resource parity) is now complete. |
| 2026-07-05 | Phase 3 | Request/Response Resource fallback implemented for oversized payloads in both directions, matching `RNS.Link.request()`'s own fallback exactly (including its distinct `request_id` hash for the Resource form). 59/59 unit tests pass; live `test:integration:lxmf-propagation` extended to force a real, unmodified `LXMRouter`'s own `/get` response over `LINK_MDU` (4 uploaded messages) and confirms it downloads correctly via the new fallback (re-run 3× for stability). Full regression clean: unit tests, `vite build`, `resource`/`channel` live checks. |
| 2026-07-06 | Phase 4 | Transport parity implemented: `requestPath()` throttling (`PATH_REQUEST_MI`), a persistent per-instance transport identity powering the 3-field path request form (previously 2-field only), path table expiry (`DESTINATION_TIMEOUT`), and an announce rate table mechanism (unenforced, matching RNS's own default-off `announce_rate_target`). Path-request rebroadcast grace and `LOCAL_REBROADCASTS_MAX` scoped out (LAN-collision-avoidance optimizations tied to RNS's announce-table retry machinery, not needed for correctness or interop). 62/62 unit tests pass; new live `test:integration:path-request` confirms a real, unmodified `rns` process's `path_request_handler()` correctly parses and answers the new 3-field form, and that repeat requests are suppressed (re-run 3× for stability). Full regression clean: unit tests, `vite build`, sparse-mesh live check. |
| 2026-07-06 | Phase 5.1 | LXMF DIRECT delivery implemented (`Link.sendLXMF()`, packet or Resource, matching `LXMessage.pack()`'s own representation choice) — corrected a mistake in this plan's own original wording along the way (DIRECT keeps the destination-hash prefix; OPPORTUNISTIC is the one that omits it, confirmed by reading `LXMessage.__as_packet()` and capturing a real `.pack()` byte vector). 66/66 unit tests pass; live `lxmf-cross-language-check.mjs` extended to exchange DIRECT messages with a real, unmodified `lxmf`/`rns` process in both directions and both packet/Resource representations (re-run 3× for stability). Full regression clean: unit tests, `vite build`, `resource`/`lxmf-propagation`/`lxmf-peer-sync` live checks. |
| 2026-07-06 | Phase 5.2 | LXMF delivery announce app_data (`lxmf_build_announce_app_data`/`lxmf_stamp_cost_from_app_data`/`lxmf_compression_supported`, byte-exact) and compression negotiation implemented — `Link.sendLXMF()` skips compression for a Resource-sized message when the recipient's cached announce explicitly declares no `SF_COMPRESSION` support. 69/69 unit tests pass; live `lxmf-cross-language-check.mjs` extended so a real, unmodified `rns`/`lxmf` process re-announces declaring no compression support, and JS's next oversized DIRECT send is confirmed (via the real `RNS.Resource`'s own `compressed` attribute on the Python side) to have genuinely honored it (re-run 3× for stability). Full regression clean: unit tests, `vite build`. |
| 2026-07-06 | Phase 5.3 | Propagation-node announce app_data implemented (`lxmf_build_propagation_announce_app_data`/`lxmf_parse_propagation_announce_app_data`, byte-exact, including catching a would-be integer-vs-string msgpack key mismatch before it could break interop). `PropagationNode.announce()` now embeds real stamp/peering cost; `propagateLXMF()`/`syncToPeer()` default to reading it from a cached announce instead of a required argument. 73/73 unit tests pass; both propagation live checks extended to make a real `LXMRouter` fire its actual `announce_propagation_node()` (~20s delay) and drive JS's uploads/peer-sync using *only* the parsed real announce, cross-checked against the test harness's own values (re-run twice each for stability). Full regression clean: unit tests, `vite build`, `lxmf`/`resource`/`channel` live checks. **Phase 5 (LXMF outbound parity) is now complete.** |
