"""Translate a WorkPal run into one AgentScope 2 execution."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, AsyncIterator
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from agentscope.agent import Agent, ContextConfig, InjectionConfig, ReActConfig
from agentscope.credential import (
    AnthropicCredential,
    DeepSeekCredential,
    GeminiCredential,
    MiniMaxCredential,
    MoonshotCredential,
    OpenAICredential,
    XAICredential,
)
from agentscope.event import (
    ExternalExecutionResultEvent,
    ModelCallEndEvent,
    ReplyEndEvent,
    RequireExternalExecutionEvent,
    TextBlockDeltaEvent,
    ToolCallDeltaEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolResultEndEvent,
    ToolResultStartEvent,
)
from agentscope.message import (
    AssistantMsg,
    Base64Source,
    DataBlock,
    TextBlock,
    ToolResultBlock,
    ToolResultState,
    UserMsg,
)
from agentscope.model import (
    AnthropicChatModel,
    DeepSeekChatModel,
    GeminiChatModel,
    MiniMaxChatModel,
    MoonshotChatModel,
    OpenAIChatModel,
    XAIChatModel,
)
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.skill import Skill
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, ToolBase, ToolChunk, Toolkit

from .contracts import (
    InputImage,
    RunModel,
    RunRequest,
    SteeringMessage,
    ToolBridge,
    ToolDefinition,
    WireEvent,
)
from .state_store import StateStore

RUNTIME_TIME_TOOL = "runtime_current_time"
SPECIAL_PAUSE_TOOLS = {"ask_user", "request_takeover"}
DELEGATION_TOOL_NAMES = {
    "run_subagent",
    "spawn_bot",
    "archive_bot",
    "delete_bot",
    "handoff_to_bot",
    "message_bot",
}
TRUSTED_BRIDGE_HOSTS = {"127.0.0.1", "localhost", "::1", "api", "worker"}


def _data_block(image: InputImage) -> DataBlock:
    return DataBlock(
        name=image.name,
        source=Base64Source(data=image.data, media_type=image.mime_type),
    )


def _message_content(text: str, images: list[InputImage]) -> str | list[TextBlock | DataBlock]:
    if not images:
        return text
    return [TextBlock(text=text), *[_data_block(image) for image in images]]


def _history_state(request: RunRequest, excluded_message_ids: set[str] | None = None) -> AgentState:
    state = AgentState()
    for item in request.history:
        if item.id and (
            item.id == request.source_message_id
            or item.id in (excluded_message_ids or set())
        ):
            continue
        _append_history_message(state, item)
    return state


def _append_history_message(state: AgentState, item: Any) -> None:
    content = _message_content(item.content, item.images)
    if item.role == "user":
        if item.id:
            name = "user"
        elif item.content.startswith("Rakazo-owned compacted context through message sequence"):
            name = "workpal_compacted_context"
        elif item.content.startswith("Memory recalled from earlier conversations"):
            name = "workpal_recalled_memory"
        else:
            name = "workpal_context"
        state.context.append(UserMsg(name=name, content=content, id=item.id))
    elif item.role == "assistant":
        state.context.append(AssistantMsg(name="assistant", content=content, id=item.id))


def _restored_state(request: RunRequest, loaded: AgentState, last_source_message_id: str | None) -> AgentState:
    # Tool permission/confirmation and unfinished-reply fields are execution-local. Rebuilding
    # the shell around the durable context prevents an old snapshot from restoring an obsolete
    # permission decision, tool registry, system prompt, model, or in-flight tool call.
    durable_context = [
        message
        for message in loaded.context
        if not (isinstance(message.name, str) and message.name.startswith("workpal_"))
    ]
    state = AgentState(
        context=durable_context,
        summary=loaded.summary,
        middle_context=loaded.middle_context,
    )
    # Semantic recall is query-specific and must be refreshed once per run. The application
    # compacted summary is intentionally not re-injected: the AgentScope snapshot already owns
    # its compressed context, so including both would duplicate old conversation state.
    recalled = [
        item
        for item in request.history
        if item.id is None
        and not item.content.startswith("Rakazo-owned compacted context through message sequence")
    ]
    for item in reversed(recalled):
        holder = AgentState()
        _append_history_message(holder, item)
        state.context[0:0] = holder.context
    if not request.history:
        return state
    marker_index = next(
        (
            index
            for index, item in enumerate(request.history)
            if item.id and item.id == last_source_message_id
        ),
        None,
    )
    if marker_index is None:
        # The backend transcript is authoritative. A missing marker means the state belongs to
        # a history window we cannot safely reconcile, so rebuild from the supplied context.
        return _history_state(request)
    # The loaded AgentScope context already contains the assistant response immediately after
    # the marker. Only append later user-originated history (and its following assistants), while
    # still excluding the current source message that will be supplied as this run's input.
    trailing = request.history[marker_index + 1 :]
    first_new_user = next(
        (index for index, item in enumerate(trailing) if item.role == "user"),
        len(trailing),
    )
    for item in trailing[first_new_user:]:
        if item.id and item.id == request.source_message_id:
            continue
        _append_history_message(state, item)
    return state


def _openai_base_url(provider: str | None, configured: str | None) -> str | None:
    if configured:
        return configured
    if provider == "openrouter":
        return "https://openrouter.ai/api/v1"
    if provider == "dashscope":
        return "https://dashscope.aliyuncs.com/compatible-mode/v1"
    return None


def _thinking_effort(request: RunRequest) -> str | None:
    effort = request.model.thinking_level
    if effort == "off":
        return "none"
    if effort == "max":
        return "xhigh"
    return effort


def _build_model(request: RunRequest) -> Any:
    selected = request.model
    if selected.oauth:
        raise ValueError("OAuth model credentials are not supported by the AgentScope adapter yet")
    base_url = _openai_base_url(selected.provider, selected.base_url)
    supported = selected.provider in {
        "openai",
        "openrouter",
        "openai-compatible",
        "local",
        "dashscope",
        "anthropic",
        "google",
        "xai",
        "deepseek",
        "minimax",
        "minimax-cn",
        "moonshotai",
        "moonshotai-cn",
        None,
    }
    if not supported and not base_url:
        raise ValueError(
            f"Model provider '{selected.provider}' is not supported by the AgentScope runtime; "
            "use a supported API-key provider or an OpenAI-compatible connection",
        )
    api_key = selected.api_key.get_secret_value() if selected.api_key else "not-required"
    effort = _thinking_effort(request)
    thinking_enable = bool(
        (selected.reasoning or selected.provider == "dashscope" or effort is not None)
        and effort != "none"
    )
    context_size = selected.context_window or (
        1_000_000
        if selected.provider == "dashscope" and selected.id.startswith("qwen3.8-")
        else 128_000
    )
    if selected.provider == "anthropic":
        return AnthropicChatModel(
            credential=AnthropicCredential(api_key=api_key, base_url=selected.base_url),
            model=selected.id,
            parameters=AnthropicChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
                reasoning_effort=effort,
            ),
            stream=True,
            context_size=context_size,
        )
    if selected.provider == "google":
        return GeminiChatModel(
            credential=GeminiCredential(api_key=api_key),
            model=selected.id,
            parameters=GeminiChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
            ),
            stream=True,
            context_size=context_size,
        )
    if selected.provider == "xai":
        return XAIChatModel(
            credential=XAICredential(api_key=api_key),
            model=selected.id,
            parameters=XAIChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
                reasoning_effort=effort,
            ),
            stream=True,
            context_size=context_size,
        )
    if selected.provider == "deepseek":
        return DeepSeekChatModel(
            credential=DeepSeekCredential(api_key=api_key),
            model=selected.id,
            parameters=DeepSeekChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
                reasoning_effort=effort,
            ),
            stream=True,
            context_size=context_size,
        )
    if selected.provider in {"minimax", "minimax-cn"}:
        minimax_url = (
            "https://api.minimaxi.com/anthropic"
            if selected.provider == "minimax-cn"
            else "https://api.minimax.io/anthropic"
        )
        return MiniMaxChatModel(
            credential=MiniMaxCredential(
                api_key=api_key,
                base_url=selected.base_url or minimax_url,
            ),
            model=selected.id,
            parameters=MiniMaxChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
            ),
            stream=True,
            context_size=context_size,
        )
    if selected.provider in {"moonshotai", "moonshotai-cn"}:
        moonshot_url = (
            "https://api.moonshot.cn/v1"
            if selected.provider == "moonshotai-cn"
            else "https://api.moonshot.ai/v1"
        )
        return MoonshotChatModel(
            credential=MoonshotCredential(
                api_key=api_key,
                base_url=selected.base_url or moonshot_url,
            ),
            model=selected.id,
            parameters=MoonshotChatModel.Parameters(
                max_tokens=selected.max_tokens,
                thinking_enable=thinking_enable,
                reasoning_effort=effort,
            ),
            stream=True,
            context_size=context_size,
        )
    parameters = OpenAIChatModel.Parameters(
        max_tokens=selected.max_tokens,
        thinking_enable=thinking_enable,
        reasoning_effort=(
            effort
            if effort in {"none", "minimal", "low", "medium", "high", "xhigh"}
            else None
        ),
    )
    return OpenAIChatModel(
        credential=OpenAICredential(api_key=api_key, base_url=base_url),
        model=selected.id,
        parameters=parameters,
        stream=True,
        context_size=context_size,
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
        input_schema=_normalized_schema(definition.input_schema),
        is_read_only=True,
        permission=_backend_permission(),
    )


def _backend_permission() -> PermissionDecision:
    return PermissionDecision(
        behavior=PermissionBehavior.ALLOW,
        message="Authorization and approval are enforced by the WorkPal backend.",
    )


def _normalized_schema(schema: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(schema)
    normalized.setdefault("type", "object")
    normalized.setdefault("properties", {})
    return normalized


class BackendTool(ToolBase):
    """An AgentScope tool whose implementation remains in the trusted app backend."""

    is_external_tool = True

    def __init__(self, definition: ToolDefinition) -> None:
        super().__init__()
        self.name = definition.name
        self.description = definition.description
        self.input_schema = _normalized_schema(definition.input_schema)
        self.is_concurrency_safe = definition.read_only
        self.is_read_only = definition.read_only

    async def check_permissions(self, *_args: Any, **_kwargs: Any) -> PermissionDecision:
        # This only permits dispatch to the bridge. The application backend independently
        # checks the immutable run identity, exact tool allow-list, action policy, approval,
        # connector binding, and effect idempotency before doing anything.
        return _backend_permission()


def _build_toolkit(
    request: RunRequest,
    definitions: list[ToolDefinition] | None = None,
) -> Toolkit:
    tools: list[ToolBase] = []
    for definition in definitions if definitions is not None else request.tools:
        if definition.name == RUNTIME_TIME_TOOL:
            tools.append(_time_tool(definition))
        else:
            tools.append(BackendTool(definition))
    skills = [
        Skill(
            name=item.name,
            description=item.description,
            dir=f"workpal://skills/{item.id or item.name}",
            markdown=item.content,
            updated_at=0.0,
        )
        for item in request.skills
    ]
    return Toolkit(tools=tools, skills_or_loaders=skills)


@dataclass
class _SubagentOutcome:
    result: str
    paused: bool = False


async def _subagent_events(
    request: RunRequest,
    agent_id: str,
    args: dict[str, Any],
    seen_steering_ids: list[str],
) -> AsyncGenerator[WireEvent | _SubagentOutcome, None]:
    name = str(args.get("name") or "helper").strip()[:80] or "helper"
    task = str(args.get("task") or "").strip() or "Complete the delegated task."
    extra = str(args.get("instructions") or "").strip()
    provider = str(args.get("model_provider") or "").strip()
    model_id = str(args.get("model_id") or "").strip()
    yield WireEvent(
        type="subagent",
        agent_id=agent_id,
        name=name,
        task=task,
        status="running",
        progress="starting…",
    )
    if bool(provider) != bool(model_id):
        message = "model_provider and model_id must both be set"
        yield WireEvent(
            type="subagent",
            agent_id=agent_id,
            name=name,
            task=task,
            status="failed",
            result=message,
        )
        yield _SubagentOutcome(f"Subagent failed: {message}")
        return
    try:
        model_request = (
            await _resolve_subagent_request(request, provider, model_id)
            if provider
            else request
        )
    except Exception as error:
        message = str(error)
        yield WireEvent(
            type="subagent",
            agent_id=agent_id,
            name=name,
            task=task,
            status="failed",
            result=message,
        )
        yield _SubagentOutcome(f"Subagent failed: {message}")
        return

    child_tools = [tool for tool in request.tools if tool.name not in DELEGATION_TOOL_NAMES]
    child = Agent(
        name=name,
        system_prompt=" ".join(
            value
            for value in [
                f'You are a WorkPal subagent named "{name}".',
                "You run inside the parent bot's turn and are not a separate bot chat.",
                "Complete the task and return a concise result. Do not delegate further.",
                extra,
            ]
            if value
        ),
        model=_build_model(model_request),
        toolkit=_build_toolkit(request, child_tools),
        state=AgentState(),
        context_config=ContextConfig(compression_tool_enabled=True),
        injection_config=InjectionConfig(timezone="Asia/Shanghai"),
        react_config=ReActConfig(max_iters=20),
    )
    next_input: Any = UserMsg(name="user", content=task)
    streamed = ""
    child_tool_names: dict[str, str] = {}
    child_tool_args: dict[str, str] = {}
    completed = False

    while True:
        external: RequireExternalExecutionEvent | None = None
        try:
            async for event in child.reply_stream(next_input):
                if isinstance(event, TextBlockDeltaEvent):
                    streamed += event.delta
                    yield WireEvent(
                        type="subagent",
                        agent_id=agent_id,
                        name=name,
                        task=task,
                        status="running",
                        progress=streamed[-800:],
                    )
                elif isinstance(event, ToolCallStartEvent):
                    child_tool_names[event.tool_call_id] = event.tool_call_name
                    child_tool_args[event.tool_call_id] = ""
                elif isinstance(event, ToolCallDeltaEvent):
                    child_tool_args[event.tool_call_id] = (
                        child_tool_args.get(event.tool_call_id, "") + event.delta
                    )
                elif isinstance(event, ToolCallEndEvent):
                    tool_name = child_tool_names.get(event.tool_call_id, "tool")
                    yield WireEvent(
                        type="subagent",
                        agent_id=agent_id,
                        name=name,
                        task=task,
                        status="running",
                        progress=f"using {tool_name}…",
                    )
                elif isinstance(event, RequireExternalExecutionEvent):
                    external = event
                elif isinstance(event, ModelCallEndEvent):
                    yield WireEvent(
                        type="usage",
                        input_tokens=event.input_tokens,
                        output_tokens=event.output_tokens,
                        cache_read_tokens=event.cache_input_tokens,
                        cache_write_tokens=event.cache_creation_input_tokens,
                        provider=model_request.model.provider or "openai-compatible",
                        model=model_request.model.id,
                    )
                elif isinstance(event, ReplyEndEvent):
                    if event.finished_reason == "error":
                        message = event.error.message if event.error else "Subagent failed"
                        raise RuntimeError(message)
                    completed = event.finished_reason == "completed"
        except Exception as error:  # Keep child failure inside its parent tool result.
            message = str(error)
            yield WireEvent(
                type="subagent",
                agent_id=agent_id,
                name=name,
                task=task,
                status="failed",
                result=message,
            )
            yield _SubagentOutcome(f"Subagent failed: {message}")
            return

        if external is None:
            break
        results: list[ToolResultBlock] = []
        for call in external.tool_calls:
            call_args = _parse_tool_args(call.input)
            if call.name == "ask_user":
                yield _ask_event(call_args)
                yield _SubagentOutcome("Subagent is waiting for the user.", paused=True)
                return
            if call.name == "request_takeover":
                yield WireEvent(
                    type="takeover",
                    reason=str(call_args.get("reason") or "I need you on the screen."),
                )
                yield _SubagentOutcome("Subagent is waiting for takeover.", paused=True)
                return
            result, paused = await _execute_backend_tool(
                request,
                call.name,
                call_args,
                call.id,
            )
            if paused:
                yield WireEvent(
                    type="subagent",
                    agent_id=agent_id,
                    name=name,
                    task=task,
                    status="running",
                    progress=f"{call.name} waiting for approval",
                )
                yield _SubagentOutcome("Subagent is waiting for approval.", paused=True)
                return
            if result is not None:
                results.append(result)
        next_input = ExternalExecutionResultEvent(
            reply_id=external.reply_id,
            execution_results=results,
        )
        steering = await _claim_steering(request, seen_steering_ids)
        if steering and results:
            _append_steering_to_result(results[-1], steering)

    if not completed:
        message = "Subagent ended without completing."
        yield WireEvent(
            type="subagent",
            agent_id=agent_id,
            name=name,
            task=task,
            status="failed",
            result=message,
        )
        yield _SubagentOutcome(f"Subagent failed: {message}")
        return
    result = (streamed.strip() or "done.")[:12_000]
    yield WireEvent(
        type="subagent",
        agent_id=agent_id,
        name=name,
        task=task,
        status="completed",
        result=result,
    )
    yield _SubagentOutcome(result)


def _parse_tool_args(raw: str) -> dict[str, Any]:
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def _validate_bridge(request: RunRequest) -> ToolBridge:
    bridge = request.tool_bridge
    if bridge is None:
        raise RuntimeError("The application backend did not provide a tool bridge")
    parsed = urlparse(bridge.url)
    if parsed.scheme != "http" or parsed.hostname not in TRUSTED_BRIDGE_HOSTS:
        raise RuntimeError("Tool bridge URL is outside the trusted application network")
    identity = bridge.identity
    if (
        not identity.user_id
        or not identity.space_id
        or identity.bot_id != request.bot_id
        or identity.thread_id != request.thread_id
        or identity.run_id != request.run_id
    ):
        raise RuntimeError("Tool bridge identity does not match the run")
    if request.identity and (
        request.identity.user_id != identity.user_id
        or request.identity.space_id != identity.space_id
        or request.identity.bot_id != identity.bot_id
        or request.identity.thread_id != identity.thread_id
        or request.identity.run_id != identity.run_id
    ):
        raise RuntimeError("Tool bridge identity does not match the trusted run identity")
    return bridge


async def _claim_steering(
    request: RunRequest,
    seen_ids: list[str],
) -> list[SteeringMessage]:
    bridge = request.tool_bridge
    if bridge is None or bridge.steering_url is None:
        return []
    parsed = urlparse(bridge.steering_url)
    if parsed.scheme != "http" or parsed.hostname not in TRUSTED_BRIDGE_HOSTS:
        raise RuntimeError("Steering bridge URL is outside the trusted application network")
    async with httpx.AsyncClient(timeout=httpx.Timeout(30), trust_env=False) as client:
        response = await client.post(
            bridge.steering_url,
            headers={
                "authorization": f"Bearer {bridge.token.get_secret_value()}",
                "content-type": "application/json",
            },
            json={"runId": request.run_id, "seenIds": seen_ids},
        )
    response.raise_for_status()
    payload = response.json()
    raw_messages = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(raw_messages, list):
        raise RuntimeError("Steering bridge returned malformed messages")
    messages = [SteeringMessage.model_validate(item) for item in raw_messages]
    seen_ids.extend(message.id for message in messages)
    return messages


def _append_steering_to_result(
    result: ToolResultBlock,
    messages: list[SteeringMessage],
) -> None:
    if not messages:
        return
    if isinstance(result.output, str):
        result.output = [TextBlock(text=result.output)]
    result.output.append(
        TextBlock(
            text=(
                "\n<system-reminder>Additional user instructions received while this run "
                "was executing:\n"
                + "\n".join(message.text for message in messages)
                + "\n</system-reminder>"
            ),
        ),
    )
    for message in messages:
        result.output.extend(_data_block(image) for image in message.images)


async def _resolve_subagent_request(
    request: RunRequest,
    provider: str,
    model_id: str,
) -> RunRequest:
    if provider == request.model.provider and model_id == request.model.id:
        return request
    bridge = request.tool_bridge
    if bridge is None or bridge.model_url is None:
        raise RuntimeError("Per-call subagent model selection is unavailable")
    parsed = urlparse(bridge.model_url)
    if parsed.scheme != "http" or parsed.hostname not in TRUSTED_BRIDGE_HOSTS:
        raise RuntimeError("Model bridge URL is outside the trusted application network")
    async with httpx.AsyncClient(timeout=httpx.Timeout(30), trust_env=False) as client:
        response = await client.post(
            bridge.model_url,
            headers={
                "authorization": f"Bearer {bridge.token.get_secret_value()}",
                "content-type": "application/json",
            },
            json={
                "runId": request.run_id,
                "provider": provider,
                "modelId": model_id,
            },
        )
    payload = response.json()
    if not response.is_success:
        message = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(str(message or "Subagent model resolution failed"))
    raw_model = payload.get("model") if isinstance(payload, dict) else None
    return request.model_copy(update={"model": RunModel.model_validate(raw_model)})


def _result_blocks(result: Any) -> list[TextBlock | DataBlock]:
    if isinstance(result, dict) and result.get("kind") == "agent_tool_result":
        blocks: list[TextBlock | DataBlock] = []
        content = result.get("content")
        if not isinstance(content, list):
            return [TextBlock(text=json.dumps(result, ensure_ascii=False, default=str))]
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                blocks.append(TextBlock(text=str(item.get("text") or "")))
            elif item.get("type") == "image":
                data = item.get("data")
                mime_type = item.get("mimeType")
                if isinstance(data, str) and mime_type in {"image/png", "image/jpeg"}:
                    blocks.append(
                        DataBlock(source=Base64Source(data=data, media_type=mime_type)),
                    )
        return blocks or [TextBlock(text="Tool completed without a displayable result.")]
    return [TextBlock(text=json.dumps(result, ensure_ascii=False, default=str))]


async def _execute_backend_tool(
    request: RunRequest,
    name: str,
    args: dict[str, Any],
    execution_id: str,
) -> tuple[ToolResultBlock | None, bool]:
    bridge = _validate_bridge(request)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600), trust_env=False) as client:
            response = await client.post(
                bridge.url,
                headers={
                    "authorization": f"Bearer {bridge.token.get_secret_value()}",
                    "content-type": "application/json",
                },
                json={
                    "runId": request.run_id,
                    "name": name,
                    "executionId": execution_id,
                    "args": args,
                },
            )
        payload = response.json()
        if response.is_success and payload.get("status") == "paused":
            return None, True
        if not response.is_success or payload.get("status") == "error":
            message = payload.get("error") if isinstance(payload, dict) else None
            return (
                ToolResultBlock(
                    id=execution_id,
                    name=name,
                    output=[TextBlock(text=f"Tool failed: {message or response.status_code}")],
                    state=ToolResultState.ERROR,
                ),
                False,
            )
        return (
            ToolResultBlock(
                id=execution_id,
                name=name,
                output=_result_blocks(payload.get("result")),
                state=ToolResultState.SUCCESS,
            ),
            False,
        )
    except httpx.HTTPError as error:
        return (
            ToolResultBlock(
                id=execution_id,
                name=name,
                output=[TextBlock(text=f"Tool bridge failed: {type(error).__name__}")],
                state=ToolResultState.ERROR,
            ),
            False,
        )


def _ask_event(args: dict[str, Any]) -> WireEvent:
    options = args.get("options")
    if not isinstance(options, list):
        options = []
    clean = [str(item).strip() for item in options]
    if len(clean) < 2 or len(clean) > 4 or any(not item or len(item) > 80 for item in clean):
        raise ValueError("ask_user requires two to four non-empty options")
    return WireEvent(
        type="ask",
        text=str(args.get("question") or "What should I use?"),
        actions=[{"id": f"choice-{index + 1}", "label": label} for index, label in enumerate(clean)],
    )


async def execute_run(request: RunRequest, store: StateStore) -> AsyncIterator[WireEvent]:
    seen_steering_ids: list[str] = []
    identity = request.identity
    if identity is None:
        raise RuntimeError("AgentScope runs require a trusted application identity")
    if (
        identity.bot_id != request.bot_id
        or identity.thread_id != request.thread_id
        or identity.run_id != request.run_id
    ):
        raise RuntimeError("Run identity does not match the trusted application context")
    if request.tool_bridge is not None:
        _validate_bridge(request)
    initial_steering = await _claim_steering(request, seen_steering_ids)
    user_id = identity.user_id
    space_id = identity.space_id
    snapshot = store.load(
        request.bot_id,
        request.thread_id,
        user_id,
        space_id,
    )
    if snapshot:
        state = _restored_state(
            request,
            snapshot.state,
            snapshot.last_source_message_id,
        )
    else:
        state = _history_state(
            request,
            {message.message_id for message in initial_steering},
        )
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
    prompt = request.prompt
    if initial_steering:
        prompt += "\n\nAdditional user context:\n" + "\n".join(
            message.text for message in initial_steering
        )
    initial_images = [
        *request.current_turn_images,
        *(image for message in initial_steering for image in message.images),
    ]
    next_input: Any = UserMsg(
        name="user",
        content=_message_content(prompt, initial_images),
        id=request.source_message_id,
    )
    tool_names: dict[str, str] = {}
    tool_arguments: dict[str, str] = {}
    completed = False

    while True:
        external: RequireExternalExecutionEvent | None = None
        async for event in agent.reply_stream(next_input):
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
                yield WireEvent(type="progress", text=f"Running {event.tool_call_name}", activity=True)
            elif isinstance(event, ToolResultEndEvent):
                label = tool_names.get(event.tool_call_id, "tool")
                yield WireEvent(type="progress", text=f"{label} {event.state}", activity=True)
            elif isinstance(event, RequireExternalExecutionEvent):
                external = event
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

        if external is None:
            break

        results: list[ToolResultBlock] = []
        for call in external.tool_calls:
            args = _parse_tool_args(call.input)
            if call.name == "ask_user":
                yield _ask_event(args)
                return
            if call.name == "request_takeover":
                yield WireEvent(
                    type="takeover",
                    reason=str(args.get("reason") or "I need you on the screen."),
                )
                return
            if call.name == "run_subagent":
                outcome: _SubagentOutcome | None = None
                async for item in _subagent_events(
                    request,
                    call.id,
                    args,
                    seen_steering_ids,
                ):
                    if isinstance(item, _SubagentOutcome):
                        outcome = item
                    else:
                        yield item
                if outcome is None:
                    raise RuntimeError("Subagent ended without a result")
                if outcome.paused:
                    return
                results.append(
                    ToolResultBlock(
                        id=call.id,
                        name=call.name,
                        output=[TextBlock(text=outcome.result)],
                        state=ToolResultState.SUCCESS,
                    ),
                )
                continue
            result, paused = await _execute_backend_tool(
                request,
                call.name,
                args,
                call.id,
            )
            if paused:
                yield WireEvent(type="progress", text=f"{call.name} waiting for approval", activity=True)
                return
            if result is not None:
                results.append(result)
        steering = await _claim_steering(request, seen_steering_ids)
        if steering and results:
            _append_steering_to_result(results[-1], steering)
        next_input = ExternalExecutionResultEvent(
            reply_id=external.reply_id,
            execution_results=results,
        )

    if completed:
        store.save(
            request.bot_id,
            request.thread_id,
            state,
            user_id=user_id,
            space_id=space_id,
            last_source_message_id=request.source_message_id,
            previous_revision=snapshot.revision if snapshot else 0,
        )
        yield WireEvent(type="done")
    elif request.allow_silent_empty:
        store.save(
            request.bot_id,
            request.thread_id,
            state,
            user_id=user_id,
            space_id=space_id,
            last_source_message_id=request.source_message_id,
            previous_revision=snapshot.revision if snapshot else 0,
        )
        yield WireEvent(type="done")
    else:
        raise RuntimeError(request.empty_response_text or "AgentScope run ended without completing")
