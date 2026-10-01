"""Durable AgentScope state, separate from WorkPal's complete chat history."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from uuid import uuid4

from agentscope.state import AgentState


class StateStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, bot_id: str, thread_id: str) -> Path:
        digest = hashlib.sha256(f"{bot_id}:{thread_id}".encode()).hexdigest()
        return self.root / digest[:2] / f"{digest}.json"

    def load(self, bot_id: str, thread_id: str) -> AgentState | None:
        path = self._path(bot_id, thread_id)
        if not path.exists():
            return None
        return AgentState.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, bot_id: str, thread_id: str, state: AgentState) -> None:
        path = self._path(bot_id, thread_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        data = state.model_dump_json()
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
