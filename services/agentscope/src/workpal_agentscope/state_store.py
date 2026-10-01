"""Durable AgentScope model context, separate from WorkPal's complete chat history."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from agentscope.state import AgentState


@dataclass
class StateSnapshot:
    state: AgentState
    revision: int = 0
    last_source_message_id: str | None = None


class StateStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(
        self,
        bot_id: str,
        thread_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> Path:
        # Production requests include user and space from the trusted TS adapter. Keeping them
        # in the key makes a copied/corrupt thread id insufficient to cross a tenant boundary.
        scope = f"{user_id or 'legacy'}:{space_id or 'legacy'}:{bot_id}:{thread_id}"
        digest = hashlib.sha256(scope.encode()).hexdigest()
        return self.root / digest[:2] / f"{digest}.json"

    def load(
        self,
        bot_id: str,
        thread_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> StateSnapshot | None:
        path = self._path(bot_id, thread_id, user_id, space_id)
        if not path.exists():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and raw.get("version") == 2 and isinstance(raw.get("state"), dict):
            return StateSnapshot(
                state=AgentState.model_validate(raw["state"]),
                revision=max(0, int(raw.get("revision") or 0)),
                last_source_message_id=(
                    raw.get("lastSourceMessageId")
                    if isinstance(raw.get("lastSourceMessageId"), str)
                    else None
                ),
            )
        # Read-only compatibility for the first WorkPal slice. A scoped production key will not
        # collide with its earlier unscoped path; this is mainly useful for local test/dev data.
        return StateSnapshot(state=AgentState.model_validate(raw))

    def save(
        self,
        bot_id: str,
        thread_id: str,
        state: AgentState,
        *,
        user_id: str | None = None,
        space_id: str | None = None,
        last_source_message_id: str | None = None,
        previous_revision: int = 0,
    ) -> StateSnapshot:
        path = self._path(bot_id, thread_id, user_id, space_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        current = self.load(bot_id, thread_id, user_id, space_id)
        current_revision = current.revision if current else 0
        if current_revision != previous_revision:
            raise RuntimeError("AgentScope state changed during this run; refusing a stale overwrite")
        snapshot = StateSnapshot(
            state=state,
            revision=previous_revision + 1,
            last_source_message_id=last_source_message_id,
        )
        payload: dict[str, Any] = {
            "version": 2,
            "revision": snapshot.revision,
            "lastSourceMessageId": last_source_message_id,
            "state": state.model_dump(mode="json"),
        }
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        return snapshot
