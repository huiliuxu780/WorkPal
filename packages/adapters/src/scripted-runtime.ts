import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { abortableDelay, inferHandoffTargetName, PRODUCT_BRAND } from "@rakazo/core";
import { requestedAvatarChange } from "./avatar-change-request.js";

const running = new Map<string, AbortController>();

export class ScriptedAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context?.signal ?? controller.signal;
    try {
      if (shouldFail(request.prompt)) {
        throw new Error("Scripted run failure");
      }
      if (shouldHang(request.prompt)) {
        // UX-01B E2E fixture: a hang that first publishes a real semantic
        // Step, so the running Run keeps an execution surface (tool progress
        // alone no longer creates one).
        if (/tracked steps/i.test(request.prompt)) {
          yield {
            type: "tool",
            name: "publish_run_step",
            args: {
              stepId: "hang-step",
              expectedRevision: 0,
              order: 0,
              title: "Working until stopped",
              status: "running",
            },
            executionId: `${request.runId}:publish_run_step:hang`,
          };
        }
        yield { type: "progress", text: "still working…", activity: true };
        while (!controller.signal.aborted && !signal.aborted) {
          await abortableDelay(50, controller.signal);
          if (controller.signal.aborted || signal.aborted) break;
          yield { type: "progress", text: "still working…", activity: true };
        }
        yield { type: "done", text: "stopped" };
        return;
      }
      const script = request.script ?? inferScript(request.prompt, request.resumeFromCheckpoint);
      // Per-run call index so repeated tools (e.g. message_agent) get distinct
      // executionIds — delivery keys and effect replays key off this value.
      let toolCallSeq = 0;
      let turnIndex = 0;
      for (const turn of script) {
        if (signal.aborted || controller.signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
        // UX-01B E2E fixture pacing: give the client a deterministic window
        // to render the first Plan revision before the next turn revises it
        // (the revision flash must not depend on a race).
        if (turnIndex > 0 && /paced tracked plan/i.test(request.prompt)) {
          await abortableDelay(4_000, controller.signal);
          if (signal.aborted || controller.signal.aborted) {
            yield { type: "done", text: "stopped" };
            return;
          }
        }
        turnIndex += 1;
        if (turn.assistant) {
          yield { type: "progress", text: "working…", activity: true };
          yield { type: "text", text: turn.assistant };
        }
        for (const call of turn.toolCalls ?? []) {
          const executionId = `${request.runId}:${call.name}:${toolCallSeq++}`;
          if (call.name === "run_subagent") {
            const agentId = `${request.runId}:subagent`;
            const name = String(call.args.name ?? "helper");
            const task = String(call.args.task ?? request.prompt);
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "running",
              progress: "working…",
            };
            yield {
              type: "tool",
              name: call.name,
              args: call.args,
              executionId,
            };
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "completed",
              result: `done. i handled: ${task.slice(0, 180)}`,
            };
            continue;
          }
          yield {
            type: "tool",
            name: call.name,
            args: call.args,
            executionId,
          };
        }
        if (turn.ask) {
          yield {
            type: "ask",
            text: turn.ask.text,
            detail: turn.ask.detail,
            actions: turn.ask.actions,
          };
          return;
        }
        if (turn.takeover) {
          yield { type: "takeover", reason: turn.takeover.reason };
          return;
        }
        if (turn.complete) {
          yield {
            type: "usage",
            inputTokens: 12,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            provider: "scripted",
            model: "scripted",
          };
          yield { type: "done", text: turn.assistant };
          return;
        }
      }
      // UX-01B/C E2E fixtures: the Run fails AFTER its scripted turns ran —
      // "tracked" publishes a real failed semantic Step (the "View reason"
      // Step path), "todo" publishes only Todos (the 事项清单 fallback path).
      if (/fail this (?:tracked|todo) run/i.test(request.prompt)) {
        throw new Error("Scripted run failure");
      }
      yield { type: "text", text: "done." };
      yield { type: "done", text: "done." };
    } finally {
      controller.abort();
      running.delete(request.runId);
    }
  }
}

export function inferScript(
  prompt: string,
  resumeFromCheckpoint?: string,
): NonNullable<AgentRunRequest["script"]> {
  const lower = prompt.toLowerCase();
  if (resumeFromCheckpoint === "takeover-skipped") {
    return [
      {
        assistant: "login was skipped. continuing without treating sign-in as done.",
        complete: true,
      },
    ];
  }
  if (resumeFromCheckpoint === "takeover") {
    return [
      {
        assistant:
          "signed in. the session stays in this computer — protected input never hit the thread.",
        complete: true,
      },
    ];
  }
  if (prompt === "avatar injection fixture: change your avatar to wave") {
    return [
      {
        assistant: "fixture attempts an unauthorized avatar tool call.",
        toolCalls: [{ name: "change_avatar", args: { character: "wave" } }],
        complete: true,
      },
    ];
  }
  // Deterministic test runtime exercises the production avatar tool boundary.
  const avatarRequest = requestedAvatarChange(prompt);
  if (avatarRequest) {
    return [
      {
        assistant: "updating my avatar.",
        toolCalls: [
          {
            name: "change_avatar",
            args:
              avatarRequest === "attached-image"
                ? { use_attached_image: true }
                : { character: avatarRequest },
          },
        ],
        complete: true,
      },
    ];
  }
  // Deterministic waiting-state pagination fixture (execution-history e2e):
  // N real tool calls followed by a free-text ask in the same Run. Answering
  // appends events (rev moves) while shifting the activity first page, so an
  // out-of-order stale detail response is distinguishable in the DOM.
  const stepAskRun = /^run (\d+) shell steps then ask$/i.exec(prompt);
  if (stepAskRun) {
    const count = Math.min(Math.max(Number(stepAskRun[1]), 1), 250);
    return [
      {
        assistant: "running them, then i need a decision.",
        toolCalls: Array.from({ length: count }, (_unused, index) =>
          index % 2 === 0
            ? { name: "shell" as const, args: { command: `echo step-${index}` } }
            : {
                name: "write_file" as const,
                args: { path: `notes/step-${index}.txt`, content: `step ${index}` },
              },
        ),
        ask: { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  // Deterministic Activity pagination fixture (execution-history e2e):
  // N real tool calls in one Run, each emitting called+completed events.
  const stepRun = /^run (\d+) shell steps$/i.exec(prompt);
  if (stepRun) {
    const count = Math.min(Math.max(Number(stepRun[1]), 1), 250);
    return [
      {
        assistant: "running them.",
        // Alternate two tool kinds so adjacent-row folding cannot swallow the
        // fixture into a single line (Activity pagination needs distinct rows).
        toolCalls: Array.from({ length: count }, (_unused, index) =>
          index % 2 === 0
            ? { name: "shell" as const, args: { command: `echo step-${index}` } }
            : {
                name: "write_file" as const,
                args: { path: `notes/step-${index}.txt`, content: `step ${index}` },
              },
        ),
        complete: true,
      },
    ];
  }
  // UX-01B/C E2E fixtures: Runs carrying REAL semantic Steps and structured
  // Plans. publish_run_step / publish_run_plan execute through the same
  // production tool path as any other tool, so the four execution-surface
  // conditions exist for real. The "shell steps" fixtures above stay
  // tool-activity-only on purpose (lightweight status / Activity paging).
  const trackedAskRun = /^run (\d+) tracked steps then ask$/i.exec(prompt);
  if (trackedAskRun) {
    const count = Math.min(Math.max(Number(trackedAskRun[1]), 1), 250);
    return [
      {
        assistant: "running them, then i need a decision.",
        toolCalls: trackedStepCalls(count),
        ask: { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  const trackedRun = /^run (\d+) tracked steps(?:\s+([\s\S]+))?$/i.exec(prompt);
  if (trackedRun) {
    const count = Math.min(Math.max(Number(trackedRun[1]), 1), 250);
    return [
      {
        assistant: `done. i handled: ${prompt}`,
        toolCalls: trackedStepCalls(count),
        complete: true,
      },
    ];
  }
  const trackedWrite =
    /^write a tracked file named\s+([A-Za-z0-9._/-]+)\s+saying\s+([\s\S]+)$/i.exec(prompt);
  if (trackedWrite) {
    const filePath = trackedWrite[1]!;
    const content = `${trackedWrite[2]!.trim()}\n`;
    return [
      { toolCalls: [trackedStepCall("write-file", 0, "Write the file", "running")] },
      { toolCalls: [{ name: "write_file" as const, args: { path: filePath, content } }] },
      {
        assistant: "writing that into my home now.",
        toolCalls: [
          {
            name: "publish_run_step",
            args: {
              stepId: "write-file",
              expectedRevision: 1,
              order: 0,
              title: "Write the file",
              status: "completed",
              resultSummary: "File written",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  const trackedAttach =
    /^attach a tracked file to the thread with path\s+([A-Za-z0-9._/-]+)\s+says\s+([\s\S]+)$/i.exec(
      prompt,
    );
  if (trackedAttach) {
    const filePath = trackedAttach[1]!;
    const content = `${trackedAttach[2]!.trim().replace(/[.]+$/, "")}\n`;
    return [
      {
        assistant: "writing that into my home and attaching it to the thread.",
        toolCalls: [trackedStepCall("attach-file", 0, "Attach the note", "running")],
      },
      { toolCalls: [{ name: "write_file" as const, args: { path: filePath, content } }] },
      {
        toolCalls: [
          { name: "attach_file" as const, args: { path: filePath } },
          {
            name: "publish_run_step",
            args: {
              stepId: "attach-file",
              expectedRevision: 1,
              order: 0,
              title: "Attach the note",
              status: "completed",
              resultSummary: "Attached to the thread",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (/^fail this tracked run/i.test(prompt)) {
    return [
      {
        toolCalls: [
          trackedStepCall("collect", 0, "Collect input", "completed", {
            resultSummary: "Collected",
          }),
          trackedStepCall("deploy", 1, "Deploy change", "failed", {
            resultSummary: "Deploy blocked by policy",
          }),
        ],
      },
    ];
  }
  const trackedPlan = /^publish a (?:paced )?tracked plan named\s+([\s\S]+)$/i.exec(prompt);
  if (trackedPlan) {
    const label = trackedPlan[1]!.trim();
    return [
      {
        assistant: `publishing the plan for ${label}.`,
        toolCalls: [
          {
            name: "publish_run_plan",
            args: {
              expectedRevision: 0,
              goal: `Deliver ${label}`,
              items: [
                { id: "a", title: "Collect input", status: "completed" },
                { id: "b", title: "Analyze findings", status: "completed" },
                { id: "c", title: "Draft report", status: "completed" },
                { id: "d", title: "Final check", status: "active" },
              ],
            },
          },
          {
            name: "publish_run_step",
            args: {
              stepId: "final-check",
              expectedRevision: 0,
              order: 0,
              title: "Final check",
              status: "running",
              planItemId: "d",
            },
          },
        ],
      },
      {
        // Revision 2 lands on its own turn (paced): the client renders 3/4
        // first, then the honest 3/6 regression with the update flash.
        toolCalls: [
          {
            name: "publish_run_plan",
            args: {
              expectedRevision: 1,
              changeReason: "Scope grew after review",
              goal: `Deliver ${label}`,
              items: [
                { id: "a", title: "Collect input", status: "completed" },
                { id: "b", title: "Analyze findings", status: "completed" },
                { id: "c", title: "Draft report", status: "completed" },
                { id: "d", title: "Final check", status: "active" },
                { id: "e", title: "Peer review", status: "pending" },
                { id: "f", title: "Publish result", status: "pending" },
              ],
            },
          },
        ],
      },
      {
        assistant: `done. i handled: ${prompt}`,
        toolCalls: [
          {
            name: "publish_run_step",
            args: {
              stepId: "final-check",
              expectedRevision: 1,
              order: 0,
              title: "Final check",
              status: "completed",
              planItemId: "d",
              resultSummary: "Checked",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  // UX-01C fixtures: Todo-only Runs. Todos alone never create an execution
  // surface; a failed Todo-only Run shows the legacy 事项清单 fallback inside
  // its (legally failed) surface, expanded only.
  if (/^publish tracked todos/i.test(prompt)) {
    return [
      {
        assistant: `done. i handled: ${prompt}`,
        toolCalls: [
          {
            name: "publish_run_todo",
            args: {
              todoId: "todo-1",
              expectedRevision: 0,
              order: 0,
              title: "First working item",
              status: "resolved",
            },
          },
          {
            name: "publish_run_todo",
            args: {
              todoId: "todo-2",
              expectedRevision: 0,
              order: 1,
              title: "Second working item",
              status: "pending",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (/^fail this todo run/i.test(prompt)) {
    return [
      {
        toolCalls: [
          {
            name: "publish_run_todo",
            args: {
              todoId: "todo-f1",
              expectedRevision: 0,
              order: 0,
              title: "Unfinished working item",
              status: "pending",
            },
          },
        ],
      },
    ];
  }
  // Before every content-based intent so payload text cannot steal the branch.
  const shellCommand = /run the shell command\s+([\s\S]+)$/i.exec(prompt)?.[1]?.trim();
  if (shellCommand) {
    return [
      {
        assistant: "running it on my computer.",
        toolCalls: [{ name: "shell", args: { command: shellCommand } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("message the bot named") || lower.includes("message bot named")) {
    const name = namedBot(prompt) ?? "Peer";
    const message =
      /named\s+[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s+(?:saying|with|:)\s*([\s\S]+)$/i
        .exec(prompt)?.[1]
        ?.trim() ?? `Please help with: ${prompt}`;
    return [
      {
        assistant: "messaging that bot now.",
        toolCalls: [
          {
            name: "message_bot",
            args: {
              confirm_name: name,
              message,
              intent: "request",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("launch a cloud agent") ||
    lower.includes("start a cloud agent") ||
    lower.includes("cloud coding agent")
  ) {
    return [
      {
        assistant: "launching a cloud agent for that.",
        toolCalls: [
          {
            name: "cloud_agent_launch",
            args: {
              prompt: "Add a README with setup instructions",
              repository: "https://github.com/example/demo",
              openPr: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("show a login card") || lower.includes("tracked login card")) {
    return [
      {
        assistant: "i need that sign-in in a protected card.",
        toolCalls: [
          ...(lower.includes("tracked login card") ? [trackedStepCall("login-step", 0, "Store the login", "running")] : []),
          {
            name: "request_secret",
            args: {
              label: "Example sign-in",
              purpose: "password",
              credential: {
                name: "example_login",
                origin: "https://login.example.test",
                auth: { type: "login" },
              },
            },
          },
        ],
      },
    ];
  }
  // UX-01C fixture: the secret ask on a Run that also carries a semantic
  // Step, so its settled receipt keeps a legal surface after history reload.
  if (lower.includes("tracked secret card")) {
    return [
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          trackedStepCall("secret-step", 0, "Store the key", "running"),
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ];
  }
  if (
    lower.includes("masked secret card") ||
    lower.includes("show a secret card") ||
    lower.includes("request a masked api key")
  ) {
    return [
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("mcp approval card")) {
    return [
      {
        assistant: "i will register that server for your approval.",
        toolCalls: [
          {
            name: "add_mcp_server",
            args: {
              name: "Fixture MCP",
              transport: "stdio",
              command: "echo",
              assignToSelf: true,
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("quote markdown fixture")) {
    const marker = /quote markdown fixture\s+(\S+)/i.exec(prompt)?.[1] ?? "md-fixture";
    return [
      {
        assistant: `${marker}
1. list-a
2. list-b

| k | v |
| --- | --- |
| cell-a | cell-b |
| cell-c | cell-d |

\`\`\`
code-a
---
code-b
\`\`\``,
        complete: true,
      },
    ];
  }
  if (
    lower.includes("tappable choices") ||
    lower.includes("choice buttons") ||
    lower.includes("pick from these cities")
  ) {
    return [
      {
        assistant: "pick one to continue.",
        ask: {
          text: "Which city should I use?",
          detail: "Tap one option.",
          actions: [
            { id: "choice-1", label: "Berlin" },
            { id: "choice-2", label: "Seoul" },
            { id: "choice-3", label: "Toronto" },
            { id: "choice-4", label: "Lisbon" },
          ],
        },
      },
    ];
  }
  if (
    lower.includes("ask me") ||
    lower.includes("which city") ||
    lower.includes("need a decision")
  ) {
    return [
      {
        assistant: "i need a decision before i continue.",
        ask: { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  if (lower.includes("take over") || lower.includes("sign in") || lower.includes("login")) {
    return [
      { assistant: "i need you on the screen for a one-time sign-in. handing you the computer." },
      { takeover: { reason: "Sign in to continue. Protected input stays off the thread." } },
    ];
  }
  if (
    lower.includes("observe your screen") ||
    lower.includes("look at your screen") ||
    lower.includes("use your screen")
  ) {
    const typed = /type\s+([A-Za-z0-9._-]+)/i.exec(prompt)?.[1] ?? "ready";
    return [
      {
        assistant: "using my screen now.",
        toolCalls: [
          { name: "computer_observe", args: {} },
          {
            name: "computer_act",
            args: {
              actions: [{ kind: "type", text: typed }],
              observe: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("delete the bot named") ||
    lower.includes("delete the child bot") ||
    lower.includes("delete child")
  ) {
    const name = namedBot(prompt) ?? "Scout";
    return [
      {
        assistant: "archiving that bot.",
        toolCalls: [{ name: "archive_bot", args: { confirm_name: name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("create a space") ||
    lower.includes("create space") ||
    lower.includes("new space named") ||
    lower.includes("new private space")
  ) {
    const name = namedSpace(prompt) ?? "New space";
    return [
      {
        assistant: "i can create that separate space after you confirm the boundary.",
        toolCalls: [{ name: "create_space", args: { name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("spawn a bot") ||
    lower.includes("spawn a child") ||
    lower.includes("create a bot named") ||
    lower.includes("create a child bot")
  ) {
    const name = namedBot(prompt) ?? "Helper";
    return [
      {
        assistant: "creating a bot for that.",
        toolCalls: [
          {
            name: "spawn_bot",
            args: {
              name,
              title: `${name} specialist`,
              instructions: `You are ${name}.`,
              prompt: "Start on the assigned work.",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("silence finish notifications") ||
    lower.includes("turn off finish notifications")
  ) {
    return [
      {
        assistant: "silencing finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: false } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("resume finish notifications") ||
    lower.includes("turn on finish notifications")
  ) {
    return [
      {
        assistant: "enabling finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: true } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("subagent") || lower.includes("delegate to a helper")) {
    return [
      {
        assistant: "spinning up a helper for that.",
        toolCalls: [{ name: "run_subagent", args: { name: "helper", task: prompt } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("hand this to") ||
    lower.includes("hand off to") ||
    lower.includes("handoff to") ||
    (lower.includes("@writer") && lower.includes("draft"))
  ) {
    const target = inferHandoffTargetName(prompt) ?? "Writer";
    return [
      {
        assistant: "handing this off in the group thread.",
        toolCalls: [
          {
            name: "handoff_to_bot",
            args: {
              confirm_name: target,
              message: prompt,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.startsWith("run taught skill:") || lower.includes("this is a safe test")) {
    return [
      {
        assistant:
          "Running the taught skill using its saved playbook. I will follow the demonstrated steps and report the result.",
        complete: true,
      },
    ];
  }
  if (/^run\s+/.test(lower)) {
    return [
      {
        assistant:
          "Using the saved taught skill playbook for that request and following its steps.",
        complete: true,
      },
    ];
  }
  if (lower.includes("connector") || lower.includes("crm") || lower.includes("destination")) {
    return [
      {
        assistant: "writing the record through the connected destination.",
        toolCalls: [
          {
            name: "destination.write",
            args: { collection: "notes", title: `${PRODUCT_BRAND.name} result`, body: prompt },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("attach") && (lower.includes("thread") || lower.includes("into the thread"))) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named|path|file)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home and attaching it to the thread." },
      { toolCalls: [{ name: "write_file", args: { path: filePath, content } }] },
      { toolCalls: [{ name: "attach_file", args: { path: filePath } }], complete: true },
    ];
  }
  if (
    lower.includes("write") &&
    (lower.includes("file") || lower.includes("home") || lower.includes("note"))
  ) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { toolCalls: [{ name: "write_file", args: { path: filePath, content } }] },
      { assistant: "writing that into my home now.", complete: true },
    ];
  }
  if (lower.includes("remember")) {
    return [
      {
        assistant: "noted — i will keep that in memory.",
        memory: [{ scope: "bot", path: "MEMORY.md", content: `# Memory\n\n- ${prompt}\n` }],
        complete: true,
      },
    ];
  }
  return [
    {
      assistant: `on it. i will work this in the background and come back with a result.\n\n${summarize(prompt)}`,
    },
    {
      files: [{ path: "notes/last-task.md", content: `# Task\n\n${prompt}\n` }],
      complete: true,
    },
  ];
}

function shouldFail(prompt: string): boolean {
  return prompt.toLowerCase().includes("fail this run");
}

function shouldHang(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("keep working") ||
    lower.includes("work until i stop") ||
    lower.includes("until i stop you") ||
    lower.includes("hang until stopped")
  );
}

function namedBot(prompt: string) {
  return /named\s+([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt)?.[1];
}

/** One publish_run_step call through the production tool path. */
function trackedStepCall(
  stepId: string,
  order: number,
  title: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    name: "publish_run_step",
    args: { stepId, expectedRevision: 0, order, title, status, ...extra },
  };
}

function trackedStepCalls(count: number) {
  // Alternate a real shell call between publish_run_step calls so adjacent-row
  // folding cannot swallow the Activity fixture into a single line (same
  // rationale as the shell-steps fixtures); each pair keeps distinct rows for
  // Activity pagination.
  return Array.from({ length: count }, (_unused, index) => [
    trackedStepCall(`tracked-${index}`, index, `Tracked step ${index}`, "completed", {
      resultSummary: `Step ${index} finished`,
    }),
    { name: "shell" as const, args: { command: `echo tracked-${index}` } },
  ]).flat();
}

function namedSpace(prompt: string) {
  return /space\s+(?:named|called)\s+["“]?([^"”\n]{1,60})/i
    .exec(prompt)?.[1]
    ?.replace(/[.!?]+$/, "")
    .trim();
}

function summarize(prompt: string): string {
  return `done. i handled: ${prompt.slice(0, 180)}`;
}
