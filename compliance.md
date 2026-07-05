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
| Path-request rate limiting & grace | `RNS/Transport.py:77–96` (`PATH_REQUEST_MI=20, PATH_REQUEST_GRACE=0.4, PATH_REQUEST_RG=1.5, LOCAL_REBROADCASTS_MAX=2, DESTINATION_TIMEOUT=7d, MAX_RATE_TIMESTAMPS=16`), `:3012–3028` | — | MISSING | **Phase 4** |
| Transport instance identity + 3-field path requests | `RNS/Transport.py:2811` (`dest+transport_identity.hash+tag`) | — (2-field form only) | MISSING | **Phase 4** |
| Announce rate table enforcement | `RNS/Transport.py:1890–1911` | — | MISSING | **Phase 4** |

### LXMF

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Message envelope + signature (OPPORTUNISTIC) | `LXMF/LXMessage.py` `pack()` | `shared/rns/protocol.js` `lxmf_build/lxmf_parse` | DONE | byte-exact + live both directions |
| Admission stamps (message) | `LXMF/LXStamper.py` | `shared/rns/stamp.js` | DONE | byte-exact + live |
| Peering-key stamps | `LXMF/LXStamper.py` `generate_peering_key` | `shared/rns/stamp.js` `generate/validate_peering_key` | DONE | byte-exact + live |
| Propagation node store & client sync (`/get`) | `LXMF/LXMRouter.py` `message_get_request` | `shared/rns/propagation.js` `PropagationNode`, `syncFromRealPropagationNode` | DONE | live (upload + download vs real node) |
| Node-to-node peer sync (`/offer`) | `LXMF/LXMPeer.py`, `LXMRouter.offer_request` | `shared/rns/propagation.js` `syncToPeer/_onOfferRequest` | DONE | live (real node accepts + stores) |
| DIRECT delivery (over a Link; packet or Resource) | `LXMF/LXMessage.py:30–34` (methods), `:390–460` (representation), `:534/:654` (send) | — | MISSING | **Phase 5.1** |
| Delivery announce app_data (`[display_name, stamp_cost, [SF_COMPRESSION]]`) | `LXMF/LXMRouter.py:985–1000` `get_announce_app_data`, `LXMF/LXMF.py:174` `stamp_cost_from_app_data` | — | MISSING | **Phase 5.2** |
| Compression negotiation (`SF_COMPRESSION` → `auto_compress`) | `LXMF/LXMessage.py:510–517` `determine_compression_support` | — | MISSING (needs Phase 2.2) | **Phase 5.2** |
| Propagation-node announce app_data (7-element list) | `LXMF/LXMRouter.py:300–318` `get_propagation_node_app_data`, `LXMF/LXMF.py:224` `pn_announce_data_is_valid` | — (stamp cost must be known out of band) | MISSING | **Phase 5.3** |
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

### Phase 4 — Transport parity

Read `RNS/Transport.py` jobs loop (:540–800) and announce handling (:1770–1915), path
request handling (:2894–3030). Implement in `shared/rns/index.js` `Reticulum`:

1. Path-request throttling: per-destination minimum interval `PATH_REQUEST_MI=20 s`;
   response grace `PATH_REQUEST_GRACE=0.4 s` (+`PATH_REQUEST_RG` on roaming-class
   interfaces — map WebRTC to non-roaming defaults); local announce rebroadcast cap
   `LOCAL_REBROADCASTS_MAX=2`; path-table entry expiry `DESTINATION_TIMEOUT` (7 d) with
   a periodic cleanup job.
2. Announce rate table: per-destination timestamps (cap `MAX_RATE_TIMESTAMPS=16`),
   violations counted against a per-interface `announce_rate_target` (default off,
   matching RNS interface defaults — implement the mechanism, keep defaults null).
3. Transport instance identity: a persistent per-`Reticulum` identity whose hash goes
   into the 3-field path request form (`dest + transport_identity.hash + tag`,
   :2811) when transport is enabled; parse both forms on receive (already tolerant —
   verify against `path_request_handler`, :2894).

Live: sparse-mesh check re-run; add a check that a real `rns` transport node accepts and
answers our 3-field path request, and that repeated `requestPath` calls inside 20 s are
suppressed.

### Phase 5 — LXMF outbound parity

**5.1 DIRECT delivery.** Read `LXMF/LXMessage.py:380–540` and `LXMRouter`'s outbound
processing. Implement (new `shared/rns/lxmessage.js` or extend `protocol.js`): method
constants (OPPORTUNISTIC=0x01, DIRECT=0x02, PROPAGATED=0x03); DIRECT packs *without* the
destination-hash prefix (the link implies it — note `DESTINATION_LENGTH` handling in
`packed_size` math, :79–90); fits-in-one-packet → plain link packet (:534); otherwise a
Resource over the link (:654) with `auto_compress`. Receive side: a link-data packet or
completed Resource on an `lxmf.delivery` destination's link parses as an LXMF message
(prepend the destination hash back before `lxmf_parse`). Live: extend
`lxmf-cross-language-check.mjs` — real `lxmf` client sends DIRECT to JS over a link and
vice versa, both packet-sized and Resource-sized (≥ LINK_PACKET_MAX_CONTENT) messages.

**5.2 Delivery announce app_data + compression negotiation.** Implement
`[display_name|null, stamp_cost|null, [SF_COMPRESSION]]` (msgpack) as the demo/LXMF
destinations' announce app_data; parse inbound ones (`stamp_cost_from_app_data`
semantics: only list-typed app_data, index 1). Honor a peer's advertised
`SF_COMPRESSION` when choosing `auto_compress` for DIRECT Resources
(`determine_compression_support`). Depends on 2.2. Byte-exact: capture real
`get_announce_app_data` output for a fixed name/cost and match.

**5.3 Propagation-node announce app_data.** Implement
`[False, timebase, node_state, per_transfer_limit_kb, per_sync_limit, [stamp_cost,
flexibility, peering_cost], metadata]` on `PropagationNode.announce()`; validate inbound
with `pn_announce_data_is_valid` rules (LXMF.py:224). Senders (`propagateLXMF`,
`syncToPeer`) read the required stamp/peering cost from the announce instead of taking
it as an argument (keep the argument as an override). Live: JS uploads to a real node
using *only* its announce to learn the stamp cost; JS node's announce parses cleanly
with real `pn_announce_data_is_valid` and a real router lists it as a candidate node.

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
