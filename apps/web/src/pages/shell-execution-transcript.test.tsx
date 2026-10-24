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
 * 4. The execution-nav return intent is consumed once: it opens the target
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
  clearExecutionNavIntent,
  EXECUTION_NAV_INTENT_EVENT,
  peekExecutionNavIntent,
  setExecutionNavIntent,
} from "../lib/execution-nav";

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

let currentOverrides: Partial<ComponentProps<typeof Transcript>> = {};

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
      {...currentOverrides}
    />
  );
}

function renderTranscript(
  overrides: Partial<ComponentProps<typeof Transcript>> = {},
): HTMLDivElement {
  unmountTranscript();
  currentOverrides = overrides;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return container;
}

/**
 * Re-render the SAME mounted Transcript with merged props (a thread refresh
 * landing a newer summary, an event updating an array) — the hook instance
 * and all of its state persist, unlike renderTranscript's fresh mount.
 */
function rerenderTranscript(overrides: Partial<ComponentProps<typeof Transcript>>): void {
  currentOverrides = { ...currentOverrides, ...overrides };
  act(() => {
    root!.render(<Harness />);
  });
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

/** The same ask block after the runtime rewrote it to its answered state. */
function answeredAskBlock(
  text: string,
  interventionId: string,
  effectId: string,
  answer: string,
): MessageBlock {
  return {
    kind: "ask",
    text,
    interventionId,
    approvalEffectId: effectId,
    status: "answered",
    answer,
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
  clearExecutionNavIntent();
  rpcMocks.executionSnapshot.mockReset();
  rpcMocks.executionSnapshot.mockRejectedValue(new Error("detail unavailable in smoke test"));
  rpcMocks.executionActivityPage.mockReset();
  rpcMocks.executionActivityPage.mockRejectedValue(new Error("paging unavailable in smoke test"));
});

afterEach(() => {
  unmountTranscript();
  clearExecutionNavIntent();
});

describe("Shell execution region smoke (UX-01A baseline)", () => {
  it("merges Plan, semantic Steps and Activity into one shell at the anchor, without Todos", () => {
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
    // One shell owns the whole Run: plan, steps and activity.
    expect(shell.querySelector('[data-slot="plan"]')).not.toBeNull();
    expect(shell.querySelector('[data-slot="steps"]')).not.toBeNull();
    expect(shell.querySelector('[data-slot="activity"]')).not.toBeNull();
    expect(shell.textContent).toContain("PLAN-GOAL-1");
    expect(shell.textContent).toContain("STEP-TITLE-1");
    expect(shell.textContent).toContain("STEP-TITLE-2");
    // UX-01B: Todos no longer render in the transcript at all (the legacy
    // "事项清单" fallback is UX-01C scope, and only inside a legal surface).
    expect(shell.querySelector('[data-slot="todos"]')).toBeNull();
    expect(shell.textContent).not.toContain("UNLINKED-TODO-1");
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

  it("gives eligible server summaries exactly one shell and tails a message-less failed Run", () => {
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
        // A plain completed Run (no Plan, no semantic Steps, no pending
        // Intervention, not failed) gets NO execution surface — UX-01B
        // acceptance 1. Its result bubble is the whole presentation.
        summary({
          runId: "run-3",
          rev: 4,
          status: "completed",
          title: "SUMMARY-ONLY-RUN",
          anchorMessageId: "m1",
          counts: { actions: 3 },
        }),
        // A summary whose trusted counts report semantic Steps DOES earn a
        // shell even before its detail loads.
        summary({
          runId: "run-4",
          rev: 1,
          status: "completed",
          title: "COUNTED-STEPS-RUN",
          anchorMessageId: "m1",
          counts: { steps: 2 },
        }),
      ],
    });

    const shells = host.querySelectorAll('[data-testid="execution-shell"]');
    // The failed Run and the counted-steps Run each get exactly one shell;
    // the plain summary-only Run gets none.
    expect(shells).toHaveLength(2);
    const texts = [...shells].map((shell) => shell.textContent ?? "");
    expect(texts.some((text) => text.includes("SUMMARY-ONLY-RUN"))).toBe(false);
    expect(texts.some((text) => text.includes("COUNTED-STEPS-RUN"))).toBe(true);
    const failedShell = [...shells].find((shell) =>
      shell.textContent?.includes("FAILED-RUN-TITLE"),
    )!;
    expect(failedShell.getAttribute("data-status")).toBe("failed");
    // The failed Run has no anchor and falls to __tail, rendering last — as
    // the transcript's final element.
    expect(transcriptOf(host).lastElementChild).toBe(failedShell);
  });

  it("creates no execution surface for Todo-only, Activity-only or plain active Runs", () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-6" }]),
        message("m2", "bot", [{ kind: "text", text: "BOT-ANSWER-6" }], "run-todo"),
        message("m3", "bot", [{ kind: "text", text: "BOT-ANSWER-7" }], "run-activity"),
      ],
      todos: [todo("run-todo", "todo-1", "TODO-ONLY-ITEM", null)],
      activity: [activity("act-1", "run-activity", "ACTIVITY-ONLY-ITEM")],
      runs: [
        run("run-todo", "completed"),
        run("run-activity", "completed"),
        run("run-plain", "running"),
      ],
      activeRunIds: ["run-plain"],
      executions: [
        summary({ runId: "run-todo", title: "TODO-ONLY-RUN", anchorMessageId: "m2" }),
        summary({
          runId: "run-activity",
          title: "ACTIVITY-ONLY-RUN",
          anchorMessageId: "m3",
          counts: { actions: 4 },
        }),
        summary({ runId: "run-plain", rev: 1, status: "running", title: "PLAIN-ACTIVE-RUN" }),
      ],
    });
    // UX-01B acceptance 1/3: Todos and tool Activity never create a surface,
    // and a plain running Run stays with its lightweight status only.
    expect(host.querySelectorAll('[data-testid="execution-shell"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="plan"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="steps"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="todos"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("TODO-ONLY-ITEM");
  });

  it("creates a surface for a single semantic Step without any progress numbers", () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-8" }]),
        message("m2", "bot", [{ kind: "text", text: "BOT-ANSWER-8" }], "run-one-step"),
      ],
      steps: [step("run-one-step", "step-1", "SINGLE-STEP-TITLE", 0)],
      runs: [run("run-one-step", "completed")],
      executions: [
        summary({ runId: "run-one-step", title: "ONE-STEP-RUN", anchorMessageId: "m2" }),
      ],
    });
    // Acceptance 3: even ONE semantic Step earns the execution surface...
    const shells = host.querySelectorAll('[data-testid="execution-shell"]');
    expect(shells).toHaveLength(1);
    expect(shells[0]!.textContent).toContain("SINGLE-STEP-TITLE");
    // ...acceptance 6: without a Plan there is no count, no bar, no rail.
    expect(host.querySelector('[data-testid="execution-plan-count"]')).toBeNull();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(host.querySelector(".exc-rail")).toBeNull();
  });

  it("returns a settled ask bubble when its plain Run has no surface", () => {
    const answeredAsk = answeredAskBlock("HISTORICAL-ASK-TEXT", "iv-9", "eff-9", "allow");
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-9" }]),
        message("m2", "bot", [{ kind: "text", text: "DONE-TEXT-9" }, answeredAsk], "run-9"),
      ],
      runs: [run("run-9", "completed")],
      interventions: [
        approvalIntervention({ id: "iv-9", runId: "run-9", messageId: "m2", status: "answered" }),
      ],
      executions: [summary({ runId: "run-9", title: "SETTLED-ASK-RUN", anchorMessageId: "m2" })],
    });
    // No Plan/Steps/pending/failed → no surface; the bubble's own answered
    // AskCard is the honest history echo instead of a vanished region card.
    expect(host.querySelectorAll('[data-testid="execution-shell"]')).toHaveLength(0);
    const bubble = host.querySelector('[data-message-id="m2"]');
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain("HISTORICAL-ASK-TEXT");
  });

  it("keeps a settled ask suppressed while its Run keeps a surface", () => {
    const answeredAsk = answeredAskBlock("COVERED-ASK-TEXT", "iv-8", "eff-8", "allow");
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-10" }]),
        message("m2", "bot", [{ kind: "text", text: "DONE-TEXT-10" }, answeredAsk], "run-8"),
      ],
      steps: [step("run-8", "step-1", "ELIGIBLE-STEP", 0)],
      runs: [run("run-8", "completed")],
      interventions: [
        approvalIntervention({ id: "iv-8", runId: "run-8", messageId: "m2", status: "answered" }),
      ],
      executions: [summary({ runId: "run-8", title: "ELIGIBLE-ASK-RUN", anchorMessageId: "m2" })],
    });
    // The Run is eligible (semantic Step), so its region owns the settled
    // card and the bubble ask stays suppressed — exactly one presentation.
    const shells = host.querySelectorAll('[data-testid="execution-shell"]');
    expect(shells).toHaveLength(1);
    expect(countOccurrences(host.textContent, "COVERED-ASK-TEXT")).toBe(1);
    const bubble = host.querySelector('[data-message-id="m2"]');
    expect(bubble!.textContent).not.toContain("COVERED-ASK-TEXT");
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
    // UX-01B acceptance 4/7: a waiting Run's card is collapsed by default —
    // the Intervention controls stay operable OUTSIDE the collapsed detail.
    const card = region.closest('article[data-testid="execution-card"]');
    expect(card?.getAttribute("data-open")).toBe("0");
    expect(region.closest(".exc-details")).toBeNull();
  });

  it("consumes the execution-nav attention intent once: opens the Run and focuses its Intervention control", async () => {
    setExecutionNavIntent({ threadId: THREAD, runId: "run-5", rev: 3, attention: true });
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
    expect(peekExecutionNavIntent()).toBeNull();
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

  it("force-opens a closed card and focuses the status line for a non-attention execution-nav return", async () => {
    const scenario = {
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-5" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-6" }], "run-6"),
      ],
      // A semantic Step keeps this completed Run eligible for a surface.
      steps: [step("run-6", "step-1", "RESTORED-STEP", 0)],
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

    // The same Run, returned to via the execution-nav intent without
    // attention, is forced open and its status line receives focus.
    setExecutionNavIntent({ threadId: THREAD, runId: "run-6", rev: 7, attention: false });
    const host = renderTranscript(scenario);

    await act(async () => {
      await sleep(60);
    });

    expect(peekExecutionNavIntent()).toBeNull();
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

  it("leaves a plain active Run with only the lightweight progress bubble (acceptance 2)", () => {
    const progressMessage: ThreadMessage = {
      id: "progress:run-p",
      threadId: THREAD,
      seq: 0,
      role: "bot",
      botId: BOT,
      runId: "run-p",
      blocks: [{ kind: "progress", text: "READING-NOW" } as MessageBlock],
      createdAt: ISO,
    };
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-12" }]),
        progressMessage,
      ],
      runs: [run("run-p", "running")],
      activeRunIds: ["run-p"],
      executions: [
        summary({ runId: "run-p", rev: 1, status: "running", title: "PLAIN-RUN-TITLE" }),
      ],
    });
    // No execution surface, no plan/steps/todos slots, no numbers — only the
    // existing single-line lightweight status of the progress message.
    expect(host.querySelectorAll('[data-testid="execution-shell"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="plan"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="steps"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="todos"]')).toHaveLength(0);
    expect(host.textContent).toContain("READING-NOW");
    expect(host.textContent).not.toContain("PLAIN-RUN-TITLE");
  });

  it("keeps a live card open when its own detail load lands on a fresher rev", async () => {
    // Review-round regression: opening a live Run's card triggers the detail
    // fetch; for an actively-eventing Run the response carries a NEWER rev
    // than the thread summary the toggle stored. That arrival is the same
    // projection the user just opened — it must re-key the stored decision,
    // never self-close the card.
    rpcMocks.executionSnapshot.mockResolvedValue({
      summary: summary({
        runId: "run-live",
        rev: 9,
        status: "running",
        title: "LIVE-RUN-TITLE",
        anchorMessageId: "m2",
      }),
      steps: { items: [step("run-live", "s1", "LIVE-STEP", 0)], truncated: false },
      todos: { items: [], truncated: false },
      timeline: [],
      activityPage: { items: [], olderCursor: null, truncated: false },
      interventions: [],
    } as never);
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-17" }]),
        message("m2", "bot", [{ kind: "text", text: "PARTIAL-ANSWER-17" }], "run-live"),
      ],
      steps: [step("run-live", "s1", "LIVE-STEP", 0)],
      runs: [run("run-live", "running")],
      activeRunIds: ["run-live"],
      executions: [
        summary({
          runId: "run-live",
          rev: 5,
          status: "running",
          title: "LIVE-RUN-TITLE",
          anchorMessageId: "m2",
        }),
      ],
    });
    const collapsed = host.querySelector('article[data-testid="execution-card"]');
    expect(collapsed!.getAttribute("data-open")).toBe("0");
    const toggle = collapsed!.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(80);
    });
    const opened = host.querySelector('article[data-testid="execution-card"]');
    expect(opened!.getAttribute("data-open")).toBe("1");
    expect(host.textContent).toContain("LIVE-STEP");
  });

  it("re-checks a sidebar-set intent on the ping event without a remount (acceptance 12)", async () => {
    // The transcript is ALREADY mounted on the target thread — the sidebar
    // click on the same conversation cannot rely on a threadId change, so it
    // announces the intent through the shared window event.
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-11" }]),
        message(
          "m2",
          "bot",
          [
            { kind: "text", text: "WAITING-TEXT-11" },
            approvalAskBlock("BUBBLE-ASK-11", "iv-11", "eff-11"),
          ],
          "run-11",
        ),
      ],
      runs: [run("run-11", "waiting_input", { waitKind: "approval" })],
      activeRunIds: ["run-11"],
      interventions: [
        approvalIntervention({
          id: "iv-11",
          runId: "run-11",
          messageId: "m2",
          approval: {
            effectId: "eff-11",
            effectStatus: "intended",
            actions: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
          presentation: { text: "REGION-APPROVAL-11" },
        }),
      ],
      executions: [
        summary({
          runId: "run-11",
          rev: 2,
          status: "waiting_input",
          waitKind: "approval",
          title: "SIDEBAR-RETURN-RUN",
          anchorMessageId: "m2",
        }),
      ],
    });
    expect(peekExecutionNavIntent()).toBeNull();

    setExecutionNavIntent({ threadId: THREAD, runId: "run-11", rev: 2, attention: true });
    act(() => {
      window.dispatchEvent(new Event(EXECUTION_NAV_INTENT_EVENT));
    });
    await act(async () => {
      await sleep(60);
    });

    expect(peekExecutionNavIntent()).toBeNull();
    const card = host.querySelector('article[data-testid="execution-card"][data-open="1"]');
    expect(card).not.toBeNull();
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.closest('[data-testid="execution-interventions"]')).not.toBeNull();
    expect(active!.textContent).toContain("Allow");
  });

  it("shows a safe retry when the detail load fails and recovers on retry (UX-01C acceptance 14)", async () => {
    const detailSnapshot = {
      summary: summary({ runId: "run-e", rev: 5, title: "ERROR-PATH-RUN", anchorMessageId: "m2" }),
      plan: plan("run-e"),
      steps: {
        items: [step("run-e", "step-e", "DETAIL-STEP-TITLE", 0)],
        truncated: false,
      },
      todos: { items: [], truncated: false },
      timeline: [],
      activityPage: { items: [], olderCursor: null, truncated: false },
      interventions: [],
    };
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-13" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-13" }], "run-e"),
      ],
      plans: [plan("run-e")],
      runs: [run("run-e", "completed", { completedAt: ISO })],
      executions: [
        summary({ runId: "run-e", rev: 5, title: "ERROR-PATH-RUN", anchorMessageId: "m2" }),
      ],
    });
    const card = host.querySelector('article[data-testid="execution-card"]');
    expect(card).not.toBeNull();
    // The level-0 Plan count exists before any detail load (legacy array).
    expect(card!.textContent).toContain("1/1");

    // Opening requests the detail; the default mock rejects — the failure
    // becomes a stable safe state with a retry, never a silent swallow.
    const toggle = card!.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(60);
    });
    const error = host.querySelector('[data-testid="execution-detail-error"]');
    expect(error).not.toBeNull();
    // The raw transport error never reaches the DOM.
    expect(error!.textContent).not.toContain("detail unavailable in smoke test");
    expect(host.querySelector('[data-testid="execution-detail-retry"]')).not.toBeNull();
    // Level-0 numbers keep their value — never 0 or "--".
    expect(card!.textContent).toContain("1/1");
    expect(card!.textContent).not.toContain("--");

    // Retry against the current target succeeds and clears the error.
    rpcMocks.executionSnapshot.mockResolvedValue(detailSnapshot as never);
    const retry = host.querySelector<HTMLElement>('[data-testid="execution-detail-retry"]');
    act(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(60);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();
    expect(host.textContent).toContain("DETAIL-STEP-TITLE");
    expect(card!.textContent).toContain("1/1");
    const calls = rpcMocks.executionSnapshot.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]![0]).toEqual({ botId: BOT, runId: "run-e" });
  });

  it("keeps a failed detail request from clearing an already-cached detail", async () => {
    const detailSnapshot = {
      summary: summary({ runId: "run-c", rev: 7, title: "CACHED-RUN", anchorMessageId: "m2" }),
      steps: { items: [step("run-c", "step-c", "CACHED-STEP-TITLE", 0)], truncated: false },
      todos: { items: [], truncated: false },
      timeline: [],
      activityPage: { items: [], olderCursor: null, truncated: false },
      interventions: [],
    };
    rpcMocks.executionSnapshot.mockResolvedValueOnce(detailSnapshot as never);
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-14" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-14" }], "run-c"),
      ],
      steps: [step("run-c", "step-c", "CACHED-STEP-TITLE", 0)],
      runs: [run("run-c", "completed", { completedAt: ISO })],
      executions: [summary({ runId: "run-c", rev: 7, title: "CACHED-RUN", anchorMessageId: "m2" })],
    });
    const card = host.querySelector('article[data-testid="execution-card"]');
    const toggle = card!.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(60);
    });
    expect(host.textContent).toContain("CACHED-STEP-TITLE");
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();

    // A later failed refresh (rev move) must not blank the level-0 card and
    // surfaces the retry again; subsequent default mock rejects.
    rpcMocks.executionSnapshot.mockRejectedValue(new Error("transient"));
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(30);
    });
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(60);
    });
    // The cached detail (rev 7 == summary rev) is still authoritative: the
    // card keeps its content and no raw error leaks.
    expect(host.textContent).toContain("CACHED-STEP-TITLE");
    expect(host.textContent).not.toContain("transient");
  });

  it("renders the legacy 事项清单 fallback only inside an expanded legal surface (UX-01C acceptance 16)", async () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-15" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-15" }], "run-t"),
      ],
      todos: [todo("run-t", "todo-f1", "FALLBACK-ITEM-1", null)],
      runs: [run("run-t", "failed")],
      executions: [
        summary({
          runId: "run-t",
          rev: 2,
          status: "failed",
          failure: "Scripted run failure",
          title: "TODO-FALLBACK-RUN",
          anchorMessageId: "m2",
        }),
      ],
    });
    // The failure makes the surface legal; collapsed, the fallback is not in
    // the DOM at all (not merely hidden).
    expect(host.querySelector('[data-testid="execution-shell"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="todos"]')).toBeNull();

    const card = host.querySelector('article[data-testid="execution-card"]');
    const toggle = card!.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(30);
    });
    const todosSlot = host.querySelector('[data-slot="todos"]');
    expect(todosSlot).not.toBeNull();
    expect(todosSlot!.textContent).toContain("FALLBACK-ITEM-1");
    expect(todosSlot!.textContent).toContain("This run has no plan");
    expect((todosSlot!.textContent ?? "").toLowerCase()).not.toContain("todo");
    expect(todosSlot!.textContent).not.toContain("待办");
    expect(todosSlot!.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
    // The Run-level failure reason shares the detail (no failed Step).
    expect(host.querySelector('[data-testid="execution-failure-reason"]')).not.toBeNull();
  });

  it("hides Todos behind Steps/Plan in the fixed degradation order (UX-01C acceptance 16)", async () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-16" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-16" }], "run-s"),
      ],
      steps: [step("run-s", "step-s", "STEP-OF-RUN-S", 0)],
      todos: [todo("run-s", "todo-s1", "HIDDEN-TODO-OF-STEPS-RUN", null)],
      runs: [run("run-s", "completed", { completedAt: ISO })],
      executions: [
        summary({ runId: "run-s", rev: 3, title: "STEPS-WIN-RUN", anchorMessageId: "m2" }),
      ],
    });
    const card = host.querySelector('article[data-testid="execution-card"]');
    const toggle = card!.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(30);
    });
    // Steps exist → level 1 is the Steps list; the Todo fallback never shows.
    expect(host.querySelector('[data-slot="steps"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="todos"]')).toBeNull();
    expect(host.textContent).not.toContain("HIDDEN-TODO-OF-STEPS-RUN");
  });

  it("never synthesizes a Plan from Activity, Markdown or message steps blocks (acceptance 19)", () => {
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "plan_write please" }]),
        message(
          "m2",
          "bot",
          [
            { kind: "text", text: "1. First\n2. Second" },
            { kind: "steps", steps: [{ label: "plan_write", count: 2 }] },
          ],
          "run-n",
        ),
      ],
      activity: [
        {
          id: "act-plan",
          runId: "run-n",
          botId: BOT,
          threadId: THREAD,
          kind: "planning",
          status: "completed",
          title: "plan_write",
        } as ActivityItem,
      ],
      runs: [run("run-n", "completed", { completedAt: ISO })],
      executions: [
        summary({
          runId: "run-n",
          rev: 1,
          title: "NATIVE-PLAN-RUN",
          anchorMessageId: "m2",
          counts: { actions: 2 },
        }),
      ],
    });
    // No RunPlanRevision → no surface, no Plan slot, no progress anywhere —
    // native plan tooling, Markdown lists and steps blocks never fake one.
    expect(host.querySelectorAll('[data-testid="execution-shell"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-slot="plan"]')).toHaveLength(0);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(host.querySelector('[data-testid="execution-plan-count"]')).toBeNull();
  });

  it("invalidates a stale detail error when the summary revision advances (review round P3)", async () => {
    rpcMocks.executionSnapshot.mockRejectedValueOnce(new Error("transient"));
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-18" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-18" }], "run-r"),
      ],
      steps: [step("run-r", "s-r", "STEP-R", 0)],
      runs: [run("run-r", "completed", { completedAt: ISO })],
      executions: [summary({ runId: "run-r", rev: 5, title: "REV-RUN", anchorMessageId: "m2" })],
    });
    const toggle = host.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(50);
    });
    // The rev-5 request failed: the safe retry state is visible.
    expect(host.querySelector('[data-testid="execution-detail-error"]')).not.toBeNull();

    // The projection moves to rev 6 (thread refresh): the rev-5 error
    // describes a request against a projection that no longer exists and
    // must not survive the move.
    rerenderTranscript({
      executions: [summary({ runId: "run-r", rev: 6, title: "REV-RUN", anchorMessageId: "m2" })],
    });
    await act(async () => {
      await sleep(20);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();
  });

  it("a stale success never clears the newer revision's error or retry (review round 2)", async () => {
    let resolveFirst: ((snapshot: unknown) => void) | null = null;
    let rejectSecond: ((error: unknown) => void) | null = null;
    rpcMocks.executionSnapshot
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-20" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-20" }], "run-s"),
      ],
      steps: [step("run-s", "s-cur", "STEP-CURRENT", 0)],
      runs: [run("run-s", "completed", { completedAt: ISO })],
      executions: [
        summary({ runId: "run-s", rev: 5, title: "STALE-SUCCESS-RUN", anchorMessageId: "m2" }),
      ],
    });
    // Request A goes out at rev 5 and stays in flight.
    const toggleA = host.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggleA!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(20);
    });

    // The projection moves to rev 6; the user reopens → request B at rev 6.
    rerenderTranscript({
      executions: [
        summary({ runId: "run-s", rev: 6, title: "STALE-SUCCESS-RUN", anchorMessageId: "m2" }),
      ],
    });
    await act(async () => {
      await sleep(20);
    });
    const toggleB = host.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggleB!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(20);
    });

    // B fails: the safe error and its retry entry are visible at rev 6.
    act(() => {
      rejectSecond!(new Error("fresh transport failure"));
    });
    await act(async () => {
      await sleep(30);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="execution-detail-retry"]')).not.toBeNull();

    // A's stale rev-5 success lands late: the rev guard drops the snapshot,
    // and the settle must NOT delete the rev-6 error it does not own.
    await act(async () => {
      resolveFirst!({
        summary: summary({
          runId: "run-s",
          rev: 5,
          title: "STALE-SUCCESS-RUN",
          anchorMessageId: "m2",
        }),
        steps: { items: [step("run-s", "s-stale", "STALE-STEP", 0)], truncated: false },
        todos: { items: [], truncated: false },
        timeline: [],
        activityPage: { items: [], olderCursor: null, truncated: false },
        interventions: [],
      });
      await sleep(30);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="execution-detail-retry"]')).not.toBeNull();
    // The stale snapshot never rendered either (rev-versioned cache guard).
    expect(host.textContent).not.toContain("STALE-STEP");
  });

  it("a late failure from a superseded request never surfaces at the newer revision (review round P3)", async () => {
    let rejectFirst: ((error: unknown) => void) | null = null;
    let resolveSecond: ((snapshot: unknown) => void) | null = null;
    rpcMocks.executionSnapshot
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const host = renderTranscript({
      messages: [
        message("m1", "user", [{ kind: "text", text: "USER-QUESTION-19" }]),
        message("m2", "bot", [{ kind: "text", text: "RESULT-TEXT-19" }], "run-r2"),
      ],
      steps: [step("run-r2", "s-old", "STEP-OLD", 0)],
      runs: [run("run-r2", "completed", { completedAt: ISO })],
      executions: [
        summary({ runId: "run-r2", rev: 5, title: "LATE-FAIL-RUN", anchorMessageId: "m2" }),
      ],
    });
    // Request A goes out at rev 5 and stays in flight.
    const toggleA = host.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggleA!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(20);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();

    // The projection moves to rev 6 and the card is reopened → request B at
    // rev 6 (the in-flight dedupe must not block the newer revision).
    rerenderTranscript({
      executions: [
        summary({ runId: "run-r2", rev: 6, title: "LATE-FAIL-RUN", anchorMessageId: "m2" }),
      ],
    });
    await act(async () => {
      await sleep(20);
    });
    const toggleB = host.querySelector<HTMLElement>(".exc-entry");
    act(() => {
      toggleB!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await sleep(20);
    });

    // A fails late: the rev-6 request state must not be rewritten.
    act(() => {
      rejectFirst!(new Error("stale transport failure"));
    });
    await act(async () => {
      await sleep(30);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();
    expect(host.textContent).not.toContain("stale transport failure");

    // B succeeds: its detail renders and no error state appears.
    await act(async () => {
      resolveSecond!({
        summary: summary({
          runId: "run-r2",
          rev: 6,
          title: "LATE-FAIL-RUN",
          anchorMessageId: "m2",
        }),
        steps: { items: [step("run-r2", "s-fresh", "FRESH-STEP", 0)], truncated: false },
        todos: { items: [], truncated: false },
        timeline: [],
        activityPage: { items: [], olderCursor: null, truncated: false },
        interventions: [],
      });
      await sleep(30);
    });
    expect(host.querySelector('[data-testid="execution-detail-error"]')).toBeNull();
    expect(host.textContent).toContain("FRESH-STEP");
  });
});

describe("public group delegation transcript", () => {
  const publicOutbound: ThreadMessage = {
    id: "public-out",
    threadId: THREAD,
    seq: 11,
    role: "bot",
    botId: "bot-sender",
    runId: "source-run",
    blocks: [
      {
        kind: "bot_message_sent",
        toBotId: "bot-target",
        toBotName: "Target old name",
        text: "Review the public draft.",
        intent: "request",
      },
    ],
    createdAt: ISO,
  };
  const publicInbound: ThreadMessage = {
    id: "public-in",
    threadId: THREAD,
    seq: 10,
    role: "user",
    runId: "target-run",
    blocks: [
      {
        kind: "bot_message_received",
        fromBotId: "bot-sender",
        fromBotName: "Sender old name",
        text: "Review the public draft.",
        intent: "request",
        returnToMessageId: "public-out",
      },
    ],
    createdAt: ISO,
  };

  it("renders public records without opening the private pair UI", () => {
    const openBot = vi.fn();
    const openPair = vi.fn();
    const host = renderTranscript({
      artifactTarget: { groupId: "group-1" },
      messages: [publicInbound, publicOutbound],
      runs: [run("target-run", "queued", { botId: "bot-target", trigger: "bot_message" })],
      botNameOf: (botId) =>
        ({ "bot-sender": "Sender current name", "bot-target": "Target current name" })[botId],
      peerBot: () => ({ color: "#3EC5A8" }),
      onOpenBot: openBot,
      onOpenPeerMessages: openPair,
    });

    expect(host.querySelectorAll('[data-testid="public-delegation"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="peer-receipt-chip"]')).toHaveLength(0);
    expect(host.textContent).toContain("Sender current name");
    expect(host.textContent).toContain("Target current name");
    expect(host.textContent).toContain("Review the public draft.");
    expect(host.querySelector('[data-status="queued"]')).not.toBeNull();

    const mention = host.querySelector<HTMLAnchorElement>('[data-testid="agent-mention"]');
    act(() => {
      mention?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openBot).toHaveBeenCalledWith("bot-target");
    expect(openPair).not.toHaveBeenCalled();
  });

  it("shows target confirmation only after a real target Message arrives", () => {
    const host = renderTranscript({
      artifactTarget: { groupId: "group-1" },
      messages: [publicInbound, publicOutbound],
      runs: [run("target-run", "running", { botId: "bot-target", trigger: "bot_message" })],
      botNameOf: (botId) => ({ "bot-sender": "Sender", "bot-target": "Target" })[botId],
      peerBot: () => ({ color: "#3EC5A8" }),
    });

    expect(host.textContent).not.toContain("TARGET-REAL-CONFIRMATION");
    rerenderTranscript({
      messages: [
        publicInbound,
        publicOutbound,
        {
          ...message(
            "target-response",
            "bot",
            [{ kind: "text", text: "TARGET-REAL-CONFIRMATION" }],
            "target-run",
          ),
          botId: "bot-target",
          seq: 12,
        },
      ],
    });

    expect(host.textContent).toContain("TARGET-REAL-CONFIRMATION");
    expect(host.querySelectorAll('[data-testid="public-delegation"]')).toHaveLength(1);
  });
});
