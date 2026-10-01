from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest
from agentscope.message import UserMsg
from agentscope.state import AgentState

from workpal_agentscope.contracts import RunRequest
from workpal_agentscope.runtime import _build_model, execute_run
from workpal_agentscope.state_store import StateStore


class ModelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
        length = int(self.headers["content-length"])
        body = json.loads(self.rfile.read(length))
        self.requests.append(body)
        model = body.get("model")
        serialized_messages = json.dumps(body["messages"])
        subagent_child = model in {"fixture-subagent", "fixture-child"} and "WorkPal subagent" in serialized_messages
        has_current_turn_tool_result = bool(
            body["messages"]
            and (
                body["messages"][-1]["role"] == "tool"
                or (
                    model in {"fixture-backend", "fixture-subagent", "fixture-child"}
                    and any(message["role"] == "tool" for message in body["messages"])
                )
            )
        )
        if has_current_turn_tool_result:
            final_text = (
                "Child inspected the sandbox."
                if subagent_child
                else "Parent received the child result."
                if model == "fixture-subagent"
                else "AgentScope used the approved clock tool."
            )
            chunks = [
                {
                    "id": "chatcmpl-final",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "fixture",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": final_text},
                            "finish_reason": None,
                        },
                    ],
                },
                {
                    "id": "chatcmpl-final",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "fixture",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": 20,
                        "completion_tokens": 8,
                        "total_tokens": 28,
                    },
                },
            ]
        else:
            backend_tool = model == "fixture-backend" or subagent_child
            subagent_parent = model == "fixture-subagent" and not subagent_child
            tool_name = (
                "run_subagent"
                if subagent_parent
                else "shell"
                if backend_tool
                else "Skill"
                if model == "fixture-skill"
                else "runtime_current_time"
            )
            tool_args = (
                '{"name":"scout","task":"Inspect the sandbox.","model_provider":"openai-compatible","model_id":"fixture-child"}'
                if subagent_parent
                else '{"command":"pwd"}'
                if backend_tool
                else '{"skill":"release-check"}'
                if model == "fixture-skill"
                else '{"timezone":"Asia/Shanghai"}'
            )
            chunks = [
                {
                    "id": "chatcmpl-tool",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "fixture",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "clock-1",
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "arguments": tool_args,
                                        },
                                    },
                                ],
                            },
                            "finish_reason": None,
                        },
                    ],
                },
                {
                    "id": "chatcmpl-tool",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "fixture",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 4,
                        "total_tokens": 14,
                    },
                },
            ]
        encoded = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        encoded += "data: [DONE]\n\n"
        payload = encoded.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: object) -> None:
        return


class ToolBridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests: list[dict[str, object]] = []
    authorizations: list[str] = []
    steering_requests: list[dict[str, object]] = []
    model_requests: list[dict[str, object]] = []
    model_base_url = ""
    pause = False

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
        length = int(self.headers["content-length"])
        request_body = json.loads(self.rfile.read(length))
        self.authorizations.append(self.headers.get("authorization", ""))
        if self.path == "/v1/steering":
            self.steering_requests.append(request_body)
            payload = json.dumps(
                {
                    "messages": [
                        {
                            "id": "steer-1",
                            "messageId": "message-2",
                            "text": "Also mention the timezone.",
                            "images": [],
                        },
                    ]
                    if not request_body.get("seenIds")
                    else [],
                },
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/v1/model-resolutions":
            self.model_requests.append(request_body)
            payload = json.dumps(
                {
                    "model": {
                        "provider": "openai-compatible",
                        "id": "fixture-child",
                        "apiKey": "child-key",
                        "baseUrl": self.model_base_url,
                        "contextWindow": 16000,
                    },
                },
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.requests.append(request_body)
        payload = json.dumps(
            {
                "status": "paused",
                "result": {
                    "kind": "agent_tool_result",
                    "content": [{"type": "text", "text": "Waiting for approval."}],
                    "details": {"approval": "paused"},
                    "terminate": True,
                },
            }
            if self.pause
            else {
                "status": "ok",
                "result": {
                    "kind": "agent_tool_result",
                    "content": [
                        {"type": "text", "text": "/workspace"},
                        {"type": "image", "data": "AQID", "mimeType": "image/png"},
                    ],
                    "details": {"cwd": "/workspace"},
                },
            },
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: object) -> None:
        return


@pytest.fixture
def model_server() -> Iterator[tuple[str, list[dict[str, object]]]]:
    ModelHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", ModelHandler.requests
    finally:
        server.shutdown()
        thread.join(timeout=2)


@pytest.fixture
def tool_bridge_server() -> Iterator[tuple[str, list[dict[str, object]], list[str]]]:
    ToolBridgeHandler.requests = []
    ToolBridgeHandler.authorizations = []
    ToolBridgeHandler.steering_requests = []
    ToolBridgeHandler.model_requests = []
    ToolBridgeHandler.pause = False
    server = ThreadingHTTPServer(("127.0.0.1", 0), ToolBridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield (
            f"http://127.0.0.1:{server.server_port}/v1/tool-executions",
            ToolBridgeHandler.requests,
            ToolBridgeHandler.authorizations,
        )
    finally:
        server.shutdown()
        thread.join(timeout=2)


def request(base_url: str, run_id: str = "run-1", source_id: str = "message-1") -> RunRequest:
    return RunRequest.model_validate(
        {
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": run_id,
            "sourceMessageId": source_id,
            "identity": {
                "userId": "user-1",
                "spaceId": "space-1",
                "botId": "bot-1",
                "threadId": "thread-1",
                "runId": run_id,
            },
            "prompt": "Use the clock tool and tell me whether it worked.",
            "instructions": "Use the approved tool before answering.",
            "history": [
                {
                    "id": source_id,
                    "role": "user",
                    "content": "Use the clock tool and tell me whether it worked.",
                },
            ],
            "tools": [
                {
                    "name": "runtime_current_time",
                    "description": "Read the current time.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"timezone": {"type": "string"}},
                    },
                    "readOnly": True,
                },
                {
                    "name": "shell",
                    "description": "An unsupported tool must not be registered yet.",
                    "inputSchema": {"type": "object"},
                },
            ],
            "model": {
                "provider": "openai-compatible",
                "id": "fixture",
                "apiKey": "fixture-key",
                "baseUrl": base_url,
                "contextWindow": 16_000,
            },
        },
    )


@pytest.mark.parametrize(
    "provider",
    [
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
    ],
)
def test_supported_api_key_provider_builds_an_agentscope_model(provider: str) -> None:
    payload = request("http://127.0.0.1:1/v1").model_dump(by_alias=True)
    payload["model"].update(
        {
            "provider": provider,
            "id": "fixture-model",
            "baseUrl": (
                "http://127.0.0.1:1/v1"
                if provider in {"openai-compatible", "local"}
                else None
            ),
        },
    )
    assert _build_model(RunRequest.model_validate(payload)) is not None


async def test_real_agentscope_tool_loop_and_state_restore(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
) -> None:
    base_url, model_requests = model_server
    store = StateStore(tmp_path)
    events = [event async for event in execute_run(request(base_url), store)]

    assert any(event.type == "tool" and event.name == "runtime_current_time" for event in events)
    assert any(event.type == "progress" and event.activity for event in events)
    assert "AgentScope used the approved clock tool." == "".join(
        event.text or "" for event in events if event.type == "text"
    )
    assert events[-1].type == "done"

    restored = StateStore(tmp_path).load("bot-1", "thread-1", "user-1", "space-1")
    assert restored is not None
    assert restored.revision == 1
    assert restored.last_source_message_id == "message-1"
    assert any(message.id == "message-1" for message in restored.state.context)
    assert any(
        "approved clock tool" in (message.get_text_content() or "")
        for message in restored.state.context
    )

    follow_up = request(base_url, run_id="run-2", source_id="message-2")
    follow_up.prompt = "Did the previous turn really use a tool?"
    follow_up.history = []
    follow_up_events = [event async for event in execute_run(follow_up, StateStore(tmp_path))]
    assert follow_up_events[-1].type == "done"
    assert "approved clock tool" in json.dumps(model_requests[2])


async def test_model_oauth_is_rejected_before_execution(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
) -> None:
    payload = request(model_server[0]).model_dump(by_alias=True)
    payload["model"]["oauth"] = {"credential": {"accessToken": "must-not-cross-boundary"}}
    with pytest.raises(ValueError, match="OAuth"):
        _ = [event async for event in execute_run(RunRequest.model_validate(payload), StateStore(tmp_path))]


async def test_agentscope_skill_is_registered_and_read_on_demand(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
) -> None:
    payload = request(model_server[0], run_id="run-skill").model_dump(by_alias=True)
    payload["model"]["id"] = "fixture-skill"
    payload["skills"] = [
        {
            "id": "skill-1",
            "name": "release-check",
            "description": "Verify a release before publishing.",
            "content": "---\nname: release-check\ndescription: Verify a release.\n---\nRun the test suite.",
        },
    ]
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    assert events[-1].type == "done"
    requests = model_server[1]
    assert "<name>release-check</name>" in json.dumps(requests[0]["messages"])
    assert "Run the test suite." in json.dumps(requests[1]["messages"])


async def test_backend_tool_bridge_preserves_call_identity_and_multimodal_result(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
    tool_bridge_server: tuple[str, list[dict[str, object]], list[str]],
) -> None:
    bridge_url, bridge_requests, authorizations = tool_bridge_server
    payload = request(model_server[0], run_id="run-backend").model_dump(by_alias=True)
    payload["model"]["id"] = "fixture-backend"
    payload["tools"] = [
        {
            "name": "shell",
            "description": "Run a command in the bot sandbox.",
            "inputSchema": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    ]
    payload["toolBridge"] = {
        "url": bridge_url,
        "token": "bridge-secret",
        "identity": {
            "userId": "user-1",
            "spaceId": "space-1",
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": "run-backend",
        },
    }
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    assert any(event.type == "tool" and event.name == "shell" for event in events)
    assert events[-1].type == "done"
    assert bridge_requests == [
        {
            "runId": "run-backend",
            "name": "shell",
            "executionId": "clock-1",
            "args": {"command": "pwd"},
        },
    ]
    assert authorizations == ["Bearer bridge-secret"]
    # Trusted user/space/bot identity is deliberately absent from model-controlled arguments.
    assert "userId" not in bridge_requests[0]


async def test_approval_pause_does_not_save_half_executed_agentscope_state(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
    tool_bridge_server: tuple[str, list[dict[str, object]], list[str]],
) -> None:
    bridge_url, _bridge_requests, _authorizations = tool_bridge_server
    ToolBridgeHandler.pause = True
    payload = request(model_server[0], run_id="run-paused").model_dump(by_alias=True)
    payload["model"]["id"] = "fixture-backend"
    payload["tools"] = [
        {
            "name": "shell",
            "description": "Run a command in the bot sandbox.",
            "inputSchema": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
            },
        },
    ]
    payload["toolBridge"] = {
        "url": bridge_url,
        "token": "bridge-secret",
        "identity": {
            "userId": "user-1",
            "spaceId": "space-1",
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": "run-paused",
        },
    }
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    assert events[-1].type == "progress"
    assert "waiting for approval" in (events[-1].text or "")
    assert StateStore(tmp_path).load("bot-1", "thread-1", "user-1", "space-1") is None


async def test_agentscope_subagent_uses_inherited_model_and_restricted_backend_tools(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
    tool_bridge_server: tuple[str, list[dict[str, object]], list[str]],
) -> None:
    bridge_url, bridge_requests, _authorizations = tool_bridge_server
    ToolBridgeHandler.model_base_url = model_server[0]
    payload = request(model_server[0], run_id="run-subagent").model_dump(by_alias=True)
    payload["model"]["id"] = "fixture-subagent"
    payload["tools"] = [
        {
            "name": "run_subagent",
            "description": "Run a temporary helper.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "task": {"type": "string"},
                },
                "required": ["name", "task"],
            },
        },
        {
            "name": "shell",
            "description": "Run a command in the bot sandbox.",
            "inputSchema": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    ]
    payload["toolBridge"] = {
        "url": bridge_url,
        "modelUrl": bridge_url.rsplit("/", 1)[0] + "/model-resolutions",
        "token": "bridge-secret",
        "identity": {
            "userId": "user-1",
            "spaceId": "space-1",
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": "run-subagent",
        },
    }
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    statuses = [event.status for event in events if event.type == "subagent"]
    assert statuses[0] == "running"
    assert statuses[-1] == "completed"
    assert any(event.result == "Child inspected the sandbox." for event in events)
    assert "Parent received the child result." == "".join(
        event.text or "" for event in events if event.type == "text"
    )
    # run_subagent stays inside Python AgentScope; only the child's authorized shell call
    # crosses to the application backend, using the parent run's trusted identity.
    assert [call["name"] for call in bridge_requests] == ["shell"]
    assert ToolBridgeHandler.model_requests == [
        {
            "runId": "run-subagent",
            "provider": "openai-compatible",
            "modelId": "fixture-child",
        },
    ]


async def test_initial_steering_is_claimed_once_and_injected_as_user_context(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
    tool_bridge_server: tuple[str, list[dict[str, object]], list[str]],
) -> None:
    bridge_url, _bridge_requests, _authorizations = tool_bridge_server
    payload = request(model_server[0], run_id="run-steering").model_dump(by_alias=True)
    payload["toolBridge"] = {
        "url": bridge_url,
        "steeringUrl": bridge_url.rsplit("/", 1)[0] + "/steering",
        "token": "bridge-secret",
        "identity": {
            "userId": "user-1",
            "spaceId": "space-1",
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": "run-steering",
        },
    }
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    assert events[-1].type == "done"
    assert ToolBridgeHandler.steering_requests[0] == {
        "runId": "run-steering",
        "seenIds": [],
    }
    first_model_call = model_server[1][0]
    assert "Also mention the timezone." in json.dumps(first_model_call["messages"])


def test_state_store_scopes_tenants_and_rejects_stale_overwrite(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    state = AgentState(context=[UserMsg(name="user", content="private")])
    saved = store.save(
        "bot-1",
        "thread-1",
        state,
        user_id="user-1",
        space_id="space-1",
        last_source_message_id="message-1",
    )
    assert saved.revision == 1
    assert store.load("bot-1", "thread-1", "user-2", "space-1") is None
    with pytest.raises(RuntimeError, match="stale overwrite"):
        store.save(
            "bot-1",
            "thread-1",
            state,
            user_id="user-1",
            space_id="space-1",
            previous_revision=0,
        )


async def test_dashscope_qwen_contract_keeps_reasoning_and_image_input(
    tmp_path: Path,
    model_server: tuple[str, list[dict[str, object]]],
) -> None:
    payload = request(model_server[0], run_id="run-qwen").model_dump(by_alias=True)
    payload["model"].update(
        {
            "provider": "dashscope",
            "id": "qwen3.8-flash",
            "reasoning": True,
            "thinkingLevel": "low",
        },
    )
    payload["currentTurnImages"] = [
        {"name": "input.png", "mimeType": "image/png", "data": "AQID"},
    ]
    events = [
        event
        async for event in execute_run(
            RunRequest.model_validate(payload),
            StateStore(tmp_path),
        )
    ]

    assert events[-1].type == "done"
    first_request = model_server[1][0]
    assert first_request["model"] == "qwen3.8-flash"
    assert first_request["reasoning_effort"] == "low"
    assert "AQID" in json.dumps(first_request["messages"])
