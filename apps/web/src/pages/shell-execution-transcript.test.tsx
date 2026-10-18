// @vitest-environment jsdom
/**
 * UX-01A smoke baseline for the Shell execution region assembly.
 *
 * Behavior-level guarantees that must hold on the pre-split implementation
 * AND keep holding after the execution region moves into its own module
 * (`pages/shell/use-execution-transcript.tsx`):
 *
 * 1. Plan + semantic Steps + unlinked Todos + foreground Activity of one Run
 *    merge into ONE execution shell at the anchored position.
 * 2. Every server summary produces exactly one shell; a failed Run without a
 *    message anchor falls back to the transcript tail.
 * 3. A pending Intervention renders outside the collapsible detail, and the
 *    Ask block it covers never appears as a second card in the bubble.
 * 4. The Task Center return intent is consumed once: it opens the target
 *    Run's card and focuses the Intervention control (attention) or the
 *    status line (non-attention).
 *
 * These assert rendered DOM behavior only — never the internal anchor Maps.
 */
import { i18n } from "@lingui/core";
import type {
  ActivityItem,
  ExecutionSummary,
  InterventionView,
  MessageBlock,
  Run,
  RunPlanRevision,
  RunStepSnapshot,
  RunTodoSnapshot,
  ThreadMessage,
} from "@rakazo/contracts";
import { act, type ComponentProps, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTaskCenterNavIntent,
  peekTaskCenterNavIntent,
  setTaskCenterNavIntent,
} from "../lib/task-center";

const rpcMocks = vi.hoisted(() => ({
  executionSnapshot: vi.fn(),
  executionActivityPage: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", async () => {
  const { i18n: lingui } = await import("@lingui/core");
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: lingui }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
// The Markdown renderer is presentation-only here; the smoke test asserts
// execution assembly, not rich text.
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LinkifiedText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../lib/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rpc")>();
  return {
    ...actual,
    rpc: {
      runs: {
        executionSnapshot: rpcMocks.executionSnapshot,
        executionActivityPage: rpcMocks.executionActivityPage,
      },
    },
  };
});

import { Transcript } from "./Shell";

const ISO = "2026-10-12T00:00:00.000Z";
const THREAD = "thread-1";
const BOT = "bot-1";

function message(
  id: string,
  role: "user" | "bot",
  blocks: MessageBlock[],
  runId?: string,
): ThreadMessage {
  return {
    id,
    threadId: THREAD,
    seq: 0,
    role,
    blocks,
    createdAt: ISO,
    ...(runId ? { runId } : {}),
    ...(role === "bot" ? { botId: BOT } : {}),
  };
}

function run(id: string, status: Run["status"], overrides: Partial<Run> = {}): Run {
  return {
    id,
    botId: BOT,
    threadId: THREAD,
    taskId: "task-1",
    status,
    waitKind: null,
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: ISO,
    completedAt: null,
    createdAt: ISO,
    ...overrides,
  };
}

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    runId: "run-1",
    threadId: THREAD,
    botId: BOT,
    rev: 5,
    status: "completed",
    trigger: "user",
    title: "Summary title",
    updatedAt: ISO,
    artifacts: [],
    entry: "execution",
    ...overrides,
  };
}

function plan(runId: string, overrides: Partial<RunPlanRevision> = {}): RunPlanRevision {
  return {
    planId: `plan:${runId}`,
    runId,
    sourceMessageId: null,
    revisionId: `plan:${runId}:1`,
    revision: 1,
    goal: "PLAN-GOAL-1",
    items: [{ id: "p1", title: "PLAN-ITEM-1", status: "completed" }],
    changeReason: null,
    createdAt: ISO,
    ...overrides,
  };
}

function step(runId: string, stepId: string, title: string, order: number): RunStepSnapshot {
  return {
    stepId,
    runId,
    sourceMessageId: null,
    revision: 1,
    order,
    title,
    status: "completed",
    resultSummary: null,
    planItemId: null,
    parentStepId: null,
    attemptId: null,
    attemptNumber: null,
    startedAt: ISO,
    completedAt: ISO,
    evidence: [],
    batch: null,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function todo(
  runId: string,
  todoId: string,
  title: string,
  linkedStepId: string | null,
): RunTodoSnapshot {
  return {
    todoId,
    runId,
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title,
    status: "resolved",
    linkedStepId,
    reason: null,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function activity(id: string, runId: string, title: string): ActivityItem {
  return {
    id,
    runId,
    botId: BOT,
    threadId: THREAD,
    kind: "tool",
    status: "completed",
    title,
  };
}

function approvalIntervention(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "iv-1",
    revision: 1,
    kind: "approval",
    status: "pending",
    spaceId: "space-1",
    threadId: THREAD,
    runId: "run-4",
    attemptId: "attempt-1",
    botId: BOT,
    messageId: "m2",
    createdAt: ISO,
    requestingActor: { botId: BOT },
    approval: {
      effectId: "eff-1",
      effectStatus: "intended",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    },
    presentation: { text: "REGION-APPROVAL-TEXT" },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let container: HTMLDivElement;
let root: Root;

function unmountTranscript(): void {
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  container?.remove();
}

function renderTranscript(
  overrides: Partial<ComponentProps<typeof Transcript>> = {},
): HTMLDivElement {
  unmountTranscript();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    return (
      <Transcript
        scrollRef={scrollRef}
        scrollRequest={null}
        onScrollRequestHandled={() => undefined}
        artifactTarget={{ botId: BOT }}
        messages={[]}
        runs={[]}
        activeRunIds={[]}
        showToolActivity={false}
        olderCursor={null}
        loadingOlder={false}
        threadId={THREAD}
        running={false}
        onLoadOlder={() => undefined}
        onOpenBot={() => undefined}
        onAnswer={async () => undefined}
        onReply={() => undefined}
        onQuote={() => undefined}
        onReact={async () => undefined}
        onJumpToMessage={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={() => undefined}
        onOpenComputer={() => undefined}
        {...overrides}
      />
    );
  }
  act(() => {
    root.render(<Harness />);
  });
  return container;
}

/** A pending approval Ask block, shaped the way the runtime persists it. */
function approvalAskBlock(text: string, interventionId: string, effectId: string): MessageBlock {
  return {
    kind: "ask",
    text,
    interventionId,
    approvalEffectId: effectId,
    status: "pending",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}

function transcriptOf(host: HTMLElement): Element {
  const transcript = host.querySelector('[data-testid="transcript"]');
  if (!transcript) throw new Error("transcript container missing");
  return transcript;
}

function countOccurrences(haystack: string | null, needle: string): number {
  return (haystack ?? "").split(needle).length - 1;
}

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no scrolling implementation; Transcript's follow-the-tail
  // layout effect calls element.scrollTo on mount.
  Element.prototype.scrollTo = () => undefined;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  window.sessionStorage.clear();
  clearTaskCenterNavIntent();
  rpcMocks.executionSnapshot.mockReset();
  rpcMocks.executionSnapshot.mockRejectedValue(new Error("detail unavailable in smoke test"));
  rpcMocks.executionActivityPage.mockReset();
  rpcMocks.executionActivityPage.mockRejectedValue(new Error("paging unavailable in smoke test"));
});

afterEach(() => {
  unmountTranscript();
  clearTaskCenterNavIntent();
});

describe("Shell execution region smoke (UX-01A baseline)", () => {
  it("merges Plan, semantic Steps, unlinked Todos and Activity into one shell at the anchor", () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-1" }]),
        message("m2", "bot", [{ kind: "text", text: "BOT-ANSWER-1" }], "run-1"),
      ],
      plans: [plan("run-1")],
      steps: [
        step("run-1", "step-1", "STEP-TITLE-1", 0),
        step("run-1", "step-2", "STEP-TITLE-2", 1),
      ],
      todos: [
        todo("run-1", "todo-1", "UNLINKED-TODO-1", null),
        todo("run-1", "todo-2", "LINKED-TODO-HIDDEN", "step-1"),
      ],
      activity: [activity("act-1", "run-1", "ACTIVITY-TITLE-1")],
      runs: [run("run-1", "completed")],
      executions: [summary({ runId: "run-1", anchorMessageId: "m2", title: "MERGED-RUN-TITLE" })],
    });

    const shells = host.querySelectorAll('[data-testid="execution-shell"]');
    expect(shells).toHaveLength(1);
    const shell = shells[0]!;
    // One shell owns the whole Run: plan, steps, unlinked todos and activity.
    expect(shell.querySelector('[data-slot="plan"]')).not.toBeNull();
    expect(shell.querySelector('[data-slot="steps"]')).not.toBeNull();
    expect(shell.querySelector('[data-slot="todos"]')).not.toBeNull();
    expect(shell.querySelector('[data-slot="activity"]')).not.toBeNull();
    expect(shell.textContent).toContain("PLAN-GOAL-1");
    expect(shell.textContent).toContain("STEP-TITLE-1");
    expect(shell.textContent).toContain("STEP-TITLE-2");
    expect(shell.textContent).toContain("UNLINKED-TODO-1");
    // Linked Todos stay deduped out of the legacy snapshot path.
    expect(shell.textContent).not.toContain("LINKED-TODO-HIDDEN");
    // Anchor position: the completed Run's shell sits immediately BEFORE its
    // final bot answer bubble (before:m2), as a direct transcript child
    // between the user message and the bot answer.
    const order = [...transcriptOf(host).children].map(
      (child) =>
        child.getAttribute("data-message-id") ??
        child.getAttribute("data-testid") ??
        child.tagName.toLowerCase(),
    );
    expect(order).toEqual(["m1", "execution-shell", "m2"]);
    expect(shell.textContent).toContain("MERGED-RUN-TITLE");
  });

  it("gives every server summary exactly one shell and tails a message-less failed Run", () => {
    const host = renderTranscript({
      messages: [message("m1", "user", [{ kind: "text", text: "USER-QUESTION-2" }])],
      runs: [],
      executions: [
        summary({
          runId: "run-2",
          rev: 2,
          status: "failed",
          title: "FAILED-RUN-TITLE",
          anchorMessageId: undefined,
        }),
        summary({
          runId: "run-3",
          rev: 4,
          status: "completed",
          title: "SUMMARY-ONLY-RUN",
          anchorMessageId: "m1",
        }),
      ],
    });

    const shells = host.querySelectorAll('[data-testid="execution-shell"]');
    // Every server summary produces exactly one shell (HISTORY-001): the
    // summary-only completed Run AND the message-less failed Run each get one.
    expect(shells).toHaveLength(2);
    // Document order: the completed Run anchors at its server anchor message
    // (m1), so its shell comes first; the failed Run has no anchor and falls
    // to __tail, rendering last — as the transcript's final element.
    expect(shells[0]!.textContent).toContain("SUMMARY-ONLY-RUN");
    const failedShell = shells[1]!;
    expect(failedShell.textContent).toContain("FAILED-RUN-TITLE");
    expect(failedShell.getAttribute("data-status")).toBe("failed");
    expect(transcriptOf(host).lastElementChild).toBe(failedShell);
  });

  it("keeps a pending Intervention outside the collapsed detail and suppresses the covered bubble Ask", () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-3" }]),
        message(
          "m2",
          "bot",
          [
            { kind: "text", text: "FINAL-ANSWER-TEXT" },
            approvalAskBlock("BUBBLE-ASK-TEXT", "iv-1", "eff-1"),
          ],
          "run-4",
        ),
      ],
      runs: [run("run-4", "waiting_input", { waitKind: "approval" })],
      activeRunIds: ["run-4"],
      interventions: [approvalIntervention()],
      executions: [
        summary({
          runId: "run-4",
          rev: 2,
          status: "waiting_input",
          waitKind: "approval",
          title: "WAITING-RUN-TITLE",
          anchorMessageId: "m2",
        }),
      ],
    });

    // The bubble keeps its normal text; the covered Ask block is suppressed
    // there. The Intervention Region — reusing the source Ask block — is the
    // ONLY approval surface, so the ask text appears exactly once overall and
    // never as a second card inside the message bubble.
    expect(host.textContent).toContain("FINAL-ANSWER-TEXT");
    expect(countOccurrences(host.textContent, "BUBBLE-ASK-TEXT")).toBe(1);
    const bubble = host.querySelector('[data-message-id="m2"]');
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).not.toContain("BUBBLE-ASK-TEXT");
    const regions = host.querySelectorAll('[data-testid="intervention-region"]');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.textContent).toContain("BUBBLE-ASK-TEXT");
    // The region lives inside the execution shell but OUTSIDE the collapsible
    // detail body, so a pending approval stays visible while the card is shut.
    expect(region.closest('[data-testid="execution-shell"]')).not.toBeNull();
    expect(region.closest('[data-testid="execution-interventions"]')).not.toBeNull();
    expect(region.closest(".exc-details")).toBeNull();
    // Operable: the projected approval actions render enabled buttons.
    const allow = [...region.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Allow"),
    );
    expect(allow).toBeTruthy();
    expect(allow!.hasAttribute("disabled")).toBe(false);
    // Waiting Runs open by the current default-expansion rule.
    const card = region.closest('article[data-testid="execution-card"]');
    expect(card?.getAttribute("data-open")).toBe("1");
  });

  it("consumes the Task Center attention intent once: opens the Run and focuses its Intervention control", async () => {
    setTaskCenterNavIntent({ threadId: THREAD, runId: "run-5", rev: 3, attention: true });
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-4" }]),
        message(
          "m2",
          "bot",
          [
            { kind: "text", text: "PAUSED-ANSWER-TEXT" },
            approvalAskBlock("BUBBLE-ASK-5", "iv-5", "eff-5"),
          ],
          "run-5",
        ),
      ],
      runs: [run("run-5", "waiting_input", { waitKind: "approval" })],
      activeRunIds: ["run-5"],
      interventions: [
        approvalIntervention({
          id: "iv-5",
          runId: "run-5",
          messageId: "m2",
          approval: {
            effectId: "eff-5",
            effectStatus: "intended",
            actions: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
          presentation: { text: "REGION-APPROVAL-5" },
        }),
      ],
      executions: [
        summary({
          runId: "run-5",
          rev: 3,
          status: "waiting_input",
          waitKind: "approval",
          title: "TASK-CENTER-RUN",
          anchorMessageId: "m2",
        }),
      ],
    });

    await act(async () => {
      await sleep(60);
    });

    // The intent is consumed exactly once (module memory cleared).
    expect(peekTaskCenterNavIntent()).toBeNull();
    // The card is open and its detail load was requested against the current
    // artifact target.
    const card = host.querySelector('article[data-testid="execution-card"][data-open="1"]');
    expect(card).not.toBeNull();
    expect(card!.closest('[data-testid="execution-shell"]')!.textContent).toContain(
      "TASK-CENTER-RUN",
    );
    expect(rpcMocks.executionSnapshot).toHaveBeenCalledWith({ botId: BOT, runId: "run-5" });
    // Attention lands on the first operable Intervention control (the approval
    // action button), inside the Intervention Region.
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.closest('[data-testid="execution-interventions"]')).not.toBeNull();
    expect(active!.textContent).toContain("Allow");
  });

  it("force-opens a closed card and focuses the status line for a non-attention Task Center return", async () => {
    const scenario = {
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-5" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-6" }], "run-6"),
      ],
      runs: [run("run-6", "completed", { completedAt: ISO })],
      executions: [
        summary({
          runId: "run-6",
          rev: 7,
          status: "completed",
          title: "CLOSED-RUN-TITLE",
          anchorMessageId: "m2",
        }),
      ],
    };

    // Baseline: without a return intent, a completed Run's card is closed by
    // the current default-expansion rule.
    const closed = renderTranscript(scenario);
    expect(
      closed.querySelector('article[data-testid="execution-card"]')!.getAttribute("data-open"),
    ).toBe("0");

    // The same Run, returned to from the Task Center without attention, is
    // forced open and its status line receives focus.
    setTaskCenterNavIntent({ threadId: THREAD, runId: "run-6", rev: 7, attention: false });
    const host = renderTranscript(scenario);

    await act(async () => {
      await sleep(60);
    });

    expect(peekTaskCenterNavIntent()).toBeNull();
    const openCard = host.querySelector('article[data-testid="execution-card"][data-open="1"]');
    expect(openCard).not.toBeNull();
    expect(openCard!.closest('[data-testid="execution-shell"]')!.textContent).toContain(
      "CLOSED-RUN-TITLE",
    );
    expect(rpcMocks.executionSnapshot).toHaveBeenCalledWith({ botId: BOT, runId: "run-6" });
    // Non-attention focus target: the card's status line.
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.classList.contains("exc-status")).toBe(true);
  });
});
