import { useLingui } from "@lingui/react/macro";
import type {
  ActivityItem,
  InteractionView,
  InterventionView,
  Run,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExecutionActivity } from "../../components/ai/ExecutionActivity";
import { ExecutionShell, FOCUSABLE_CONTROL } from "../../components/ai/ExecutionShell";
import { InterventionRegion } from "../../components/ai/InterventionRegion";
import { InteractionRegion } from "../../components/ai/interactions/InteractionRegion";
import { DisplayBlockList } from "../../components/ai/display/DisplayBlockView";
import { RunPlanDisclosure } from "../../components/ai/RunPlanDisclosure";
import { RunResult } from "../../components/ai/RunResult";
import { RunStepsDisclosure } from "../../components/ai/RunStepsDisclosure";
import { RunTodoList } from "../../components/ai/RunTodoList";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { newClientId } from "../../lib/client-id";
import { resultHasText } from "../../lib/execution-card";
import {
  beginDetailRequest,
  type DetailRequestMap,
  detailRequestStatus,
  failDetailRequest,
  settleDetailRequest,
} from "../../lib/execution-detail-request";
import {
  appendExecutionActivityPage,
  type ExecutionDetailCache,
  type ExpansionMap,
  executionDataForRun,
  executionRunState,
  forceOpenExpansion,
  installExecutionDetail,
  isExpansionOpen,
  mergeActivityPages,
  planExpansionDefaults,
  readExecutionExpansions,
  rekeyExpansionRev,
  resolveExecutionAnchor,
  selectCachedDetailEntry,
  summariesByRun,
  toggleExpansion,
} from "../../lib/execution-history";
import { eligibleExecutionRunIds } from "../../lib/execution-surface";
import {
  coveredAskMessageIds,
  coveredAskMessageIdsFromInteractions,
  mergeInterventionViews,
  mergeInteractionViews,
  pendingInteractionKindsForRun,
  pendingInterventionKindsForRun,
} from "../../lib/intervention-view";
import { manualRetryErrorMessage } from "../../lib/manual-retry";
import { rpc } from "../../lib/rpc";
import { isRunActive } from "../../lib/run-status";
import {
  clearExecutionNavIntent,
  EXECUTION_NAV_INTENT_EVENT,
  peekExecutionNavIntent,
  setExecutionNavIntent,
} from "../../lib/execution-nav";
import { unlinkedRunTodos } from "../../lib/work-progress-view";

/**
 * UX-01A: the conversation execution region, extracted from `Transcript`
 * with ZERO behavior change. This hook owns every execution responsibility
 * that used to live inline in `Shell.tsx`:
 *
 * - Intervention merge/settle state and covered-Ask derivation;
 * - server per-Run summaries (HISTORY-001) and anchor resolution;
 * - expansion state (sessionStorage, one open card per Thread, rev-matched);
 * - the versioned detail cache, Activity paging lock and stale-revision guard;
 * - Plan / Steps / Todo / Activity / summary / Intervention / active-Run
 *   anchoring and merging into one shell per Run, gated by the UX-01B
 *   surface eligibility (Plan, semantic Step, pending Intervention, failed —
 *   Todos and Activity never create a shell on their own, and the legacy
 *   Todo list no longer renders; its "事项清单" fallback is UX-01C scope);
 * - the execution-nav "return to conversation" intent consumption, force-open
 *   and focus retry;
 * - the per-anchor `ExecutionShell` rendering.
 *
 * `Transcript` keeps the plain message list, scrolling, selection quoting,
 * replies/reactions, voice and background tasks, and feeds this hook the
 * read-only `messageById` map it already builds for reply previews.
 */
export type UseExecutionTranscriptInput = {
  threadId: string;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  /** Read-only input: the same map `Transcript` builds for reply previews. */
  messageById: ReadonlyMap<string, ThreadMessage>;
  plans?: ThreadSnapshot["plans"];
  steps?: ThreadSnapshot["steps"];
  todos?: ThreadSnapshot["todos"];
  runs: Run[];
  activeRunIds: string[];
  interventions?: ThreadSnapshot["interventions"];
  /** CARD-01A strict projection; present only when the server gate is on. */
  interactions?: ThreadSnapshot["interactions"];
  cardsUnifiedV2?: boolean;
  conversationName?: string;
  groupNameOf?: (groupId: string) => string | undefined;
  onOpenComputer?: (botId: string) => void;
  /** Server per-Run summaries (HISTORY-001); absent on older servers. */
  executions?: ThreadSnapshot["executions"];
  activity?: ActivityItem[];
  showActivityAvatars?: boolean;
  activityBotColors?: Record<string, string>;
  /** UX-02: resolves a Bot display name for the plan review card header. */
  botNameOf?: (botId: string) => string | undefined;
  onRefresh: () => Promise<void>;
};

export function useExecutionTranscript({
  threadId,
  artifactTarget,
  messages,
  messageById,
  plans,
  steps,
  todos,
  runs,
  activeRunIds,
  interventions,
  interactions,
  cardsUnifiedV2,
  conversationName,
  groupNameOf,
  onOpenComputer,
  executions,
  activity,
  showActivityAvatars,
  activityBotColors,
  botNameOf,
  onRefresh,
}: UseExecutionTranscriptInput) {
  const { t } = useLingui();
  const [settledInterventions, setSettledInterventions] = useState<InterventionView[]>([]);
  const shownInterventions = useMemo(
    () => mergeInterventionViews(interventions, settledInterventions),
    [interventions, settledInterventions],
  );
  // HISTORY-001: server-driven execution state. Null summaries (older server)
  // keeps every legacy derivation below untouched.
  const serverSummaries = useMemo(() => summariesByRun({ executions }), [executions]);
  const [expansionEntries, setExpansionEntries] = useState<ExpansionMap>(readExecutionExpansions);
  // Detail cache keyed by Run AND rev. Snapshot, first-page cursor and the
  // loaded older pages are ONE versioned unit per Run: a moved rev replaces
  // all three together and a stale response can never mix versions.
  const [executionDetails, setExecutionDetails] = useState<ExecutionDetailCache>({});
  // UX-01C acceptance 14: per-Run detail REQUEST state (idle | loading |
  // error), deliberately OUTSIDE the rev-versioned cache — an error is a
  // transport fact, never a snapshot version.
  const [detailRequests, setDetailRequests] = useState<DetailRequestMap>({});
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ runId: string; message: string } | null>(null);
  // PD-01 P2: predecessors this session already retried, mapped to the
  // successor the server returned. A predecessor merged from an older history
  // page keeps its cached `manualRetry.allowed=true` after a refresh, because
  // the fresh snapshot cannot contain a Run outside its window; this map stands
  // in for the successor fact the stale summary lacks. It follows the server
  // rule (projectManualRetryEligibility): a successor that is active or
  // completed hides the entry, a failed/cancelled one makes it retryable again
  // — a repeat click only replays that successor, never creates a second.
  const [retriedSuccessors, setRetriedSuccessors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const retryNonceByRun = useRef(new Map<string, string>());
  const detailInFlight = useRef<Set<string>>(new Set());
  // UX-01B core rule 1: only Runs with a structured Plan, a semantic Step, a
  // pending Intervention (or any waiting state) or a failure get an Execution
  // surface. Todos, tool Activity and plain running states never create one;
  // a plain Run lives in the lightweight progress-message line only.
  const eligibleRunIds = useMemo(
    () =>
      eligibleExecutionRunIds({
        runs,
        plans,
        steps,
        serverSummaries,
        executionDetails,
        interventions: shownInterventions,
        interactions: cardsUnifiedV2 ? interactions : undefined,
      }),
    [
      runs,
      plans,
      steps,
      serverSummaries,
      executionDetails,
      shownInterventions,
      cardsUnifiedV2,
      interactions,
    ],
  );
  // PD-01: message-level retry entries for cancelled Runs that kept NO
  // execution-card surface. The association is projection-driven
  // (summary.sourceMessageId, D9), so it restores identically after reload
  // and history pagination — including a secondary bot's Run of a group
  // message, which message.runId cannot express. Runs WITH a surface keep
  // the card's own entry (D7); a denied projection never yields an
  // actionable entry (D4).
  const messageRetryEntries = useMemo(() => {
    const entries = new Map<string, Array<{ runId: string; botId: string }>>();
    if (!serverSummaries) return entries;
    for (const summary of serverSummaries.values()) {
      if (summary.status !== "cancelled") continue;
      if (!summary.sourceMessageId) continue;
      if (eligibleRunIds.has(summary.runId)) continue;
      if (summary.manualRetry?.allowed !== true) continue;
      const successorId = retriedSuccessors.get(summary.runId);
      if (successorId) {
        const successorStatus = serverSummaries.get(successorId)?.status;
        if (successorStatus !== "failed" && successorStatus !== "cancelled") continue;
      }
      const list = entries.get(summary.sourceMessageId) ?? [];
      list.push({ runId: summary.runId, botId: summary.botId });
      entries.set(summary.sourceMessageId, list);
    }
    return entries;
  }, [serverSummaries, eligibleRunIds, retriedSuccessors]);
  // Message ids whose bubble ask block already carries a settled status: a
  // settled Intervention of a surface-less Run yields its ask back to the
  // bubble (honest history) instead of vanishing with the region.
  const settledAskMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.kind === "ask" && (block.status === "answered" || block.status === "expired")) {
          ids.add(message.id);
        }
      }
    }
    return ids;
  }, [messages]);
  const coveredAsks = useMemo(() => {
    if (cardsUnifiedV2 && interactions) {
      return coveredAskMessageIdsFromInteractions(interactions, {
        eligibleRunIds,
        settledAskMessageIds,
      });
    }
    return coveredAskMessageIds(shownInterventions, { eligibleRunIds, settledAskMessageIds });
  }, [cardsUnifiedV2, interactions, shownInterventions, eligibleRunIds, settledAskMessageIds]);
  const activityLoading = useRef<Record<string, boolean>>({});
  // The server-chosen anchor wins when its message is actually loaded; a
  // paged-out anchor must never hide a shell whose content is a pending
  // intervention (those fall back to the legacy last-bot/__tail chain and
  // re-anchor to the server position once their page is loaded).
  const anchorOf = useCallback(
    (runId: string, legacy: string | null): string | null => {
      const summary = serverSummaries?.get(runId);
      return resolveExecutionAnchor({
        summary,
        legacyAnchorMessageId: legacy,
        anchorIsLoaded: summary?.anchorMessageId
          ? messageById.has(summary.anchorMessageId)
          : undefined,
      });
    },
    [serverSummaries, messageById],
  );
  // One open detail per Thread at any moment — initial render, refresh and
  // rev moves included. Stored rev-matching entries stay authoritative;
  // UX-01B removed every status-based default-open, so the plan only
  // normalizes stored decisions (surface-less Runs cannot consume the
  // single-open budget). Runs outside the summary window (detail-only) fall
  // back to the per-Run stored resolution below.
  const expansionPlan = useMemo(() => {
    if (!serverSummaries) return null;
    const planned: Array<{ runId: string; rev: number; status: string }> = [];
    for (const summary of serverSummaries.values()) {
      if (!eligibleRunIds.has(summary.runId)) continue;
      const entry = selectCachedDetailEntry(executionDetails, summary.runId, summary.rev);
      const source = entry?.snapshot.summary ?? summary;
      planned.push({ runId: summary.runId, rev: source.rev, status: source.status });
    }
    return planExpansionDefaults({ entries: expansionEntries, threadId, runs: planned });
  }, [serverSummaries, executionDetails, expansionEntries, threadId, eligibleRunIds]);

  const plansByAnchor = useMemo(() => {
    const anchors = new Map<string, NonNullable<ThreadSnapshot["plans"]>>();
    for (const plan of plans ?? []) {
      const source =
        plan.sourceMessageId && messageById.has(plan.sourceMessageId) ? plan.sourceMessageId : null;
      const lastBotMessage = [...messages]
        .reverse()
        .find((message) => message.runId === plan.runId && message.role === "bot");
      const anchor =
        source ?? lastBotMessage?.id ?? (activeRunIds.includes(plan.runId) ? "__tail" : null);
      if (!anchor) continue;
      anchors.set(anchor, [...(anchors.get(anchor) ?? []), plan]);
    }
    return anchors;
  }, [plans, messageById, messages, activeRunIds, anchorOf]);
  const stepsByAnchor = useMemo(() => {
    const anchors = new Map<string, Map<string, NonNullable<ThreadSnapshot["steps"]>>>();
    for (const step of steps ?? []) {
      const source =
        step.sourceMessageId && messageById.has(step.sourceMessageId) ? step.sourceMessageId : null;
      const lastBotMessage = [...messages]
        .reverse()
        .find((message) => message.runId === step.runId && message.role === "bot");
      const anchor = anchorOf(
        step.runId,
        source ?? lastBotMessage?.id ?? (activeRunIds.includes(step.runId) ? "__tail" : null),
      );
      if (!anchor) continue;
      const runs = anchors.get(anchor) ?? new Map<string, NonNullable<ThreadSnapshot["steps"]>>();
      runs.set(step.runId, [...(runs.get(step.runId) ?? []), step]);
      anchors.set(anchor, runs);
    }
    return anchors;
  }, [steps, messageById, messages, activeRunIds, anchorOf]);
  const todosByAnchor = useMemo(() => {
    const anchors = new Map<string, Map<string, NonNullable<ThreadSnapshot["todos"]>>>();
    for (const todo of unlinkedRunTodos(todos ?? [], steps ?? [])) {
      const source =
        todo.sourceMessageId && messageById.has(todo.sourceMessageId) ? todo.sourceMessageId : null;
      const lastBotMessage = [...messages]
        .reverse()
        .find((message) => message.runId === todo.runId && message.role === "bot");
      const anchor = anchorOf(
        todo.runId,
        source ?? lastBotMessage?.id ?? (activeRunIds.includes(todo.runId) ? "__tail" : null),
      );
      if (!anchor) continue;
      const runs = anchors.get(anchor) ?? new Map<string, NonNullable<ThreadSnapshot["todos"]>>();
      runs.set(todo.runId, [...(runs.get(todo.runId) ?? []), todo]);
      anchors.set(anchor, runs);
    }
    return anchors;
  }, [todos, steps, messageById, messages, activeRunIds, anchorOf]);
  const executionsByAnchor = useMemo(() => {
    type Execution = {
      runId: string;
      plan?: NonNullable<ThreadSnapshot["plans"]>[number];
      steps?: NonNullable<ThreadSnapshot["steps"]>;
      todos?: NonNullable<ThreadSnapshot["todos"]>;
      activity: ActivityItem[];
    };
    const anchors = new Map<string, Map<string, Execution>>();
    const get = (anchor: string, runId: string): Execution => {
      const atAnchor = anchors.get(anchor) ?? new Map<string, Execution>();
      anchors.set(anchor, atAnchor);
      const entry = atAnchor.get(runId) ?? { runId, activity: [] };
      atAnchor.set(runId, entry);
      return entry;
    };
    const runAnchor = new Map<string, string>();
    for (const [anchor, entries] of plansByAnchor) {
      for (const plan of entries) {
        get(anchor, plan.runId).plan = plan;
        runAnchor.set(plan.runId, anchor);
      }
    }
    for (const [anchor, entries] of stepsByAnchor) {
      for (const [runId, runSteps] of entries) {
        get(runAnchor.get(runId) ?? anchor, runId).steps = runSteps;
        runAnchor.set(runId, runAnchor.get(runId) ?? anchor);
      }
    }
    for (const [anchor, entries] of todosByAnchor) {
      for (const [runId, runTodos] of entries) {
        get(runAnchor.get(runId) ?? anchor, runId).todos = runTodos;
        runAnchor.set(runId, runAnchor.get(runId) ?? anchor);
      }
    }
    for (const item of activity ?? []) {
      if (!item.runId || item.kind === "background") continue;
      const anchor =
        runAnchor.get(item.runId) ??
        anchorOf(
          item.runId,
          [...messages]
            .reverse()
            .find((message) => message.runId === item.runId && message.role === "bot")?.id ??
            (activeRunIds.includes(item.runId) ? "__tail" : null),
        );
      if (!anchor) continue;
      get(anchor, item.runId).activity.push(item);
      runAnchor.set(item.runId, anchor);
    }
    // Server summaries define their shells first (HISTORY-001): every Run in
    // the window — including a restored terminal Run whose structured arrays
    // are not in the legacy thread-level lists — gets exactly one anchored
    // shell, placed at the server-chosen anchor message.
    if (serverSummaries) {
      for (const summary of serverSummaries.values()) {
        if (runAnchor.has(summary.runId)) continue;
        const lastBot = [...messages]
          .reverse()
          .find((message) => message.runId === summary.runId && message.role === "bot");
        let anchor = anchorOf(
          summary.runId,
          lastBot?.id ?? (isRunActive(summary.status) ? "__tail" : null),
        );
        // A Run that never committed a Bot message (e.g. failed before its
        // first token) has no anchor to wait for — its summary alone earns a
        // tail shell so its card is never invisible. A server anchor that is
        // merely paged out keeps waiting for its page instead of jumping to
        // the tail.
        if (!anchor && !summary.anchorMessageId) anchor = "__tail";
        if (!anchor) continue;
        get(anchor, summary.runId);
        runAnchor.set(summary.runId, anchor);
      }
    }
    // Every Intervention — pending or restored terminal — owns a shell so its
    // card keeps its Execution Shell anchor after a refresh, even when the Run
    // is no longer active. Runs before the active-run loop so the ask message
    // wins over "__tail" and the card does not jump when the Run resumes.
    for (const view of shownInterventions ?? []) {
      if (runAnchor.has(view.runId)) continue;
      const lastBot = [...messages]
        .reverse()
        .find((message) => message.runId === view.runId && message.role === "bot");
      const anchor = anchorOf(
        view.runId,
        messageById.has(view.messageId) ? view.messageId : (lastBot?.id ?? "__tail"),
      );
      if (!anchor) continue;
      get(anchor, view.runId);
      runAnchor.set(view.runId, anchor);
    }
    // CARD-01B message-backed approvals (app authorization, MCP assignment,
    // skill drafts) have no legacy Intervention row but still own the same
    // anchored shell and headline as a durable view.
    for (const view of cardsUnifiedV2 ? (interactions ?? []) : []) {
      const runId = view.source.runId;
      if (!runId || runAnchor.has(runId)) continue;
      const lastBot = [...messages]
        .reverse()
        .find((message) => message.runId === runId && message.role === "bot");
      const sourceMessageId = view.source.messageId;
      const anchor = anchorOf(
        runId,
        sourceMessageId && messageById.has(sourceMessageId)
          ? sourceMessageId
          : (lastBot?.id ?? "__tail"),
      );
      if (!anchor) continue;
      get(anchor, runId);
      runAnchor.set(runId, anchor);
    }
    for (const run of runs) {
      if (isRunActive(run.status) && !runAnchor.has(run.id)) {
        const waiting = run.status === "waiting_input" || run.status === "waiting_takeover";
        const interventionMessage = waiting
          ? [...messages]
              .reverse()
              .find((message) => message.runId === run.id && message.role === "bot")
          : null;
        get(anchorOf(run.id, interventionMessage?.id ?? "__tail") ?? "__tail", run.id);
      }
    }
    // The last bot message is usually the final answer. Keep the execution
    // immediately before it when no source message anchored the Run earlier.
    const positioned = new Map<string, Map<string, Execution>>();
    for (const [anchor, entries] of anchors) {
      for (const [runId, entry] of entries) {
        const message = messageById.get(anchor);
        const run = runs.find((candidate) => candidate.id === runId);
        const beforeAnswer =
          message?.role === "bot" &&
          run &&
          (!isRunActive(run.status) ||
            run.status === "waiting_input" ||
            run.status === "waiting_takeover");
        const key = beforeAnswer ? `before:${anchor}` : anchor;
        const target = positioned.get(key) ?? new Map<string, Execution>();
        target.set(runId, entry);
        positioned.set(key, target);
      }
    }
    return positioned;
  }, [
    plansByAnchor,
    stepsByAnchor,
    todosByAnchor,
    activity,
    messages,
    messageById,
    activeRunIds,
    runs,
    shownInterventions,
    cardsUnifiedV2,
    interactions,
    anchorOf,
    serverSummaries,
  ]);
  const loadExecutionDetail = useCallback(
    (runId: string, rev: number) => {
      // UX-01C acceptance 14: one concurrent request per Run AND revision —
      // a repeat click while the same-rev fetch is in flight is a no-op, but
      // a newer revision is never blocked behind a stale in-flight request.
      const flightKey = `${runId}@${rev}`;
      if (detailInFlight.current.has(flightKey)) return;
      detailInFlight.current.add(flightKey);
      setDetailRequests((current) => beginDetailRequest(current, runId, rev));
      void rpc.runs
        .executionSnapshot({ ...artifactTarget, runId })
        .then((snapshot) => {
          // One guarded unit: when this response is older (or a duplicate)
          // relative to the cached rev it is dropped whole — detail, cursor
          // and loaded older pages all stay as the newer version left them.
          // A newer rev installs the snapshot together with its own first
          // page cursor and clears the pages loaded against the old version.
          setExecutionDetails((current) => installExecutionDetail(current, runId, snapshot));
          // Success clears any previous error OF THE SAME REVISION: a stale
          // success never deletes a newer request's loading/error state
          // (review round 2), and request state never mixes with the
          // rev-versioned cache it describes.
          setDetailRequests((current) => settleDetailRequest(current, runId, rev));
          // Review round (B): the open-triggered load must not self-close the
          // card — an actively eventing Run's detail arrives at a fresher
          // rev of the SAME projection the user just opened, so the stored
          // expansion decision is re-keyed to it (never downgraded, no-op
          // without a stored decision).
          setExpansionEntries((entries) =>
            rekeyExpansionRev({ entries, threadId, runId, rev: snapshot.summary.rev }),
          );
        })
        .catch(() => {
          // The failure becomes a stable safe retry state in the open card —
          // never a raw transport message, never a cleared level-0 fact.
          // Review round P3: stamped with the requested rev — a late failure
          // from a superseded request can never rewrite newer state, and the
          // error stops surfacing as soon as the projection moves on.
          setDetailRequests((current) => failDetailRequest(current, runId, rev));
        })
        .finally(() => {
          detailInFlight.current.delete(flightKey);
        });
    },
    [artifactTarget, threadId],
  );
  const retryRun = useCallback(
    (runId: string) => {
      if (retryingRunId) return;
      const nonce = retryNonceByRun.current.get(runId) ?? newClientId();
      retryNonceByRun.current.set(runId, nonce);
      setRetryingRunId(runId);
      setRetryError(null);
      void rpc.runs
        .retry({ runId, clientNonce: nonce })
        .then(async (result) => {
          retryNonceByRun.current.delete(runId);
          setRetriedSuccessors((current) => new Map(current).set(runId, result.runId));
          setExecutionNavIntent({
            threadId: result.threadId,
            runId: result.runId,
            rev: 0,
            attention: false,
          });
          await onRefresh();
        })
        .catch((error: unknown) => {
          setRetryError({ runId, message: manualRetryErrorMessage(error) });
        })
        .finally(() => {
          setRetryingRunId((current) => (current === runId ? null : current));
        });
    },
    [onRefresh, retryingRunId],
  );
  const viewSuccessor = useCallback(
    (runId: string) => {
      const summary = serverSummaries?.get(runId);
      const successorId = summary?.retrySuccessorRunId;
      if (!successorId) return;
      const successor = serverSummaries?.get(successorId);
      setExpansionEntries((entries) =>
        forceOpenExpansion({
          entries,
          threadId,
          runId: successorId,
          rev: successor?.rev ?? summary?.rev ?? 0,
        }),
      );
      if (successor) loadExecutionDetail(successorId, successor.rev);
    },
    [loadExecutionDetail, serverSummaries, threadId],
  );
  // Execution-nav "return to conversation": a module-memory intent (never the
  // DOM, never browser storage) asks this Thread to open one Run's card and
  // focus it — the Intervention control for waiting states (mirroring the
  // card's attention action), the status line otherwise. It applies once the
  // Run's server summary is present (thread window or the merged anchor page).
  const [navFocus, setNavFocus] = useState<{
    attention: boolean;
    nonce: number;
  } | null>(null);
  // A sidebar click on the ALREADY-open conversation sets an intent without
  // any thread/summary change; the ping event makes this consumer re-check
  // (UX-01B acceptance 12 — same return-intent mechanism, no new storage).
  const [intentPing, setIntentPing] = useState(0);
  useEffect(() => {
    const handler = () => setIntentPing((value) => value + 1);
    window.addEventListener(EXECUTION_NAV_INTENT_EVENT, handler);
    return () => window.removeEventListener(EXECUTION_NAV_INTENT_EVENT, handler);
  }, []);
  useEffect(() => {
    const intent = peekExecutionNavIntent();
    if (!intent || intent.threadId !== threadId) return;
    const summary = serverSummaries?.get(intent.runId);
    if (!summary) return;
    clearExecutionNavIntent();
    setExpansionEntries((entries) =>
      forceOpenExpansion({ entries, threadId, runId: intent.runId, rev: summary.rev }),
    );
    loadExecutionDetail(intent.runId, summary.rev);
    setNavFocus({ attention: intent.attention, nonce: summary.rev });
  }, [threadId, serverSummaries, loadExecutionDetail, intentPing]);
  useEffect(() => {
    if (!navFocus) return;
    // The card can lag the intent by a page commit (the anchor jump still in
    // flight), so retry briefly until the open card exists — then focus once.
    // Single-open contract: at most one card carries data-open="1".
    const startedAt = Date.now();
    let timer = 0;
    const attempt = () => {
      const card = document.querySelector('article[data-testid="execution-card"][data-open="1"]');
      const section = card?.closest('section[data-testid="execution-shell"]');
      if (section) {
        if (navFocus.attention) {
          const control = section
            .querySelector('[data-testid="execution-interventions"]')
            ?.querySelector<HTMLElement>(FOCUSABLE_CONTROL);
          if (control) {
            control.focus();
            return;
          }
        } else {
          section.querySelector<HTMLElement>(".exc-status")?.focus({ preventScroll: true });
          return;
        }
      }
      if (Date.now() - startedAt < 5_000) timer = window.setTimeout(attempt, 120);
    };
    timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  }, [navFocus]);
  const renderExecutions = (anchor: string) =>
    [...(executionsByAnchor.get(anchor)?.values() ?? [])].map((execution) => {
      // UX-01B core rule 1: no Plan, no semantic Step, no pending
      // Intervention and no failure → no execution shell at all.
      if (!eligibleRunIds.has(execution.runId)) return null;
      const run = runs.find((candidate) => candidate.id === execution.runId) ?? null;
      const summary = serverSummaries?.get(execution.runId) ?? null;
      // A fresh detail may outrun the thread-level summary after an Activity
      // event. Only a detail OLDER than that summary is discarded.
      const detailEntry = selectCachedDetailEntry(
        executionDetails,
        execution.runId,
        summary ? summary.rev : null,
      );
      const detail = detailEntry?.snapshot;
      const currentSummary = detail?.summary ?? summary;
      const displayRun = executionRunState({ run, summary, detail });
      const isFailed = displayRun?.status === "failed";
      const data = executionDataForRun({
        runId: execution.runId,
        detail,
        legacy: {
          plans: execution.plan ? [execution.plan] : undefined,
          steps: execution.steps,
          todos: execution.todos,
          activity: execution.activity,
        },
      });
      const hasFailedStep = data.steps.some((step) => step.status === "failed");
      // Acceptance 8, second path: a failed Run without a failed semantic
      // Step shows the SAFE Run-level failure projection (never a raw error).
      const failureText =
        isFailed && !hasFailedStep ? currentSummary?.failure?.trim() || null : null;
      // The transcript bubble is the canonical result surface. The detail's
      // Result section only renders while that message is NOT loaded (paged
      // out), so the same text never appears twice next to each other; the
      // card's outcome excerpt covers the collapsed/restored presentation.
      const detachedResult =
        data.result && !messageById.has(data.result.messageId) ? data.result : null;
      // Older pages prepend under the current first page; the merge dedupes
      // by id and the newer status wins (boundary called/completed pairs).
      const runActivityItems = mergeActivityPages(data.activity, detailEntry?.olderActivity ?? []);
      const runInterventions = mergeInterventionViews(shownInterventions ?? [], [
        ...settledInterventions,
        ...(detail ? detail.interventions : []),
      ]);
      const scopedInterventions = (runInterventions ?? []).filter(
        (view) => view.runId === execution.runId,
      );
      const scopedInteractions = cardsUnifiedV2
        ? mergeInteractionViews(interactions, detail?.interactions)?.filter(
            (view) => view.source.runId === execution.runId,
          )
        : undefined;
      const controlled = currentSummary !== null;
      const rev = currentSummary?.rev ?? 0;
      // UX-01B acceptance 4: no auto-expansion — every detail starts
      // collapsed and opens only on an explicit user action or return intent.
      const plannedOpen = expansionPlan?.get(execution.runId);
      const isOpen = controlled
        ? (plannedOpen ??
          isExpansionOpen({
            entries: expansionEntries,
            threadId,
            runId: execution.runId,
            rev,
            defaultOpen: false,
          }))
        : false;
      const expansion = controlled
        ? {
            open: isOpen,
            toggle: () => {
              setExpansionEntries(
                toggleExpansion({
                  entries: expansionEntries,
                  threadId,
                  runId: execution.runId,
                  rev,
                  currentlyOpen: isOpen,
                }),
              );
              // The thread summary need not move when only Activity changes.
              // Reopening must read the authoritative detail even when the
              // cached detail supplied the current displayed rev.
              if (!isOpen) {
                loadExecutionDetail(execution.runId, rev);
              }
            },
          }
        : undefined;
      const activityCursor = detailEntry?.olderCursor ?? null;
      const loadMoreActivity = () => {
        if (!activityCursor || !detailEntry || activityLoading.current[execution.runId]) return;
        const requestRev = detailEntry.rev;
        activityLoading.current[execution.runId] = true;
        void rpc.runs
          .executionActivityPage({
            ...artifactTarget,
            runId: execution.runId,
            cursor: activityCursor,
          })
          .then((page) => {
            // The page belongs to the detail version it was requested
            // against; if the entry moved on (or was dropped) in flight, the
            // guarded append discards it instead of mixing versions.
            setExecutionDetails((current) =>
              appendExecutionActivityPage(current, execution.runId, requestRev, page),
            );
          })
          .catch(() => undefined)
          .finally(() => {
            activityLoading.current[execution.runId] = false;
          });
      };
      return (
        <ExecutionShell
          key={execution.runId}
          run={displayRun}
          activity={runActivityItems}
          pendingInterventionKinds={
            cardsUnifiedV2 && interactions
              ? pendingInteractionKindsForRun(interactions, execution.runId)
              : pendingInterventionKindsForRun(interventions, execution.runId)
          }
          expansion={expansion}
          canExpand={currentSummary !== null}
          summary={currentSummary}
          pendingInterventionViews={scopedInterventions.filter((view) => view.status === "pending")}
          pendingInteractionViews={
            cardsUnifiedV2
              ? scopedInteractions?.filter((view) => view.status === "pending")
              : undefined
          }
          plan={data.plan ?? null}
          steps={data.steps}
          hasResult={resultHasText(detachedResult)}
          resultOnPage={
            data.result
              ? messageById.has(data.result.messageId)
              : messages.some(
                  (message) => message.runId === execution.runId && message.role === "bot",
                )
          }
          retrying={retryingRunId === execution.runId}
          retryError={retryError?.runId === execution.runId ? retryError.message : null}
          onRetry={() => retryRun(execution.runId)}
          onViewSuccessor={() => viewSuccessor(execution.runId)}
          interventions={
            scopedInterventions.length > 0 || (scopedInteractions?.length ?? 0) > 0 ? (
              <InterventionRegion
                interventions={scopedInterventions}
                interactions={scopedInteractions}
                cardsUnifiedV2={cardsUnifiedV2}
                messages={messages}
                target={artifactTarget}
                botNameOf={botNameOf}
                conversationName={conversationName}
                groupNameOf={groupNameOf}
                onOpenComputer={onOpenComputer}
                onSettled={(view) =>
                  setSettledInterventions((current) => [
                    ...current.filter((item) => item.id !== view.id),
                    view,
                  ])
                }
                onRefresh={onRefresh}
              />
            ) : null
          }
        >
          {data.plan ? (
            <RunPlanDisclosure
              plan={data.plan}
              steps={data.steps}
              failed={isFailed}
              review={data.planReview}
            />
          ) : data.steps.length > 0 ? (
            <RunStepsDisclosure steps={data.steps} failed={isFailed} />
          ) : isOpen && data.todos.length > 0 ? (
            // UX-01C acceptance 16, fixed degradation order Plan → Steps →
            // 事项清单: legacy Todos surface only inside an already-legal,
            // EXPANDED detail with neither Plan nor Steps — collapsed, they
            // are not in the DOM at all, and they never trigger the surface.
            <RunTodoList todos={data.todos} />
          ) : null}
          {detailRequestStatus(detailRequests, execution.runId, rev) === "error" && !detail ? (
            // UX-01C acceptance 14: a failed detail load is honest and
            // retryable — stable safe copy (never the raw transport error),
            // and the level-0 card above keeps every fact it already had.
            <div
              data-testid="execution-detail-error"
              className="ms-1 my-2 border-s border-destructive ps-4 text-[13px] text-muted-foreground"
            >
              <p dir="auto">{t`Couldn't load the execution detail.`}</p>
              <button
                type="button"
                data-testid="execution-detail-retry"
                onClick={() => loadExecutionDetail(execution.runId, rev)}
                className="mt-1 min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {t`Retry`}
              </button>
            </div>
          ) : null}
          {failureText ? (
            <p
              data-testid="execution-failure-reason"
              data-failure-target=""
              tabIndex={-1}
              dir="auto"
              className="ms-1 my-2 border-s border-destructive ps-4 text-[13px] text-destructive focus:outline-none"
            >
              {failureText}
            </p>
          ) : null}
          {runActivityItems.length > 0 || displayRun?.status === "running" ? (
            <ExecutionActivity
              run={displayRun}
              items={runActivityItems}
              showAvatars={showActivityAvatars}
              botColors={activityBotColors}
            />
          ) : null}
          {activityCursor ? (
            <button
              type="button"
              data-testid="execution-activity-more"
              onClick={loadMoreActivity}
              className="mt-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {t`Load earlier activity`}
            </button>
          ) : null}
          {detachedResult ? (
            <>
              <RunResult result={detachedResult} />
              {detail?.displayBlocks?.length ? (
                <div className="ms-1 my-2">
                  {/* Markdown mirrors the text RunResult already shows; only
                      non-text projections add information here. */}
                  <DisplayBlockList
                    blocks={detail.displayBlocks.filter((block) => block.kind !== "markdown")}
                    target={artifactTarget}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </ExecutionShell>
      );
    });
  // Views without a Run (for example an onboarding question or a taught-skill
  // draft message) have no Execution shell to own them. Keep pending requests
  // and any terminal message-backed card at the tail: gate-on suppresses the
  // legacy block, so dropping the settled card would erase its history. A
  // terminal ask whose bubble already carries the settled state stays there.
  const standaloneInteractions =
    cardsUnifiedV2 && interactions
      ? interactions.filter(
          (view) =>
            view.source.runId === null &&
            (view.source.messageId === null || coveredAsks.has(view.source.messageId)),
        )
      : [];
  const standaloneRegion =
    standaloneInteractions.length > 0 ? (
      <InteractionRegion
        interactions={standaloneInteractions}
        target={artifactTarget}
        botNameOf={botNameOf}
        conversationName={conversationName}
        groupNameOf={groupNameOf}
        onOpenComputer={onOpenComputer}
        onRefresh={onRefresh}
      />
    ) : null;
  return {
    coveredAsks,
    renderExecutions,
    standaloneRegion,
    messageRetry: {
      entries: messageRetryEntries,
      retryRun,
      retryingRunId,
      retryError,
    },
  };
}
