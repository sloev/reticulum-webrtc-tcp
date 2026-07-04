#!/usr/bin/env python3
"""Scriptable RNS node for integration testing against this repo's JS stack.

Requires the real `rns` package (pip install rns). Driven entirely over
stdin/stdout as newline-delimited JSON, so a Node.js test harness can
orchestrate a real Reticulum instance as one node in a larger topology.

Commands (stdin, one JSON object per line):
  {"cmd": "announce"}
  {"cmd": "request_path", "dest_hash": "<hex>"}
  {"cmd": "send", "dest_hash": "<hex>", "text": "..."}

Events (stdout, one JSON object per line):
  {"event": "ready", "dest_hash": "<hex>", "identity_hash": "<hex>", "public_key": "<hex>"}
  {"event": "announce_received", "dest_hash": "<hex>", "hops": N}
  {"event": "packet_received", "dest_hash": "<hex>", "text": "..."}
"""
import sys
import json
import time
import argparse
import threading

import RNS


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configdir", required=True)
    parser.add_argument("--app-name", default="test")
    parser.add_argument("--aspect", default="integration")
    parser.add_argument("--identity-hex", default=None, help="64-byte private key as hex, for a deterministic identity")
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

    r = RNS.Reticulum(configdir=args.configdir)

    if args.identity_hex:
        identity = RNS.Identity(create_keys=False)
        identity.load_private_key(bytes.fromhex(args.identity_hex))
    else:
        identity = RNS.Identity()

    destination = RNS.Destination(identity, RNS.Destination.IN, RNS.Destination.SINGLE, args.app_name, args.aspect)

    def packet_callback(data, packet):
        try:
            text = data.decode("utf-8")
        except Exception:
            text = None
        emit("packet_received", dest_hash=destination.hash.hex(), text=text, data_hex=data.hex())

    destination.set_packet_callback(packet_callback)

    class Handler:
        aspect_filter = None

        def received_announce(self, destination_hash, announced_identity, app_data):
            hops = RNS.Transport.hops_to(destination_hash)
            emit("announce_received", dest_hash=destination_hash.hex(), hops=hops)

    RNS.Transport.register_announce_handler(Handler())

    emit(
        "ready",
        dest_hash=destination.hash.hex(),
        identity_hash=identity.hash.hex(),
        public_key=identity.get_public_key().hex(),
    )

    def handle_command(line):
        try:
            cmd = json.loads(line)
        except Exception:
            return

        if cmd.get("cmd") == "announce":
            destination.announce()
        elif cmd.get("cmd") == "request_path":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            RNS.Transport.request_path(dest_hash)
        elif cmd.get("cmd") == "send":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            peer_identity = RNS.Identity.recall(dest_hash)
            if peer_identity is None:
                emit("send_failed", dest_hash=cmd["dest_hash"], reason="identity not known")
                return
            out_dest = RNS.Destination(peer_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, args.app_name, args.aspect)
            RNS.Packet(out_dest, cmd["text"].encode("utf-8")).send()

    for line in sys.stdin:
        line = line.strip()
        if line:
            handle_command(line)


if __name__ == "__main__":
    main()
