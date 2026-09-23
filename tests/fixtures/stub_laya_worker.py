#!/usr/bin/env python3
"""Protocol stub for tests/laya.test.ts: no laya, no model, fully deterministic.

Speaks the same NDJSON protocol as python/laya_worker.py and echoes the parsed
request back inside `answers` so the client can prove correlation.

Environment:
    STUB_LAYA_MODE              predict behaviour:
                                  normal (default) - echo the request in answers
                                  crash            - exit(7) without replying
                                  timeout          - never reply (client must time out)
                                  fail_protocol    - reply ok:false kind:"protocol"
                                  fail_unavailable - reply ok:false kind:"unavailable"
    STUB_LAYA_READY_DELAY_MS    delay before the `ready` event (default 0)
    STUB_LAYA_NOISE             "1" writes non-JSON noise lines on stdout
    STUB_LAYA_CRASH_ONCE        path to a marker file: the first `predict` removes
                                it and exits(7); later spawns behave normally
    STUB_LAYA_SPAWN_LOG         path to a file: each start appends one line, so a
                                test can count how often the sidecar was spawned
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def noise() -> None:
    if os.environ.get("STUB_LAYA_NOISE") == "1":
        sys.stdout.write("stub: this line is not JSON\n")
        sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(prog="stub_laya_worker")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--subfolder", default="")
    parser.add_argument("--device", default="")
    parser.add_argument("--router", action="store_true")
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--max-loaded", type=int, default=1)
    args = parser.parse_args()

    spawn_log = os.environ.get("STUB_LAYA_SPAWN_LOG")
    if spawn_log:
        with open(spawn_log, "a", encoding="utf8") as handle:
            handle.write(f"{os.getpid()}\n")

    mode = os.environ.get("STUB_LAYA_MODE", "normal")
    crash_once = os.environ.get("STUB_LAYA_CRASH_ONCE")
    delay = float(os.environ.get("STUB_LAYA_READY_DELAY_MS", "0")) / 1000.0
    # Tests read this back through the client's stderr logger to prove argv.
    print("STUB_LAYA_ARGS " + json.dumps(sys.argv[1:]), file=sys.stderr)
    sys.stderr.flush()
    if delay:
        time.sleep(delay)

    loaded = ["english", "multilingual"] if (args.preload or args.router) else []
    noise()
    emit({"event": "ready", "version": "stub-0", "loaded": loaded})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        request = json.loads(line)
        rid = request.get("id")
        op = request.get("op")

        if op == "shutdown":
            emit({"id": rid, "ok": True, "result": {"bye": True}})
            return 0

        if op == "ping":
            emit({"id": rid, "ok": True, "result": {"laya": True, "version": "stub-0", "loaded": loaded}})
            continue

        if op == "preload":
            loaded = ["english", "multilingual"]
            emit({"id": rid, "ok": True, "result": {"loaded": loaded}})
            continue

        if op == "predict":
            if crash_once and os.path.exists(crash_once):
                os.remove(crash_once)
                sys.stdout.flush()
                os._exit(7)
            if mode == "crash":
                sys.stdout.flush()
                os._exit(7)
            if mode == "timeout":
                time.sleep(600)
                continue
            if mode == "fail_protocol":
                emit({"id": rid, "ok": False, "error": "stub protocol failure", "kind": "protocol"})
                continue
            if mode == "fail_unavailable":
                emit({"id": rid, "ok": False, "error": "stub unavailable", "kind": "unavailable"})
                continue
            noise()
            emit(
                {
                    "id": rid,
                    "ok": True,
                    "result": {
                        "model": "stub-model",
                        "answers": {"echo": request},
                        "usage": {"input_tokens": len(json.dumps(request)), "output_tokens": 1},
                    },
                }
            )
            continue

        emit({"id": rid, "ok": False, "error": f"unknown op: {op!r}", "kind": "protocol"})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
