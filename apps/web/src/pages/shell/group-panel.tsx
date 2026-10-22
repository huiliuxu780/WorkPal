import { Trans, useLingui } from "@lingui/react/macro";
import type { GroupMembers, GroupRoutineSummary } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { AgentAvatar, cn } from "@rakazo/ui-web";
import { Repeat2 } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { agentActivity, GroupIdentityCluster } from "./group-identity-cluster";
import type { GroupArtifactItem } from "./use-group-panel";

export type GroupPanelTab = "details" | "work" | "library" | "members";

export const GROUP_PANEL_TABS: readonly GroupPanelTab[] = ["details", "work", "library", "members"];

function GroupNameField({
  name,
  onSave,
}: {
  name: string;
  onSave: (next: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  async function commit(next: string) {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const trimmed = next.trim();
    if (saving.current || !trimmed || trimmed === name) return;
    saving.current = true;
    setError(null);
    try {
      await onSave(trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save group`);
      setDraft(name);
    } finally {
      saving.current = false;
    }
  }

  return (
    <div className="flex min-w-0 flex-col items-center">
      <input
        data-testid="group-name-field"
        data-editing={editing || undefined}
        aria-label={t`Group name`}
        readOnly={!editing}
        value={draft}
        dir="auto"
        onClick={() => setEditing(true)}
        onFocus={(event) => {
          if (editing) event.target.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => void commit(event.target.value)}
        onKeyDown={(event) => {
          const field = event.currentTarget;
          if (event.key === "Enter") {
            field.blur();
            void commit(field.value);
          }
          if (event.key === "Escape") {
            cancelled.current = true;
            setDraft(name);
            setEditing(false);
            field.blur();
          }
        }}
        className={cn(
          "w-full max-w-[245px] truncate rounded-lg border-0 bg-transparent px-1.5 py-0.5 text-center text-[16px] font-bold tracking-[-0.015em] text-foreground outline-none",
          editing ? "bg-accent ring-1 ring-border" : "hover:bg-accent",
        )}
      />
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function artifactTime(iso: string, now: Date): { kind: "relative" | "day"; value: string } {
  const date = new Date(iso);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (sameDay(date, now)) {
    if (minutes < 1) return { kind: "relative", value: "just-now" };
    if (minutes < 60) return { kind: "relative", value: `minutes:${minutes}` };
    return { kind: "relative", value: `hours:${Math.floor(minutes / 60)}` };
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return { kind: "day", value: "yesterday" };
  return { kind: "day", value: date.toLocaleDateString() };
}

function PanelSectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="mx-0.5 mb-2 text-[10px] font-semibold text-muted-foreground">{children}</div>
  );
}

function BorderlessAddEntry({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border-0 bg-transparent px-2 py-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <span aria-hidden="true">＋</span>
      {children}
    </button>
  );
}

export function GroupPanel({
  members,
  membersError,
  groupName,
  tab,
  onTabChange,
  onClose,
  onRename,
  onManageMembers,
  routines,
  routinesError,
  artifacts,
  artifactsError,
  artifactsLoading,
  nextCursor,
  onLoadMoreArtifacts,
  onOpenArtifact,
  onRetry,
}: {
  members: GroupMembers | null;
  membersError: string | null;
  groupName: string;
  tab: GroupPanelTab;
  onTabChange: (tab: GroupPanelTab) => void;
  onClose: () => void;
  onRename: (next: string) => Promise<void>;
  onManageMembers: () => void;
  routines: readonly GroupRoutineSummary[] | null;
  routinesError: string | null;
  artifacts: readonly GroupArtifactItem[];
  artifactsError: string | null;
  artifactsLoading: boolean;
  nextCursor: string | null;
  onLoadMoreArtifacts: () => Promise<void>;
  onOpenArtifact: (item: GroupArtifactItem) => void;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [routineNote, setRoutineNote] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const tabLabels: Record<GroupPanelTab, string> = {
    details: t`Details`,
    work: t`Work`,
    library: t`Library`,
    members: t`Members`,
  };

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = GROUP_PANEL_TABS.indexOf(tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % GROUP_PANEL_TABS.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + GROUP_PANEL_TABS.length) % GROUP_PANEL_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = GROUP_PANEL_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = GROUP_PANEL_TABS[next];
    if (!target) return;
    onTabChange(target);
    tabRefs.current[target]?.focus();
  }

  const now = new Date();
  const libraryGroups: { day: string; items: GroupArtifactItem[] }[] = [];
  for (const item of artifacts) {
    const time = artifactTime(item.createdAt, now);
    const day = time.kind === "day" ? time.value : "today";
    const group = libraryGroups.find((entry) => entry.day === day);
    if (group) group.items.push(item);
    else libraryGroups.push({ day, items: [item] });
  }

  return (
    <div data-testid="group-panel" className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-[124px] flex-col items-center justify-end px-[50px] pt-[21px] pb-[13px]">
        <button
          type="button"
          data-testid="group-panel-close"
          aria-label={t`Close group details`}
          onClick={onClose}
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-full border border-border bg-muted/40 text-[20px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          ×
        </button>
        {members ? <GroupIdentityCluster members={members} variant="panel" /> : null}
        <div className="mt-2.5 w-full">
          <GroupNameField name={groupName} onSave={onRename} />
        </div>
      </div>
      <div
        role="tablist"
        aria-label={t`Group details tabs`}
        className="flex min-h-[46px] items-center justify-center gap-0.5 border-b border-border px-3 pt-1 pb-2.5"
      >
        {GROUP_PANEL_TABS.map((key) => (
          <button
            key={key}
            ref={(node) => {
              tabRefs.current[key] = node;
            }}
            type="button"
            role="tab"
            id={`${ids}-tab-${key}`}
            data-testid={`group-panel-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${ids}-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={onTabKeyDown}
            onClick={() => onTabChange(key)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-full border-0 bg-transparent px-[11px] text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground",
              tab === key && "bg-accent font-semibold text-foreground",
            )}
          >
            {tabLabels[key]}
          </button>
        ))}
      </div>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-[18px] pt-[18px] pb-7">
        {membersError ? (
          <div role="alert" className="space-y-2 text-[12px] text-destructive">
            <p>{membersError}</p>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border-0 bg-transparent text-[12px] text-foreground underline"
            >
              <Trans>Retry</Trans>
            </button>
          </div>
        ) : null}
        <section
          role="tabpanel"
          id={`${ids}-panel-details`}
          aria-labelledby={`${ids}-tab-details`}
          hidden={tab !== "details"}
        >
          <PanelSectionHead>
            <Trans>Routines</Trans>
          </PanelSectionHead>
          {routinesError ? (
            <p role="alert" className="text-[12px] text-destructive">
              {routinesError}
            </p>
          ) : routines === null ? (
            <p className="text-[11px] text-muted-foreground">
              <Trans>Loading…</Trans>
            </p>
          ) : routines.length === 0 ? (
            <p className="px-0.5 text-[11px] text-muted-foreground">
              <Trans>No routines in this group yet.</Trans>
            </p>
          ) : (
            <div>
              {routines.map((routine) => (
                <div
                  key={routine.id}
                  data-testid="group-routine-row"
                  className="flex min-h-[58px] items-center gap-[11px] border-b border-border"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"
                  >
                    <Repeat2 size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground" dir="auto">
                      {routine.name}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {routine.crons.length > 0
                        ? routine.crons.map((cron) => formatCron(cron)).join(" · ")
                        : t`No trigger`}
                      {" · "}
                      {routine.executorBot.name}
                      {routine.active ? null : ` · ${t`Paused`}`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <BorderlessAddEntry testId="group-add-routine" onClick={() => setRoutineNote(true)}>
            <Trans>Set up routines</Trans>
          </BorderlessAddEntry>
          {routineNote ? (
            <p
              data-testid="group-routine-note"
              role="status"
              className="px-0.5 py-1 text-[11px] text-muted-foreground"
            >
              <Trans>Group routine setup is not connected yet.</Trans>
            </p>
          ) : null}
        </section>
        <section
          role="tabpanel"
          id={`${ids}-panel-work`}
          aria-labelledby={`${ids}-tab-work`}
          hidden={tab !== "work"}
        >
          <p
            data-testid="group-work-unavailable"
            className="px-0.5 text-[11px] text-muted-foreground"
          >
            <Trans>The work view for this group is not connected yet.</Trans>
          </p>
        </section>
        <section
          role="tabpanel"
          id={`${ids}-panel-library`}
          aria-labelledby={`${ids}-tab-library`}
          hidden={tab !== "library"}
        >
          {artifactsError ? (
            <p role="alert" className="text-[12px] text-destructive">
              {artifactsError}
            </p>
          ) : artifacts.length === 0 && !artifactsLoading ? (
            <p className="px-0.5 text-[11px] text-muted-foreground">
              <Trans>No files saved in this group yet.</Trans>
            </p>
          ) : (
            libraryGroups.map((group) => (
              <section key={group.day} className="mb-5">
                <div className="mb-2 px-0.5 text-[10px] font-semibold text-muted-foreground">
                  {group.day === "today" ? (
                    <Trans>Today</Trans>
                  ) : group.day === "yesterday" ? (
                    <Trans>Yesterday</Trans>
                  ) : (
                    group.day
                  )}
                </div>
                <div>
                  {group.items.map((item) => {
                    const time = artifactTime(item.createdAt, now);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid="group-library-row"
                        onClick={() => onOpenArtifact(item)}
                        className="flex w-full items-center gap-[11px] rounded-lg border-0 bg-transparent px-0.5 py-2 text-start hover:bg-accent focus-visible:bg-accent"
                      >
                        <span
                          aria-hidden="true"
                          className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
                        >
                          <svg viewBox="0 0 18 21" fill="none" width="16" height="19">
                            <path d="M3.5 1.5h7l4 4v14H3.5z" stroke="currentColor" />
                            <path
                              d="M10.5 1.5v4h4M6 10h6M6 13h6M6 16h4"
                              stroke="currentColor"
                              strokeLinecap="round"
                            />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-foreground" dir="auto">
                            {item.name}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {time.kind === "relative"
                              ? time.value === "just-now"
                                ? t`Just now`
                                : time.value.startsWith("minutes:")
                                  ? t`${time.value.slice(8)} min ago`
                                  : t`${time.value.slice(6)} h ago`
                              : time.value === "yesterday"
                                ? t`Yesterday`
                                : time.value}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
          {nextCursor ? (
            <button
              type="button"
              data-testid="group-library-more"
              disabled={artifactsLoading}
              onClick={() => void onLoadMoreArtifacts()}
              className="w-full rounded-lg border-0 bg-transparent py-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              {artifactsLoading ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
            </button>
          ) : null}
        </section>
        <section
          role="tabpanel"
          id={`${ids}-panel-members`}
          aria-labelledby={`${ids}-tab-members`}
          hidden={tab !== "members"}
        >
          <PanelSectionHead>
            {members ? <Trans>{members.agentCount} Agents</Trans> : <Trans>Members</Trans>}
          </PanelSectionHead>
          {members === null ? (
            membersError ? null : (
              <p className="text-[11px] text-muted-foreground">
                <Trans>Loading…</Trans>
              </p>
            )
          ) : (
            <div className="grid gap-1">
              {members.agents.map((agent) => (
                <div
                  key={agent.botId}
                  data-testid="group-member-row"
                  className="flex min-h-[54px] items-center gap-[11px] rounded-[10px] border-0 px-0.5 hover:bg-accent"
                >
                  <AgentAvatar
                    botId={agent.botId}
                    character={agent.avatarCharacter}
                    bodyColor={agent.avatarBodyColor}
                    name={agent.name}
                    size={32}
                    activity={agentActivity(agent.status)}
                    ariaHidden
                    focusable={false}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground" dir="auto">
                      {agent.name}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {agent.status === "running" ||
                      agent.status === "queued" ||
                      agent.status === "interrupted"
                        ? t`Working in background`
                        : agent.status === "failed"
                          ? t`Last run failed`
                          : t`Online`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <BorderlessAddEntry testId="group-add-agent" onClick={onManageMembers}>
            <Trans>Add Agent</Trans>
          </BorderlessAddEntry>
        </section>
      </div>
    </div>
  );
}
