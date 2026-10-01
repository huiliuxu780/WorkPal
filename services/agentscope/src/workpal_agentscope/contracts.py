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
    images: list["InputImage"] = Field(default_factory=list)


class InputImage(WireModel):
    name: str
    mime_type: Literal["image/jpeg", "image/png", "image/webp", "image/gif"]
    data: str


class ToolDefinition(WireModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    read_only: bool = False


class SkillDefinition(WireModel):
    id: str | None = None
    name: str
    description: str
    content: str


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


class BridgeIdentity(WireModel):
    user_id: str
    space_id: str
    bot_id: str
    thread_id: str
    run_id: str


class ToolBridge(WireModel):
    url: str
    steering_url: str | None = None
    model_url: str | None = None
    token: SecretStr
    identity: BridgeIdentity


class SteeringMessage(WireModel):
    id: str
    message_id: str
    text: str
    history_text: str | None = None
    images: list[InputImage] = Field(default_factory=list)


class RunRequest(WireModel):
    bot_id: str
    thread_id: str
    run_id: str
    source_message_id: str | None = None
    identity: BridgeIdentity | None = None
    prompt: str
    instructions: str = ""
    history: list[HistoryMessage] = Field(default_factory=list)
    current_turn_images: list[InputImage] = Field(default_factory=list)
    skills: list[SkillDefinition] = Field(default_factory=list)
    tools: list[ToolDefinition] = Field(default_factory=list)
    tool_bridge: ToolBridge | None = None
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
    detail: str | None = None
    actions: list[dict[str, str]] | None = None
    reason: str | None = None
    agent_id: str | None = None
    task: str | None = None
    status: str | None = None
    progress: str | None = None
    result: str | None = None
