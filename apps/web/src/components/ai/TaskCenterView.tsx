import { Trans, useLingui } from "@lingui/react/macro";
import type { TaskCenterItem } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildExecutionCardModel } from "../../lib/execution-card";
import { deriveExecutionStatus } from "../../lib/execution-status";
import { rpc } from "../../lib/rpc";
import {
  applyTaskCenterAppend,
  applyTaskCenterRefresh,
  emptyTaskCenterList,
  setTaskCenterNavIntent,
  TASK_CENTER_PAGE_LIMIT,
  type TaskCenterListState,
  taskCenterVerb,
} from "../../lib/task-center";
import { ExecutionCard } from "./ExecutionCard";
import "./task-center.css";

const noop = () => undefined;

/** Errors that mean "this Run is no longer reachable" (never rendered raw). */
const UNAVAILABLE_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"]);
const UNAVAILABLE_HTTP = new Set([400, 403, 404]);

function isUnavailableError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && UNAVAILABLE_HTTP.has(status);
}

/**
 * One compact Task Center card. The status sentence, glyph, rail, safe texts
 * and state colors all come from the SHARED Execution Card stack
 * (`deriveExecutionStatus` + `buildExecutionCardModel` + ExecutionCard) — the
 * only Task Center-specific piece is the primary-action verb, and every verb
 * returns to the original conversation. The list never loads a full Execution
 * Shell and never renders a percentage.
 */
function TaskCenterCard({
  item,
  unavailable,
  busy,
  onOpen,
}: {
  item: TaskCenterItem;
  unavailable: boolean;
  busy: boolean;
  onOpen: (item: TaskCenterItem) => void;
}) {
  const status = deriveExecutionStatus(
    {
      id: item.summary.runId,
      status: item.summary.status,
      waitKind: item.summary.waitKind ?? null,
    },
    [],
  );
  const card = buildExecutionCardModel({
    status,
    summary: item.summary,
    expanded: false,
    canExpand: false,
    actionOverride: unavailable || busy ? null : { verb: taskCenterVerb(status), act: "navigate" },
  });
  return (
    <div data-testid="task-center-item" data-status={status.status}>
      <ExecutionCard
        card={card}
        open={false}
        hasDetail={false}
        detailsId=""
        onToggle={noop}
        onAttention={noop}
        onNavigate={() => onOpen(item)}
      >
        {null}
      </ExecutionCard>
      {unavailable ? (
        <p className="tc-unavailable" role="status">
          <Trans>This task is no longer available.</Trans>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Task Center main view: a restrained single-column list over the
 * server's authorized root-Run window. Refreshes on entry, window focus and
 * visibility changes (the project's existing lightweight pattern — no new
 * WebSocket, message bus or global store); pagination appends via the opaque
 * server cursor with runId dedupe and higher-rev-wins merging.
 */
export function TaskCenterView({
  mobileSidebarOpen,
  onBeforeNavigate,
}: {
  mobileSidebarOpen?: boolean;
  /** Lets the Shell close the mobile sidebar before a conversation jump. */
  onBeforeNavigate?: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [list, setList] = useState<TaskCenterListState>(emptyTaskCenterList);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set());
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(() => {
    const requestId = ++requestSeq.current;
    void rpc.runs
      .taskCenter({ limit: TASK_CENTER_PAGE_LIMIT })
      .then((page) => {
        setList((current) => applyTaskCenterRefresh(current, page, requestId));
        setListError(false);
        setInitialLoading(false);
        // `unavailable` marks are deliberately NOT reset here: a Run that
        // just failed its authority check stays honestly marked until the
        // authoritative window drops it (or this view remounts).
      })
      .catch(() => {
        // Only the newest request may surface an error; a stale failure must
        // not overwrite a list a newer response already restored.
        if (requestSeq.current !== requestId) return;
        setListError(true);
        setInitialLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const listRef = useRef(list);
  listRef.current = list;
  const loadingMoreRef = useRef(false);

  const loadMore = useCallback(() => {
    const cursor = listRef.current.nextCursor;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const requestId = ++requestSeq.current;
    const requestEpoch = listRef.current.epoch;
    void rpc.runs
      .taskCenter({ cursor, limit: TASK_CENTER_PAGE_LIMIT })
      .then((page) => {
        setList((current) => applyTaskCenterAppend(current, page, requestId, requestEpoch));
      })
      .catch(() => undefined)
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  const openItem = useCallback(
    (item: TaskCenterItem) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyRunId(item.summary.runId);
      setOpenError(false);
      const { summary, target } = item;
      const targetInput =
        target.kind === "bot" ? { botId: target.botId } : { groupId: target.groupId };
      // Authority check before navigating: a Run cleared, archived or lost to
      // authorization since the list loaded must show stable feedback HERE —
      // never jump to a wrong or broken conversation, never show raw ids or
      // internal error text.
      void rpc.runs
        .executionSnapshot({ ...targetInput, runId: summary.runId })
        .then(() => {
          const status = deriveExecutionStatus(
            {
              id: summary.runId,
              status: summary.status,
              waitKind: summary.waitKind ?? null,
            },
            [],
          );
          // In-memory handoff only (never storage, never a URL param): the
          // chat Transcript opens this Run's card and focuses it — the
          // Intervention control for waiting states, the status line
          // otherwise. The anchor rides the existing ?m= deep link.
          setTaskCenterNavIntent({
            threadId: summary.threadId,
            runId: summary.runId,
            rev: summary.rev,
            attention: status.needsAttention,
          });
          const route = target.kind === "bot" ? `/app/${target.botId}` : `/app/g/${target.groupId}`;
          busyRef.current = false;
          setBusyRunId(null);
          onBeforeNavigate?.();
          navigate(summary.anchorMessageId ? `${route}?m=${summary.anchorMessageId}` : route);
        })
        .catch((error: unknown) => {
          busyRef.current = false;
          setBusyRunId(null);
          if (isUnavailableError(error)) {
            setUnavailable((current) => new Set(current).add(summary.runId));
            // The authoritative list drops it on the next read.
            refresh();
          } else {
            setOpenError(true);
          }
        });
    },
    [navigate, onBeforeNavigate, refresh],
  );

  const subtitle =
    list.activeCount > 0
      ? t`${list.activeCount} running in background`
      : t`No tasks running in background`;

  return (
    <main
      className="tc-main"
      data-testid="task-center"
      aria-hidden={mobileSidebarOpen || undefined}
      inert={mobileSidebarOpen}
    >
      <header className="tc-head">
        <h1>
          <Trans>Background tasks</Trans>
        </h1>
        <span className="tc-sub" data-testid="task-center-subtitle">
          {subtitle}
        </span>
      </header>
      <section className="tc-section" aria-label={t`Background tasks`}>
        {initialLoading ? (
          <div className="tc-state">
            <span role="status">{t`Loading…`}</span>
          </div>
        ) : listError && list.items.length === 0 ? (
          <div className="tc-state">
            <span role="alert">
              <Trans>Couldn&apos;t load background tasks.</Trans>
            </span>
            <button type="button" className="tc-more" onClick={refresh}>
              <Trans>Retry now</Trans>
            </button>
          </div>
        ) : list.items.length === 0 ? (
          <p className="tc-empty" data-testid="task-center-empty">
            <Trans>
              Nothing is running in the background. When you leave a chat, work that needs to
              continue keeps running here.
            </Trans>
          </p>
        ) : (
          <ul className="tc-list" data-testid="task-center-list">
            {list.items.map((item) => (
              <li key={item.summary.runId}>
                <TaskCenterCard
                  item={item}
                  unavailable={unavailable.has(item.summary.runId)}
                  busy={busyRunId === item.summary.runId}
                  onOpen={openItem}
                />
              </li>
            ))}
          </ul>
        )}
        {openError ? (
          <p className="tc-notice" role="alert">
            <Trans>Couldn&apos;t open this task. Try again.</Trans>
          </p>
        ) : null}
        {list.nextCursor && !initialLoading ? (
          <button
            type="button"
            className="tc-more"
            data-testid="task-center-more"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? t`Loading…` : t`Load more tasks`}
          </button>
        ) : null}
      </section>
    </main>
  );
}
