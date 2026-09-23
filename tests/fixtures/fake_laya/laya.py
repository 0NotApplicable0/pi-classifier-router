"""Fake `laya` package for tests/laya-worker.test.ts.

Lets the REAL python/laya_worker.py run without torch or checkpoints. `predict`
counts its calls and sleeps for `state["sleep_ms"]` when given, so a test can
hold the single-threaded worker busy and observe which requests actually ran.
"""

from __future__ import annotations

import time

__version__ = "fake-0"

CALLS: list = []


class _Agent:
    def predict(self, state, questions, model=None):
        CALLS.append(state)
        if isinstance(state, dict) and isinstance(state.get("sleep_ms"), (int, float)):
            time.sleep(state["sleep_ms"] / 1000.0)
        return {
            "model": "fake-model",
            "answers": {"ran": {"type": "noul", "noul": 1.0, "confidence": 1.0}, "calls": len(CALLS), "state": state},
        }


def load(repo, subfolder=None, device=None):
    return _Agent()


def Router(**kwargs):
    return _Agent()
