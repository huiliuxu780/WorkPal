"""Loopback-only HTTP boundary for AgentScope execution."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import agentscope
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from . import __version__
from .contracts import RunRequest
from .runtime import execute_run
from .state_store import StateStore

app = FastAPI(title="WorkPal AgentScope", version=__version__)
_state_store = StateStore(Path(os.environ.get("AGENTSCOPE_STATE_DIR", "./data/agentscope-state")))
_active_runs: dict[str, asyncio.Task[object] | None] = {}
_active_threads: set[tuple[str, ...]] = set()
_active_lock = asyncio.Lock()


def _line(payload: dict[str, object]) -> bytes:
    return (json.dumps(payload, separators=(",", ":")) + "\n").encode()


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": "workpal-agentscope",
        "version": __version__,
        "agentscope": agentscope.__version__,
        "activeRuns": len(_active_runs),
    }


@app.post("/v1/runs")
async def run(request: RunRequest) -> StreamingResponse:
    if request.identity is None:
        raise HTTPException(status_code=422, detail="Trusted application identity is required")
    # Chat holds its durable state lease. Auxiliary runs are isolated by run ID, even when
    # invoked while the parent is waiting for a tool; they never touch durable chat state.
    scope = (
        request.identity.user_id,
        request.identity.space_id,
        request.bot_id,
        request.thread_id,
        request.execution_scope,
        "" if request.execution_scope == "chat" else request.run_id,
    )
    async with _active_lock:
        if request.run_id in _active_runs:
            raise HTTPException(status_code=409, detail="Run is already active")
        if scope in _active_threads:
            raise HTTPException(status_code=409, detail="Thread already has an active run")
        _active_threads.add(scope)
        _active_runs[request.run_id] = None

    async def stream():
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("AgentScope run has no asyncio task")
        async with _active_lock:
            _active_runs[request.run_id] = task
        try:
            async for event in execute_run(request, _state_store):
                yield _line(event.model_dump(by_alias=True, exclude_none=True))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # The wire error is intentionally credential-free.
            yield _line({"type": "error", "message": str(error)})
        finally:
            async with _active_lock:
                _active_runs.pop(request.run_id, None)
                _active_threads.discard(scope)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.delete("/v1/runs/{run_id}")
async def cancel(run_id: str) -> dict[str, object]:
    async with _active_lock:
        task = _active_runs.get(run_id)
    if task is None:
        return {"ok": True, "cancelled": False}
    task.cancel()
    return {"ok": True, "cancelled": True}
