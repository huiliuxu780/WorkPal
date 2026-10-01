"""Wire contracts shared with the TypeScript AgentRuntime adapter."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class HistoryMessage(WireModel):
    id: str | None = None
    role: Literal["user", "assistant", "system"]
    content: str


class ToolDefinition(WireModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    read_only: bool = False


class RunModel(WireModel):
    provider: str | None = None
    id: str
    api_key: SecretStr | None = None
    base_url: str | None = None
    reasoning: bool | None = None
    max_tokens: int | None = None
    context_window: int | None = None
    thinking_level: str | None = None
    oauth: dict[str, Any] | None = None


class RunRequest(WireModel):
    bot_id: str
    thread_id: str
    run_id: str
    source_message_id: str | None = None
    prompt: str
    instructions: str = ""
    history: list[HistoryMessage] = Field(default_factory=list)
    tools: list[ToolDefinition] = Field(default_factory=list)
    model: RunModel
    allow_silent_empty: bool = False
    empty_response_text: str | None = None


class WireEvent(WireModel):
    type: str
    text: str | None = None
    activity: bool | None = None
    name: str | None = None
    args: dict[str, Any] | None = None
    execution_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    provider: str | None = None
    model: str | None = None
    message: str | None = None
