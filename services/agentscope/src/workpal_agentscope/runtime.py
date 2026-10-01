"""Translate a WorkPal run into one AgentScope 2 execution."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from agentscope.agent import Agent, ContextConfig, InjectionConfig, ReActConfig
from agentscope.credential import OpenAICredential
from agentscope.event import (
    ModelCallEndEvent,
    ReplyEndEvent,
    TextBlockDeltaEvent,
    ToolCallDeltaEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolResultEndEvent,
    ToolResultStartEvent,
)
from agentscope.message import AssistantMsg, TextBlock, UserMsg
from agentscope.model import OpenAIChatModel
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, ToolChunk, Toolkit

from .contracts import RunRequest, ToolDefinition, WireEvent
from .state_store import StateStore

RUNTIME_TIME_TOOL = "runtime_current_time"


def _history_state(request: RunRequest) -> AgentState:
    state = AgentState()
    for item in request.history:
        if item.id and item.id == request.source_message_id:
            continue
        if item.role == "user":
            state.context.append(
                UserMsg(name="user", content=item.content, id=item.id),
            )
        elif item.role == "assistant":
            state.context.append(
                AssistantMsg(name="assistant", content=item.content, id=item.id),
            )
    return state


def _openai_base_url(provider: str | None, configured: str | None) -> str | None:
    if configured:
        return configured
    if provider == "openrouter":
        return "https://openrouter.ai/api/v1"
    return None


def _build_model(request: RunRequest) -> OpenAIChatModel:
    selected = request.model
    if selected.oauth:
        raise ValueError("OAuth model credentials are not supported by the AgentScope adapter yet")
    base_url = _openai_base_url(selected.provider, selected.base_url)
    supported = selected.provider in {"openai", "openrouter", "openai-compatible", "local", None}
    if not supported and not base_url:
        raise ValueError(
            f"Model provider '{selected.provider}' is not supported by the first AgentScope slice; "
            "use an OpenAI-compatible connection"
        )
    api_key = selected.api_key.get_secret_value() if selected.api_key else "not-required"
    effort = selected.thinking_level
    if effort == "off":
        effort = "none"
    if effort == "max":
        effort = "xhigh"
    parameters = OpenAIChatModel.Parameters(
        max_tokens=selected.max_tokens,
        thinking_enable=bool(selected.reasoning and effort != "none"),
        reasoning_effort=effort if effort in {"none", "minimal", "low", "medium", "high", "xhigh"} else None,
    )
    return OpenAIChatModel(
        credential=OpenAICredential(api_key=api_key, base_url=base_url),
        model=selected.id,
        parameters=parameters,
        stream=True,
        context_size=selected.context_window or 128_000,
    )


def _time_tool(definition: ToolDefinition) -> FunctionTool:
    async def current_time(**kwargs: Any) -> ToolChunk:
        zone_name = str(kwargs.get("timezone") or "UTC")
        try:
            zone = ZoneInfo(zone_name)
        except ZoneInfoNotFoundError:
            return ToolChunk(
                content=[TextBlock(text=json.dumps({"error": f"Unknown timezone: {zone_name}"}))],
            )
        now = datetime.now(timezone.utc)
        result = {
            "utc": now.isoformat().replace("+00:00", "Z"),
            "timezone": zone_name,
            "local": now.astimezone(zone).isoformat(),
        }
        return ToolChunk(content=[TextBlock(text=json.dumps(result))])

    return FunctionTool(
        current_time,
        name=definition.name,
        description=definition.description,
        input_schema=definition.input_schema,
        is_read_only=True,
        permission=PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="This read-only tool was approved by the WorkPal backend.",
        ),
    )


def _build_toolkit(request: RunRequest) -> Toolkit:
    tools = [
        _time_tool(definition)
        for definition in request.tools
        if definition.name == RUNTIME_TIME_TOOL
    ]
    return Toolkit(tools=tools)


def _parse_tool_args(raw: str) -> dict[str, Any]:
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else {"value": parsed}


async def execute_run(request: RunRequest, store: StateStore) -> AsyncIterator[WireEvent]:
    state = store.load(request.bot_id, request.thread_id) or _history_state(request)
    agent = Agent(
        name="assistant",
        system_prompt=request.instructions or "You are a concise, capable assistant.",
        model=_build_model(request),
        toolkit=_build_toolkit(request),
        state=state,
        context_config=ContextConfig(compression_tool_enabled=True),
        injection_config=InjectionConfig(timezone="Asia/Shanghai"),
        react_config=ReActConfig(max_iters=20),
    )
    user_message = UserMsg(
        name="user",
        content=request.prompt,
        id=request.source_message_id,
    )
    tool_names: dict[str, str] = {}
    tool_arguments: dict[str, str] = {}
    completed = False

    async for event in agent.reply_stream(user_message):
        if isinstance(event, TextBlockDeltaEvent):
            yield WireEvent(type="text", text=event.delta)
        elif isinstance(event, ToolCallStartEvent):
            tool_names[event.tool_call_id] = event.tool_call_name
            tool_arguments[event.tool_call_id] = ""
        elif isinstance(event, ToolCallDeltaEvent):
            tool_arguments[event.tool_call_id] = tool_arguments.get(event.tool_call_id, "") + event.delta
        elif isinstance(event, ToolCallEndEvent):
            yield WireEvent(
                type="tool",
                name=tool_names.get(event.tool_call_id, "unknown"),
                args=_parse_tool_args(tool_arguments.get(event.tool_call_id, "")),
                execution_id=event.tool_call_id,
            )
        elif isinstance(event, ToolResultStartEvent):
            yield WireEvent(
                type="progress",
                text=f"Running {event.tool_call_name}",
                activity=True,
            )
        elif isinstance(event, ToolResultEndEvent):
            label = tool_names.get(event.tool_call_id, "tool")
            yield WireEvent(
                type="progress",
                text=f"{label} {event.state}",
                activity=True,
            )
        elif isinstance(event, ModelCallEndEvent):
            yield WireEvent(
                type="usage",
                input_tokens=event.input_tokens,
                output_tokens=event.output_tokens,
                cache_read_tokens=event.cache_input_tokens,
                cache_write_tokens=event.cache_creation_input_tokens,
                provider=request.model.provider or "openai-compatible",
                model=request.model.id,
            )
        elif isinstance(event, ReplyEndEvent):
            if event.finished_reason == "error":
                message = event.error.message if event.error else "AgentScope run failed"
                raise RuntimeError(message)
            completed = event.finished_reason == "completed"

    if completed:
        store.save(request.bot_id, request.thread_id, state)
        yield WireEvent(type="done")
    elif request.allow_silent_empty:
        store.save(request.bot_id, request.thread_id, state)
        yield WireEvent(type="done")
    else:
        raise RuntimeError(request.empty_response_text or "AgentScope run ended without completing")
