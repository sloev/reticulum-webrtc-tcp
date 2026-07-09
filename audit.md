# audit.md — production-readiness pass: close remaining feature gaps, re-verify compliance, rewrite docs

## Context

`reticulum-webrtc-tcp` is a from-scratch JavaScript reimplementation of a
subset of the Reticulum Network Stack (RNS) and LXMF, verified against the
Python `rns`==1.3.7 / `lxmf`==1.0.1 packages. An earlier pass executed
`compliance.md` end to end: all 8 phases complete, 77/77 unit tests, all
live cross-language checks green (including against unmodified NomadNet
and Sideband clients). All of it is committed and pushed to branch
`claude/repo-cleanup-docs-oxxc2f`. Work on that branch; never force-push
or skip hooks without explicit permission; never open a PR unless asked.

This pass takes the repo to production-ready:

**Part 1 — close the remaining feature gaps** (each was previously
documented as out of scope; the user has now asked for all of them):
1. Send-side HMU (Resource advertisement hashmap truncation + hashmap
   update packets from the sender).
2. Retry-driven Resource window shrink (per-part retry/timeout on the
   receiver, matching `RNS.Resource`).
3. Ratchet rotation (`RNS.Destination.rotate_ratchets` semantics).
4. Propagation-node ↔ end-user-client interop (a real LXMF client and
   this stack exchanging messages through a propagation node, both
   directions; plus, if feasible after reading the Python source, making
   this project's own `PropagationNode` `/get` handler wire-compatible
   with real LXMF clients).

**Part 2 — audit and rewrite the documentation:**
5. Re-verify compliance claims against the actual Python sources.
6. README owns a canonical feature-parity table with code references to
   both the Python original and the JS port (user-confirmed decision;
   `compliance.md` becomes the historical execution log).
7. New README section documenting the WebRTC↔TCP bridge.
8. Every code comment and doc made precise and factual; narrative/hype
   lingo removed ("genuinely", "can now", "is now", discovery stories,
   self-congratulation).

## Methodology (same as compliance.md's ground rules — follow strictly)

- Read the Python source first, from the installed packages, before
  implementing or citing anything. Never trust a remembered line number.
- Verification ladder per feature: (1) byte-exact unit tests where a wire
  format is involved (`test/*.test.js`, ground-truth bytes captured from
  the real Python package); (2) live cross-language checks
  (`test-integration/*.mjs`, spawn real Python processes over real
  TCP+HDLC), re-run 2-3x since PoW/timing has real variance; (3) full
  regression before every commit: `npm test`, `npx vite build
  --base=/reticulum-webrtc-tcp/`, plus the live checks touching the
  changed layer.
- One commit per feature (see `git log` on the branch for the message
  style), then a final docs commit. Update `compliance.md`'s status log
  with each commit.
- If a live check fails persistently (not just PoW variance), that is a
  real regression: stop and fix, don't soften the docs around it.

## Environment setup

```bash
mkdir -p /tmp/audit-pylibs
pip install --target=/tmp/audit-pylibs rns==1.3.7 lxmf==1.0.1
# needed for Part 1 item 4 and the nomadnet/sideband checks:
pip install --target=/tmp/audit-pylibs nomadnet sbapp
export PYLIBS=/tmp/audit-pylibs
```

Python sources to read live under `$PYLIBS/RNS/` and `$PYLIBS/LXMF/`.
The live checks are run as `PYLIBS=$PYLIBS npm run test:integration:<name>`
(see `package.json` scripts). Propagation/nomadnet/sideband checks are
slow — real proof-of-work plus a real 20s `LXMRouter` announce delay —
use 150s+ timeouts before concluding anything hangs.

Baseline before touching anything: `npm test` (expect 77/77) and one
spot-check live run (`test:integration:resource`) to confirm the
environment works.

---

## Part 1 — feature work

### Feature 1: Send-side HMU + advertisement hashmap truncation

Current state: the receive side is done — `shared/rns/index.js`
`_onHashmapUpdate`/`_requestNextResourceParts` handle a real sender's
truncated advertisement and request hashmap updates via the
exhausted-request form (`0xff` + last map hash), and
`shared/rns/protocol.js` has `build_resource_hmu`/`parse_resource_hmu`,
`parse_resource_request` (which already parses the `hashmapExhausted`
flag), and `RESOURCE_HASHMAP_MAX_LEN` (= 74 at default MTU, matching
`ResourceAdvertisement.HASHMAP_MAX_LEN`). The send side never truncates:
`build_resource_advertisement` packs the full hashmap, and
`_onResourceRequest` ignores the exhausted flag.

Read first: `$PYLIBS/RNS/Resource.py` — advertisement construction (where
the hashmap is segmented per `HASHMAP_MAX_LEN`), `request_next()` (the
exhausted request the receiver sends), and `hashmap_update_packet()` /
the sender's response path (~lines 483-499 in 1.3.7, re-verify). Also
`ResourceAdvertisement` in the same file for how `m` carries only the
first chunk.

Implement in `shared/rns/index.js` (sender side) +
`shared/rns/protocol.js`:
- Truncate the advertisement's hashmap to `RESOURCE_HASHMAP_MAX_LEN`
  entries when the part count exceeds it.
- In `_onResourceRequest`, when the parsed request has
  `hashmapExhausted`, locate the last-known map hash the receiver
  reported, and send a `CONTEXT_RESOURCE_HMU` packet with the next
  hashmap chunk (`build_resource_hmu(resource_hash, segment,
  hashmap_chunk)`), chunk-sized the way `Resource.py` does, before/along
  with serving the requested parts — mirror the Python control flow, not
  a guess.
- Reconsider `RESOURCE_SEGMENT_MAX_SIZE` / `RESOURCE_MAX_PARTS`: the
  small segment cap existed because one advertisement had to carry the
  whole hashmap. With truncation implemented that constraint is gone —
  read the `RESOURCE_MAX_PARTS` comment in `protocol.js` and raise the
  segment size toward RNS's own `MAX_EFFICIENT_SIZE` (1 MiB - 1) if
  nothing else depends on the small size. If raising it, re-check
  multi-segment tests still exercise multi-segment paths (they may need
  bigger payloads or a test-scoped smaller constant).

Verify:
- Unit: JS→JS transfer large enough to force truncation (> 74 parts);
  assert the advertisement's hashmap is truncated and the transfer
  completes via HMU exchange. Byte-exact round-trip tests already exist
  for the HMU wire format; extend if the send path adds new shapes.
- Live (the strong check): JS sends a > 74-part resource to a real
  Python `RNS.Resource` receiver — the real receiver itself sends
  exhausted requests, and this sender must answer with HMU packets it
  accepts. Extend `test-integration/resource-cross-language-check.mjs`
  (it already has the mirror-image test: Python sender → JS receiver via
  HMU). Re-run 2-3x.

### Feature 2: Retry-driven Resource window shrink (per-part retry/timeout)

Current state: `_growResourceWindow` implements growth + fast/very-slow
rate promotion/demotion of `windowMax`
(`RESOURCE_WINDOW*`/`RESOURCE_*_RATE_*` constants in `protocol.js` match
`Resource.py`). There is no per-request-round timeout, so a lost part
would stall a transfer forever, and the window never shrinks.

Read first: `$PYLIBS/RNS/Resource.py` — the watchdog/`__watchdog_job`
retry logic, `PART_TIMEOUT_FACTOR` (=4), `PART_TIMEOUT_FACTOR_AFTER_RTT`
(=2), `MAX_RETRIES` (=16), `RETRY_GRACE_TIME`, and where/how the window
and `window_max` shrink on a retry (read the actual code — do not
implement from these constant names alone).

Implement in `shared/rns/index.js` (receiver side): after sending a part
request (`_requestNextResourceParts`), arm a timer scaled from the link
RTT per the Python factors; if the requested window isn't fully satisfied
when it fires, shrink `window`/`windowMax` per `Resource.py`'s rules,
re-request the missing parts, count a retry; after `MAX_RETRIES`, fail
the incoming transfer (reject/emit failure, clean up
`_incomingResources`). Clear timers on completion/teardown — check
`_teardown()` cleans these up like it does `_outgoingResources`.

Verify:
- Unit: a Bridge interface that drops the first N `CONTEXT_RESOURCE`
  part packets → transfer still completes, observed window shrank, retry
  count advanced; a Bridge that drops everything → transfer fails after
  `MAX_RETRIES` (use short test-scoped timeouts by back-dating timestamps
  or exposing the timeout computation, same trick as the existing Link
  watchdog tests in `test/rns-compliance.test.js`).
- Live: re-run `test:integration:resource` and `:channel` (no behavior
  change expected on a reliable transport — confirm no regression, and
  confirm no spurious retries fire during a slow real PoW-heavy run,
  i.e. timers must be per-resource, not global).

### Feature 3: Ratchet rotation

Current state: `Identity` (in `shared/rns/index.js`) generates one static
X25519 ratchet at construction; `Destination.announce()` always announces
that same ratchet; `Destination.onData()` decrypt tries
`[ratchetPrivate, identity.private]`. Real RNS rotates.

Read first: `$PYLIBS/RNS/Destination.py` — `rotate_ratchets()` and the
surrounding ratchet handling (retained count, rotation interval — in
1.3.7 the relevant region is ~lines 210-243, re-verify), plus
`$PYLIBS/RNS/Identity.py`'s decrypt path that tries retained ratchets.
Note which constants matter: rotation interval, number of retained
ratchets (`RATCHET_COUNT`), expiry.

Implement:
- `Destination` (IN direction) keeps a list of retained ratchet private
  keys with creation timestamps. On `announce()`, if the rotation
  interval has elapsed since the newest ratchet, generate a fresh one,
  prepend it, trim the retained list to the retained count. The announce
  always carries the newest ratchet public key (this is already what
  `build_announce` sends — only the source of the key changes).
- `Destination.onData()` decrypt fallback tries: every retained ratchet
  (newest first), then the identity's primary X25519 key — mirroring
  `Identity.decrypt`'s candidate order in the Python source.
- Persistence: extend `Reticulum.saveState()`/`loadState()`
  (`shared/rns/index.js`) or a `Destination`-level equivalent so retained
  ratchets survive a restart via `shared/rns/storage.js` — otherwise a
  restart would orphan messages encrypted to a pre-restart ratchet.
  Follow the existing save/load pattern; adaptation-format, not RNS's
  on-disk format (consistent with the Phase 7 decisions in
  `compliance.md`).
- Keep the single-ratchet fast path working for OUT destinations and for
  peers that never rotate.

Verify:
- Unit: rotate (by back-dating the newest ratchet's timestamp), announce,
  confirm a message encrypted to the *old* announced ratchet still
  decrypts; confirm the retained list trims at the count limit; confirm
  save/load round-trips retained ratchets.
- Live: extend `test-integration/lxmf-cross-language-check.mjs` (or a
  small new check): JS announces, real Python `rns` caches the announce;
  JS rotates and re-announces; Python sends a message using the *new*
  announce → decrypts; and critically, JS receives a message encrypted
  against the *previous* announce's ratchet (have Python recall the old
  announce by sending before seeing the re-announce) → still decrypts
  via the retained ratchet. Re-run 2-3x.

### Feature 4: Propagation-node ↔ end-user-client interop

Current state: JS ⇄ real `LXMRouter` propagation node works both ways
(upload via `propagateLXMF`, download via `syncFromRealPropagationNode`,
peer sync via `syncToPeer` — all live-verified). Direct JS ⇄
NomadNet/Sideband messaging works both ways. Untested: a *client* using a
*propagation node* with JS on the other side. Also documented: this
project's own `PropagationNode`'s client-facing `/get` protocol
(`syncLXMF`) is a JS-only format, not wire-compatible with real clients.

Two sub-items:

**4a (do this):** live check routing client↔JS messages through a real
`LXMRouter` propagation node:
- JS uploads a message (addressed to the NomadNet identity) to a real
  `LXMRouter` propagation node via `propagateLXMF`; the NomadNet daemon
  (driven by `test-integration/nomadnet_driver.py`) is pointed at that
  node (read `$PYLIBS/nomadnet/NomadNetworkApp.py` — it has
  propagation-node selection and `request_lxmf_sync(...)`; extend the
  driver with a `sync` command that sets the node and triggers a sync)
  and must receive/store the message.
- Reverse: NomadNet sends a PROPAGATED message (LXMRouter handles the
  stamp) addressed to the JS identity; JS retrieves it from the node via
  `syncFromRealPropagationNode` and validates it.
- New file `test-integration/propagation-client-interop-check.mjs` + npm
  script `test:integration:propagation-client`. Mind the 20s node
  announce delay and PoW time; NomadNet also needs the recipient's
  announce cached before it can address it.

**4b (attempt; keep only if the Python source confirms it's tractable):**
make this project's `PropagationNode._onGetRequest`
(`shared/rns/propagation.js`) wire-compatible with a real LXMF client's
sync protocol, so a real client can select a JS node and sync from it.
The client side of that exact protocol is already implemented in
`syncFromRealPropagationNode` (same file) — the request/response shapes
are known from it and from `$PYLIBS/LXMF/LXMRouter.py`'s
`message_get_request()` handler (read it in full: identify-based auth via
`link.get_remote_identity()`, listing vs fetch vs erase forms, response
shapes, `per_sync_limit` handling). Implement the same handler behavior
on the JS node; keep the JS-only `syncLXMF` protocol working (they're
distinguishable by request shape). Verify live: NomadNet (or a bare
`LXMRouter` client) syncs a stored message down from the JS
`PropagationNode`. If reading `message_get_request()` reveals this needs
substantially more than the request handler (e.g. tickets, transfer
limits enforcement), implement the minimal compliant subset, document
the rest precisely in the README gap list, and say so in the commit.

---

## Part 2 — documentation and comment audit

Do this **after** Part 1 so the docs describe the final state.

### 5. Compliance re-verification against Python sources

Spot-check at least 10 of the Python `file:line` citations used in the
feature table (below) against `$PYLIBS` — open the file, confirm line
and content. Fix any that drifted. Then run the complete suite: `npm
test`, `npx vite build --base=/reticulum-webrtc-tcp/`, and every
`test:integration:*` script (including the new ones from Part 1;
`test:integration` sparse-mesh needs `npm run dev` running first).

### 6. README rewrite — owns the canonical feature table

- Intro: replace the current run-on paragraph with one short paragraph on
  what the project is (from-scratch reimplementation, not a wrapper) and
  one on what's verified, linking to Compliance. Present tense, no
  "can now / is now / genuinely / newly".
- Compliance section: replace all narrative prose ("Verified
  byte-for-byte…", "Verified by live…", "Verified functionally…", and the
  stale "Not yet verified or compliant:" block — which currently sits,
  wrongly, above two bullets describing *implemented and verified*
  features) with **one feature-parity table** adapted from
  `compliance.md`'s six checklist tables (core wire format & identity ·
  Link · Resource/Channel/Buffer · Transport/routing · LXMF · persistence
  & environment). Columns: `Feature | Python reference | JS location |
  Status | Verified by`. Update rows for the Part 1 features (HMU →
  send+receive, window shrink → done, ratchet rotation → done,
  client-propagation interop → done/partial per outcome). Condense
  "Verified by" cells to a short phrase (e.g. "byte-exact +
  `test:integration:resource`") — details live in `compliance.md`.
- Keep a short preamble on the two-tier verification method (byte-exact
  vectors + live cross-language checks) and a "Remaining gaps" list
  reflecting what's actually still open after Part 1 (e.g. announce-rate
  enforcement stays off matching RNS's own default; whatever remains of
  4b; PAPER delivery N/A; IFAC N/A).
- **New "WebRTC ↔ TCP bridge" section** under Architecture (or folded
  into the existing "TCP gateway" subsection if it reads better):
  - Browser peers interconnect over WebRTC data channels with Nostr
    signaling.
  - A Node.js peer (`node/index.js`) runs both a WebRTC interface and
    `TCPServerInterface` (`node/tcp-gateway.js`) on one `Reticulum`
    instance; packets flood across all attached interfaces
    (`Reticulum._broadcastExcept`) and are forwarded to specific
    next-hops via the path/link tables (`_forward`,
    `_forwardLinkRequest`, `_forwardLinkTraffic`) — the bridge is the
    same relaying mechanism, running across dissimilar interfaces.
  - The TCP side speaks `RNS.Interfaces.TCPInterface`'s exact HDLC
    framing (`node/hdlc.js`, byte-exact tested), so an unmodified
    Reticulum node connects with its standard `TCPClientInterface` —
    this is how every live check talks to real Python processes.
  - State what the bridge does not do: no IFAC/interface authentication;
    whoever connects to the TCP port is trusted like any
    unauthenticated `TCPServerInterface`.
- Update "Running it" for anything Part 1 changed; keep
  "Deploying the demo"/"License" untouched except lingo fixes.

### 7. compliance.md → historical execution log

- Add a note up top: all phases complete; current parity status lives in
  `README.md#compliance`; this file is the execution history and scoping
  rationale.
- Delete the six checklist tables (they move to README — exactly one
  copy must exist).
- Add phase writeups + status-log entries for the Part 1 features, in
  the same factual style as existing phases.
- Strip tone throughout: "— ✅ Done" → "— done"; drop "genuinely";
  collapse repeated "real, unmodified X" to one "unmodified" per subject;
  replace bold self-congratulation in the status log with plain
  statements.

### 8. Code comment audit

Read **every** file below in full and fix comments that narrate the
development process, hype the result, or are no longer true. A good
comment states a wire-format constraint, a Python source location, or
why a formula/constant is what it is. Keep all `RNS/Link.py:75`-style
Python anchors — they're the point of the repo.

Known specific fixes (search for the quoted fragment):
- `shared/rns/index.js`, doc comment above `sendResource(...)`: claims
  "*receiving* one bigger than a single segment from a real peer still
  doesn't [work], since that needs HMU packets this project doesn't
  implement" — **false** (receive-side HMU is done; after Part 1 feature
  1, send-side is too). Rewrite to the then-current truth.
- `shared/rns/index.js`, `Link` constants: "replacing the fixed intervals
  this used to use" → drop the history.
- `shared/rns/protocol.js`, above `export const LINK_MDU`: keep the
  LINK_MDU ≠ RESOURCE_SDU warning (different formulas; conflating them
  breaks part counts past a size boundary), drop "a distinction easy to
  miss…" / "(found via live testing…)".
- `shared/rns/propagation.js`: "turned out to be identical (confirmed…"
  → state the envelope format is the same, no story. "so a sender no
  longer needs to be told the required cost out of band" → present
  tense.
- `browser/main.js`: "this demo's own send() now uses Link/Channel below"
  → drop "now" framing.
- All 10 `test-integration/*.mjs` headers start "Manual, throwaway
  check:". The 9 wired into `package.json` `test:integration*` scripts
  are the verification suite, not throwaway — rewrite each header to:
  what it verifies, exact run command (`PYLIBS=… npm run
  test:integration:<name>`), extra requirements (nomadnet/sbapp in
  PYLIBS; dev server for sparse-mesh). The 2 not in package.json
  (`manual-tcp-check.mjs`, `manual-webrtc-chain-check.mjs`) keep
  "Manual", lose "throwaway", state their `node <path>` invocation.

Sweep beyond the known list: grep `shared/ node/ browser/
test-integration/` for `\bnow\b`, `\bstill\b`, `used to`, `no longer`,
`turned out`, `previously`, `found via`, `genuinely` and read each hit
in context; rewrite temporal/discovery framing into present-tense fact.
Not every hit is wrong — judge each.

File list to read in full:
```
shared/rns/{index,protocol,propagation,buffer,channel,compression,crypto,msgpack,stamp,storage}.js
shared/{nostr-signaling,webrtc-rns-interface}.js
node/{index,tcp-gateway,webrtc-node,hdlc}.js
browser/{main,webrtc-browser}.js  browser/index.html
test-integration/*.mjs  test-integration/*.py
vite.config.js
test/*.test.js  (headers at least)
```

### 9. Final verification & ship

- `npm test` and `npx vite build --base=/reticulum-webrtc-tcp/` must be
  green (unit count will have grown past 77 with Part 1's tests).
- Re-run the full `test:integration:*` set once more after the doc/
  comment pass (comment-only edits can still break string literals).
- Commits: one per Part 1 feature (already done incrementally per the
  methodology), one final docs/comments commit. The docs commit message
  must call out explicitly: feature table moved from `compliance.md` to
  README; new WebRTC↔TCP bridge section; the stale HMU comment was
  factually wrong and is fixed; test-integration headers corrected;
  narrative/hype language removed.
- `git push -u origin claude/repo-cleanup-docs-oxxc2f` after each commit
  (retry with backoff on network failure only). No PR unless asked.

## Non-goals

- PAPER delivery (QR-encoded LXMF) and IFAC stay N/A — out of scope by
  design, documented as such in the table.
- Announce-rate *enforcement* stays off — matches RNS's own default-off
  `announce_rate_target`; the tracking mechanism already exists.
- No PR creation, no force-push, no hook skipping.
