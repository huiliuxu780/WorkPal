from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest

from workpal_agentscope.contracts import RunRequest
from workpal_agentscope.runtime import execute_run
from workpal_agentscope.state_store import StateStore


class ModelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
        length = int(self.headers["content-length"])
        body = json.loads(self.rfile.read(length))
        self.requests.append(body)
        has_current_turn_tool_result = bool(body["messages"] and body["messages"][-1]["role"] == "tool")
        if has_current_turn_tool_result:
            chunks = [
                {
                    "id": "chatcmpl-final",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "fixture",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "AgentScope used the approved clock tool."},
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
                                            "name": "runtime_current_time",
                                            "arguments": '{"timezone":"Asia/Shanghai"}',
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


def request(base_url: str, run_id: str = "run-1", source_id: str = "message-1") -> RunRequest:
    return RunRequest.model_validate(
        {
            "botId": "bot-1",
            "threadId": "thread-1",
            "runId": run_id,
            "sourceMessageId": source_id,
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

    restored = StateStore(tmp_path).load("bot-1", "thread-1")
    assert restored is not None
    assert any(message.id == "message-1" for message in restored.context)
    assert any("approved clock tool" in (message.get_text_content() or "") for message in restored.context)

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
