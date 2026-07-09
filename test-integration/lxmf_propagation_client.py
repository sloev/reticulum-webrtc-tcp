#!/usr/bin/env python3
"""A real LXMF end-user client (LXMF.LXMRouter without enable_propagation()),
for testing this repo's JS PropagationNode._onRealGetRequest() against the
actual reference implementation's propagation-node sync client. Driven over
stdin/stdout as newline-delimited JSON, same convention as rns_node.py and
lxmf_propagation_node.py.

Requires the real `rns` and `lxmf` packages (pip install rns lxmf).

Commands (stdin):
  {"cmd": "set_node", "dest_hash": "<hex>"} — set_outbound_propagation_node()
  {"cmd": "sync"}                           — request_messages_from_propagation_node()

Events (stdout):
  {"event": "ready", "dest_hash": "<hex>", "identity_hash": "<hex>", "public_key": "<hex>"}
  {"event": "announce_received", "dest_hash": "<hex>", "hops": N}
  {"event": "lxmf_received", "source_hash": "<hex>", "title": "...", "content": "...", "valid": bool}
  {"event": "sync_state", "state": N} — LXMRouter.PR_* after each sync attempt
"""
import sys
import json
import time
import argparse
import threading

import RNS
import LXMF


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configdir", required=True)
    parser.add_argument("--tcp-target-host", default=None)
    parser.add_argument("--tcp-target-port", type=int, default=None)
    args = parser.parse_args()

    import os
    os.makedirs(args.configdir, exist_ok=True)
    config_path = os.path.join(args.configdir, "config")
    if not os.path.isfile(config_path):
        interfaces = ""
        if args.tcp_target_host and args.tcp_target_port:
            interfaces = f"""
[[Bridge]]
  type = TCPClientInterface
  interface_enabled = True
  target_host = {args.tcp_target_host}
  target_port = {args.tcp_target_port}
"""
        with open(config_path, "w") as f:
            f.write(f"""[reticulum]
enable_transport = True
share_instance = False
panic_on_interface_error = False

[logging]
loglevel = 3

[interfaces]
{interfaces}
""")

    RNS.Reticulum(configdir=args.configdir)

    identity = RNS.Identity()
    router = LXMF.LXMRouter(identity=identity, storagepath=args.configdir)
    delivery_destination = router.register_delivery_identity(identity)

    def on_delivery(message):
        emit(
            "lxmf_received",
            source_hash=message.source_hash.hex(),
            title=message.title_as_string(),
            content=message.content_as_string(),
            valid=message.signature_validated,
        )

    router.register_delivery_callback(on_delivery)

    class Handler:
        aspect_filter = None

        def received_announce(self, destination_hash, announced_identity, app_data):
            hops = RNS.Transport.hops_to(destination_hash)
            emit("announce_received", dest_hash=destination_hash.hex(), hops=hops)

    RNS.Transport.register_announce_handler(Handler())

    # So the JS side (running propagateLXMF()) can look up this identity to
    # encrypt a message to it, exactly like it would after receiving a real
    # announce from any other lxmf.delivery destination.
    router.announce(delivery_destination.hash)

    emit(
        "ready",
        dest_hash=delivery_destination.hash.hex(),
        identity_hash=identity.hash.hex(),
        public_key=identity.get_public_key().hex(),
    )

    def poll_sync_state():
        # LXMRouter's own sync state machine is background-thread-driven
        # (jobloop); surface every state change so the test harness can wait
        # for PR_COMPLETE (or a failure state) without polling from the JS
        # side.
        last = None
        while True:
            state = router.propagation_transfer_state
            if state != last:
                emit("sync_state", state=state)
                last = state
            time.sleep(0.1)

    threading.Thread(target=poll_sync_state, daemon=True).start()

    def handle_command(line):
        try:
            cmd = json.loads(line)
        except Exception:
            return

        if cmd.get("cmd") == "set_node":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            router.set_outbound_propagation_node(dest_hash)
        elif cmd.get("cmd") == "sync":
            router.request_messages_from_propagation_node(identity, LXMF.LXMRouter.PR_ALL_MESSAGES)

    for line in sys.stdin:
        line = line.strip()
        if line:
            handle_command(line)


if __name__ == "__main__":
    main()
