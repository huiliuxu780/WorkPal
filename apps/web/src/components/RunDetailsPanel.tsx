import { t } from "@lingui/core/macro";
import type { Artifact, MessageBlock, RunsDetailOutput, ThreadSnapshot } from "@rakazo/contracts";
import { toolActionLabel } from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { Bell, BellOff, ChevronRight, FileText, Monitor, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../lib/relative-time";
import { effectView } from "../lib/effect-view";
import { rpc } from "../lib/rpc";
import {
  isRunActive,
  type RunStatusLike,
  runStatusLabel,
  runStatusPillClass,
  runStatusTextClass,
} from "../lib/run-status";
import { formatToolActivityDuration } from "../lib/tool-activity-view";
import { formatElapsed } from "./ai/primitives";

type RunDetailsPanelProps = {
  runId: string;
  snapshot?: ThreadSnapshot | null;
  onClose: () => void;
  onOpenComputer?: () => void;
};

const EFFECT_TONE_CLASS = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

function attemptLabel(status: string): string {
  const known = [
    "queued",
    "leased",
    "running",
    "waiting_input",
    "waiting_takeover",
    "completed",
    "failed",
    "cancelled",
  ] as const;
  return known.includes(status as (typeof known)[number])
    ? runStatusLabel(status as RunStatusLike)
    : status;
}

function attemptToneClass(status: string): string {
  const known = [
    "queued",
    "leased",
    "running",
    "waiting_input",
    "waiting_takeover",
    "completed",
    "failed",
    "cancelled",
  ] as const;
  return known.includes(status as (typeof known)[number])
    ? runStatusTextClass(status as RunStatusLike)
    : "text-muted-foreground";
}

function triggerLabel(trigger: RunsDetailOutput["run"]["trigger"]): string {
  if (trigger === "user" || trigger === "resume" || trigger === "follow_up") {
    return t`Triggered by you`;
  }
  if (trigger === "routine") return t`Routine`;
  return trigger.replaceAll("_", " ");
}

/** Live tool/subagent blocks belonging to the current run window. */
function liveBlocks(snapshot: ThreadSnapshot | null | undefined, startedAt: string | null) {
  const messages = snapshot?.messages ?? [];
  const startMs = startedAt ? Date.parse(startedAt) : Number.NEGATIVE_INFINITY;
  const blocks: MessageBlock[] = [];
  for (const message of messages) {
    const createdMs = Date.parse(message.createdAt);
    if (Number.isFinite(createdMs) && createdMs < startMs) continue;
    for (const block of message.blocks) {
      if (block.kind === "steps" || block.kind === "subagent") blocks.push(block);
    }
  }
  return blocks;
}

export function RunDetailsPanel({
  runId,
  snapshot,
  onClose,
  onOpenComputer,
}: RunDetailsPanelProps) {
  const [detail, setDetail] = useState<RunsDetailOutput | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const liveStatus = useMemo(() => {
    const runs = snapshot?.activeRuns ?? [];
    return (
      runs.find((run) => run.id === runId)?.status ??
      (snapshot?.run?.id === runId ? snapshot.run.status : null)
    );
  }, [snapshot, runId]);

  useEffect(() => {
    let cancelled = false;
    void rpc.runs
      .detail({ runId })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, liveStatus]);

  const botId = detail?.run.botId ?? null;
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void rpc.artifacts
      .list({ botId })
      .then((list) => {
        if (!cancelled) setArtifacts(list.filter((artifact) => artifact.runId === runId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, runId]);

  const run = detail?.run ?? null;
  const active = run ? isRunActive(run.status) : false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsed = useMemo(() => {
    if (!run?.startedAt) return null;
    const startMs = Date.parse(run.startedAt);
    const endMs = run.completedAt ? Date.parse(run.completedAt) : now;
    return formatElapsed(startMs, endMs);
  }, [run, now]);

  const blocks = useMemo(() => liveBlocks(snapshot, run?.startedAt ?? null), [snapshot, run]);
  const pendingAsk = useMemo(() => {
    const messages = snapshot?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      for (const block of message.blocks) {
        if (block.kind === "ask" && block.status !== "answered" && block.status !== "expired")
          return block;
      }
    }
    return null;
  }, [snapshot]);

  const attempts = detail?.attempts ?? [];
  const effects = detail?.effects ?? [];
  const history = detail?.history ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">{t`Run details`}</span>
        <div className="flex gap-1">
          {run ? (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled
              title={t`Follows bot notification settings`}
              aria-label={run.notificationsEnabled ? t`Notifications on` : t`Notifications off`}
              className="text-muted-foreground"
            >
              {run.notificationsEnabled ? (
                <Bell size={16} strokeWidth={1.7} />
              ) : (
                <BellOff size={16} strokeWidth={1.7} />
              )}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Close panel`}
            onClick={onClose}
            className="text-muted-foreground"
          >
            <X size={16} strokeWidth={1.8} />
          </Button>
        </div>
      </div>

      {run ? (
        <>
          {/* Status summary */}
          <div className="flex items-center gap-2">
            <BotAvatar color={run.botColor} identity={run.botId} size={22} />
            <span
              className="truncate text-[13px] font-semibold tracking-tight"
              style={{ color: run.botColor }}
            >
              {run.botName}
            </span>
            <span className="ms-auto shrink-0 text-[12px] text-muted-foreground">
              {triggerLabel(run.trigger)}
            </span>
          </div>
          <p
            className="mt-2 text-[15.5px] font-medium leading-[1.5] text-foreground"
            dir="auto"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {run.promptSnippet}
          </p>
          <div className="mt-3 flex min-h-[26px] items-center gap-2.5">
            <span
              className={`inline-flex items-center gap-[7px] rounded-full px-[11px] py-1 text-[13px] font-medium ${runStatusPillClass(run.status)}`}
            >
              <span
                className="size-2 rounded-full bg-current"
                style={active ? { animation: "rkPulse 1.2s ease-in-out infinite" } : undefined}
              />
              {runStatusLabel(run.status)}
            </span>
            {elapsed ? (
              <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                {elapsed}
              </span>
            ) : null}
            {attempts.length > 1 ? (
              <span className="ms-auto shrink-0 text-[12px] text-muted-foreground">
                {t`${attempts.length} attempts`}
              </span>
            ) : null}
          </div>

          {/* Action card: waiting for the user */}
          {run.status === "waiting_input" && pendingAsk ? (
            <div className="mt-3.5 rounded-2xl border border-border bg-card px-5 py-4">
              <div className="flex items-center gap-2">
                <span
                  className="text-[13px] text-warning"
                  style={{ animation: "rkPulse 1.2s ease-in-out infinite" }}
                >
                  ◷
                </span>
                <span className="text-[13.5px] font-medium text-warning">{t`Needs input`}</span>
              </div>
              <p className="mt-2 text-[14.5px] leading-[1.5] text-foreground/90" dir="auto">
                {pendingAsk.text}
              </p>
              <div className="mt-3">
                <Button className="w-full justify-start" onClick={onClose}>
                  {t`Answer in thread`}
                </Button>
              </div>
            </div>
          ) : null}
          {run.status === "waiting_takeover" ? (
            <div className="mt-3.5 rounded-2xl border border-border bg-card px-5 py-4">
              <p className="text-[14.5px] leading-[1.5] text-foreground/90">
                {t`The bot is waiting for computer takeover.`}
              </p>
              <div className="mt-3">
                <Button
                  className="w-full justify-start"
                  onClick={() => {
                    onOpenComputer?.();
                  }}
                >
                  <Monitor size={15} strokeWidth={1.8} className="me-2" aria-hidden />
                  {t`Open computer`}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Timeline: attempts + live steps */}
          {attempts.length ? (
            <div className="mt-4 border-t border-border pt-3.5">
              {attempts.map((attempt, index) => {
                const isLast = index === attempts.length - 1;
                const duration =
                  attempt.finishedAt && attempt.startedAt
                    ? formatToolActivityDuration(
                        Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt),
                      )
                    : null;
                return (
                  <details key={attempt.fence} open={isLast}>
                    <summary className="flex min-h-[30px] cursor-pointer list-none items-center gap-2 rounded-lg px-0.5 py-[3px] hover:bg-accent">
                      <ChevronRight
                        size={13}
                        strokeWidth={1.9}
                        className="shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 [&_details[open]>_&]:rotate-90"
                        style={{}}
                      />
                      <span className="text-[12.5px] font-medium text-muted-foreground">
                        {t`Attempt ${attempt.fence}`}
                      </span>
                      <span className="ms-auto flex items-center gap-[7px] whitespace-nowrap">
                        <span className={`text-[12px] ${attemptToneClass(attempt.status)}`}>
                          {attemptLabel(attempt.status)}
                        </span>
                        {duration ? (
                          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                            {duration}
                          </span>
                        ) : null}
                      </span>
                    </summary>
                    <div className="ms-[7px] mt-0.5 border-s border-border ps-3">
                      {isLast && blocks.length
                        ? blocks.map((block, blockIndex) =>
                            block.kind === "steps" ? (
                              <div key={`steps-${blockIndex}`}>
                                {block.steps.map((step) => (
                                  <div
                                    key={step.label}
                                    className="flex min-h-6 min-w-0 items-center gap-2 leading-5"
                                  >
                                    <span className="w-[13px] shrink-0 text-center text-[12px] text-success">
                                      ✓
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                                      {step.label}
                                    </span>
                                    {step.count > 1 ? (
                                      <span className="shrink-0 text-[12px] text-muted-foreground">
                                        ×{step.count}
                                      </span>
                                    ) : null}
                                  </div>
                                ))}
                                {block.durationMs != null ? (
                                  <div className="flex min-h-6 items-center justify-end font-mono text-[12px] tabular-nums text-muted-foreground/75">
                                    {formatToolActivityDuration(block.durationMs)}
                                  </div>
                                ) : null}
                              </div>
                            ) : block.kind === "subagent" ? (
                              <div
                                key={`subagent-${block.agentId}`}
                                className="my-[5px] w-full rounded-[14px] border border-border bg-muted px-3.5 py-3"
                              >
                                <div className="flex items-center justify-between gap-2.5">
                                  <span className="truncate text-[14px] font-medium text-foreground">
                                    {block.name}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] ${
                                      block.status === "failed"
                                        ? "bg-destructive/15 text-destructive"
                                        : block.status === "running"
                                          ? "bg-warning/15 text-warning"
                                          : "bg-success/15 text-success"
                                    }`}
                                  >
                                    {block.status === "running" ? t`subagent` : block.status}
                                  </span>
                                </div>
                                <p
                                  className="mt-1.5 text-[13px] leading-[1.45] text-muted-foreground"
                                  dir="auto"
                                  style={{
                                    display: "-webkit-box",
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: "vertical",
                                    overflow: "hidden",
                                  }}
                                >
                                  {block.task}
                                </p>
                                {block.result ? (
                                  <p
                                    className="mt-2 text-[13.5px] leading-[1.5] text-foreground/75"
                                    dir="auto"
                                  >
                                    {block.result}
                                  </p>
                                ) : null}
                              </div>
                            ) : null,
                          )
                        : null}
                      {isLast && active && !blocks.length ? (
                        <div className="flex min-h-6 items-center gap-2 leading-5">
                          <span
                            className="w-[13px] shrink-0 text-center text-[12px] text-warning"
                            style={{ animation: "rkPulse 1.2s ease-in-out infinite" }}
                          >
                            ◷
                          </span>
                          <span className="text-[13px] text-foreground">{t`Working…`}</span>
                        </div>
                      ) : null}
                      {attempt.error ? (
                        <div className="flex min-h-6 items-baseline gap-2">
                          <span className="w-[13px] shrink-0 text-center text-[12px] text-destructive">
                            ✕
                          </span>
                          <span className="text-[13px] leading-5 text-foreground/85" dir="auto">
                            {attempt.error}
                          </span>
                        </div>
                      ) : null}
                      {!isLast && !attempt.error ? (
                        <p className="min-h-6 py-1 text-[12.5px] text-muted-foreground">
                          {t`Step details are in the thread transcript.`}
                        </p>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          ) : null}

          {/* Outputs */}
          {artifacts.length ? (
            <div className="mt-4 border-t border-border pt-3.5">
              <div className="mb-1.5 ps-[23px] text-[12.5px] font-medium text-muted-foreground/80">
                {t`Outputs · ${artifacts.length}`}
              </div>
              {artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex items-start gap-2.5 rounded-lg px-0.5 py-[7px]"
                >
                  <FileText
                    size={14}
                    strokeWidth={1.7}
                    className="mt-[3px] shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
                    {artifact.name}
                  </span>
                  <span className="shrink-0 pt-0.5 font-mono text-[12px] text-muted-foreground/80">
                    {formatRelativeTime(artifact.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {/* Effects ledger */}
          {effects.length ? (
            <div className="mt-4 border-t border-border pt-3.5">
              <div className="mb-1.5 ps-[23px] text-[12.5px] font-medium text-muted-foreground/80">
                {t`Effects · ${effects.length}`}
              </div>
              {effects.map((effect) => {
                const view = effectView(effect.status);
                return (
                  <div key={effect.effectId} className="rounded-[10px]">
                    <div className="flex items-start gap-[13px] rounded-[10px] px-0.5 py-2">
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${EFFECT_TONE_CLASS[view.tone]}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-foreground">
                          {toolActionLabel(effect.kind)}
                        </span>
                        <span className={`mt-0.5 block text-[12px] ${EFFECT_TONE_CLASS[view.tone]}`}>
                          {view.label}
                        </span>
                        {view.note ? (
                          <span className="mt-1 block text-xs text-muted-foreground">{view.note}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 pt-0.5 font-mono text-[11.5px] text-muted-foreground/80">
                        {formatRelativeTime(effect.createdAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Routine execution history */}
          {history.length ? (
            <div className="mt-4 border-t border-border pt-3.5">
              <div className="mb-1.5 ps-[23px] text-[12.5px] font-medium text-muted-foreground/80">
                {t`Execution history · ${history.length}`}
              </div>
              {history.map((row) => (
                <div
                  key={row.runId}
                  className="flex items-start gap-2.5 rounded-lg px-0.5 py-[7px]"
                >
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${runStatusTextClass(row.status)}`}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-[13.5px] text-foreground"
                    dir="auto"
                  >
                    {row.promptSnippet}
                  </span>
                  <span className="shrink-0 pt-0.5 font-mono text-[12px] text-muted-foreground/80">
                    {formatRelativeTime(row.at)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {/* Terminal result */}
          {run.status === "completed" || run.status === "failed" ? (
            <div className="mt-4 flex items-start gap-2.5 border-t border-border pt-4">
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full ${
                  run.status === "completed"
                    ? "bg-success text-background"
                    : "bg-destructive/15 text-destructive"
                }`}
              >
                {run.status === "completed" ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                )}
              </span>
              {run.status === "failed" && run.error ? (
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-foreground/85">
                  {run.error}
                </pre>
              ) : (
                <span className="mt-1 font-mono text-[12px] tabular-nums text-muted-foreground">
                  {elapsed}
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="grid place-items-center py-10 text-[13px] text-muted-foreground">
          {t`Loading…`}
        </div>
      )}
    </div>
  );
}
