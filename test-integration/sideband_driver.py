#!/usr/bin/env python3
"""Drives a real, unmodified `sbapp` (Sideband) client for interop testing
against this repo's JS stack (compliance.md Phase 6). Requires `pip install
sbapp` in addition to `rns`/`lxmf`.

Unlike the original plan's assumption, Sideband's `-d`/`--daemon` flag runs
genuinely headless: `sbapp/main.py` gates its entire Kivy/KivyMD/LXST (audio)
import block behind `if not args.daemon:`, so daemon mode never touches
Kivy's graphics stack at all — no virtual display, no GL context, no TUI
automation needed. `SidebandCore(...).start()` (the same two calls
`sbapp.main.run()` makes for `-d` mode) returns normally rather than
blocking forever, so this driver can just call them directly in the main
thread and run its own stdin-command loop afterward — no threading
workaround needed (unlike nomadnet_driver.py, whose NomadNetworkApp.__init__
runs its own blocking job loop inline).

Sending uses SidebandCore's own public `send_message(content, destination_
hash, propagation)` method — the same one Sideband's UI "send" button calls
internally — which itself defaults to LXMF's DIRECT delivery method (a real
Link) rather than OPPORTUNISTIC when the peer's identity has no known
ratchet yet, unlike nomadnet's own send path.

Commands (stdin, one JSON object per line):
  {"cmd": "send_to", "dest_hash": "<hex>", "content": "..."}

Events (stdout, one JSON object per line):
  {"event": "ready", "dest_hash": "<hex>", "identity_hash": "<hex>", "public_key": "<hex>", "display_name": "..."}
"""
import sys
import json
import argparse

import RNS
import LXMF
from sbapp.sideband.core import SidebandCore


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configdir", required=True)
    parser.add_argument("--rnsconfigdir", required=True)
    args = parser.parse_args()

    sideband = SidebandCore(
        None,
        config_path=args.configdir,
        is_client=False,
        verbose=True,
        quiet=False,
        is_daemon=True,
        rns_config_path=args.rnsconfigdir,
    )
    sideband.start()

    # SidebandCore.__init__ already registered its own lxmf_delivery as the
    # router's delivery callback (LXMRouter.register_delivery_callback() only
    # keeps one callback, overwriting on each call) — re-register a thin
    # wrapper that emits a JSON event for this test harness, then forwards to
    # the real, unmodified handler so Sideband's own storage/notification
    # logic still runs exactly as it would in normal use.
    real_lxmf_delivery = sideband.lxmf_delivery

    def lxmf_delivery_and_emit(message):
        emit(
            "lxmf_received",
            source_hash=message.source_hash.hex(),
            title=message.title_as_string(),
            content=message.content_as_string(),
            valid=message.signature_validated,
        )
        real_lxmf_delivery(message)

    sideband.message_router.register_delivery_callback(lxmf_delivery_and_emit)

    emit(
        "ready",
        dest_hash=sideband.lxmf_destination.hash.hex(),
        identity_hash=sideband.identity.hash.hex(),
        public_key=sideband.identity.get_public_key().hex(),
        display_name=sideband.config["display_name"],
    )

    def handle_command(line):
        try:
            cmd = json.loads(line)
        except Exception:
            return

        if cmd.get("cmd") == "send_to":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            ok = sideband.send_message(cmd.get("content", "hello"), dest_hash, False)
            if not ok:
                emit("send_failed", reason="send_message returned False")

    for line in sys.stdin:
        line = line.strip()
        if line:
            handle_command(line)


if __name__ == "__main__":
    main()
