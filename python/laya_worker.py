#!/usr/bin/env python3
"""Laya sidecar worker: NDJSON request/response over stdio.

stdout carries exactly one JSON object per line and nothing else, so the
TypeScript client can parse strictly; every diagnostic (including warnings and
progress) goes to stderr. Module-level state keeps the checkpoints loaded across
requests.

Requests are served one at a time and a running prediction cannot be
interrupted, so a request the client already abandoned would still run and push
every later request past its own timeout. Each request may carry `deadline`
(epoch milliseconds, same host so same clock); an expired `predict` or
`preload` is answered with a `timeout` error without being run.

Protocol
    request  {"id": <int>, "op": "predict"|"ping"|"preload"|"shutdown", "deadline"?: <epoch ms>, ...}
    reply    {"id": <int>, "ok": true,  "result": {...}}
           | {"id": <int>, "ok": false, "error": "...", "kind": "unavailable"|"timeout"|"protocol"}
    event    {"event": "ready", "version": "...", "loaded": ["english", ...]}
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import time
import traceback


def emit(payload: dict) -> None:
    """Write one JSON line and flush immediately (the client is line-driven)."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


try:
    import laya
# A missing OR broken install (torch/transformers raise all sorts at import time)
# must be reported as unavailable, never look like a protocol fault.
except Exception as exc:  # noqa: BLE001
    emit({"event": "error", "error": f"laya import failed: {exc!r}", "kind": "unavailable"})
    print("laya_worker: could not import laya", file=sys.stderr)
    print(traceback.format_exc(), file=sys.stderr)
    sys.stderr.flush()
    raise SystemExit(2) from exc


STATE = {"agent": None, "loaded": []}

# Ops that do real work and are worth skipping once the client has stopped waiting.
DEADLINED_OPS = ("predict", "preload")


def expired(request: dict) -> bool:
    """True when the request carries a deadline that has already passed."""
    deadline = request.get("deadline")
    if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
        return False
    return time.time() * 1000.0 > deadline


def describe_loaded(agent, fallback: str | None) -> list[str]:
    """Best-effort checkpoint names, for the ready/preload/ping payloads."""
    for attr in ("loaded", "checkpoints", "loaded_checkpoints", "checkpoint_names"):
        value = getattr(agent, attr, None)
        if isinstance(value, dict) and value:
            return [str(key) for key in value]
        if isinstance(value, (list, tuple)) and value:
            return [str(item) for item in value]
    return [fallback] if fallback else []


def ensure_agent(args) -> object:
    """Load the checkpoints once; later calls reuse the module-level agent."""
    if STATE["agent"] is not None:
        return STATE["agent"]
    if args.router:
        # laya.Router takes no repo or subfolder: it always serves the upstream
        # convaiinnovations/laya checkpoints, so --repo/--subfolder are unused here.
        kwargs: dict = {"preload": args.preload}
        if args.device:
            kwargs["device"] = args.device
        if args.max_loaded is None:
            # Laya's own default keeps English + multilingual resident.
            agent = laya.Router(**kwargs)
        else:
            try:
                agent = laya.Router(max_loaded=args.max_loaded, **kwargs)
            except TypeError:
                # Older Router builds do not take max_loaded.
                print("laya_worker: this laya.Router ignores --max-loaded", file=sys.stderr)
                agent = laya.Router(**kwargs)
    else:
        kwargs = {"subfolder": args.subfolder or None}
        if args.device:
            kwargs["device"] = args.device
        agent = laya.load(args.repo, **kwargs)
    STATE["agent"] = agent
    return agent


def normalize(reply) -> dict:
    """Reduce a backend reply to `{model?, answers, usage?}`."""
    if isinstance(reply, dict):
        model = reply.get("model")
        answers = reply.get("answers")
        usage = reply.get("usage")
    else:
        model = getattr(reply, "model", None)
        answers = getattr(reply, "answers", None)
        usage = getattr(reply, "usage", None)
    if not isinstance(answers, dict):
        raise ValueError("laya returned no answers mapping")
    result: dict = {"answers": answers}
    if isinstance(model, str):
        result["model"] = model
    if isinstance(usage, dict):
        result["usage"] = usage
    return result


def error_kind(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, (ImportError, RuntimeError)):
        return "unavailable"
    return "protocol"


def handle(request: dict, args) -> dict | None:
    """Serve one request; returns the reply, or None for shutdown."""
    rid = request.get("id")
    op = request.get("op")

    if op == "predict":
        agent = ensure_agent(args)
        state = request.get("state")
        questions = request.get("questions")
        model = request.get("model")
        reply = agent.predict(state, questions, model=model) if model else agent.predict(state, questions)
        return {"id": rid, "ok": True, "result": normalize(reply)}

    if op == "ping":
        return {
            "id": rid,
            "ok": True,
            "result": {
                "laya": True,
                "version": getattr(laya, "__version__", "unknown"),
                "loaded": list(STATE["loaded"]),
            },
        }

    if op == "preload":
        agent = ensure_agent(args)
        STATE["loaded"] = describe_loaded(agent, args.subfolder or "english")
        return {"id": rid, "ok": True, "result": {"loaded": list(STATE["loaded"])}}

    if op == "shutdown":
        return {"id": rid, "ok": True, "result": {"bye": True}}

    return {"id": rid, "ok": False, "error": f"unknown op: {op!r}", "kind": "protocol"}


def main() -> int:
    parser = argparse.ArgumentParser(prog="laya_worker", description="Laya System One sidecar")
    parser.add_argument("--repo", required=True, help="Hugging Face repo bundling the checkpoints")
    parser.add_argument("--subfolder", default="", help="checkpoint subfolder; empty means the English root")
    parser.add_argument("--device", default="", help="torch device; empty means auto-detect")
    parser.add_argument("--router", action="store_true", help="serve through laya.Router")
    parser.add_argument("--preload", action="store_true", help="load checkpoints before serving")
    parser.add_argument(
        "--max-loaded",
        type=int,
        default=None,
        help="checkpoints laya.Router keeps resident; omitted means Laya's default",
    )
    args = parser.parse_args()

    # flush() after every line is the real guarantee; this only helps.
    with contextlib.suppress(AttributeError, OSError, ValueError):
        sys.stdout.reconfigure(line_buffering=True)

    if args.preload:
        ensure_agent(args)
        STATE["loaded"] = describe_loaded(STATE["agent"], args.subfolder or "english")
    else:
        STATE["loaded"] = []

    emit(
        {
            "event": "ready",
            "version": getattr(laya, "__version__", "unknown"),
            "loaded": list(STATE["loaded"]),
        }
    )

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except (ValueError, RecursionError) as exc:
            print(f"laya_worker: ignoring unparseable request line ({exc})", file=sys.stderr)
            continue
        if not isinstance(request, dict):
            print("laya_worker: ignoring non-object request", file=sys.stderr)
            continue

        if request.get("op") in DEADLINED_OPS and expired(request):
            emit(
                {
                    "id": request.get("id"),
                    "ok": False,
                    "error": "deadline passed while queued; request skipped",
                    "kind": "timeout",
                }
            )
            continue

        try:
            reply = handle(request, args)
            if reply is not None:
                emit(reply)
        # Every request gets a reply, whatever the backend raised, so the client
        # never waits out its timeout on a request the worker already abandoned.
        except BaseException as exc:  # noqa: BLE001
            print(traceback.format_exc(), file=sys.stderr)
            emit(
                {
                    "id": request.get("id"),
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "kind": error_kind(exc),
                }
            )

        if request.get("op") == "shutdown":
            sys.stdout.flush()
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
