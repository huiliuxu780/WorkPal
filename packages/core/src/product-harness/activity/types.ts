/**
 * Product Harness Phase 4 — Activity Projection types.
 *
 * ActivityItem is the single product-semantic unit every surface consumes
 * (thread inline activity, tool disclosure, background cards, sidebar). It is
 * a projection of persisted Product Events / Run state / BackgroundAgentTask
 * rows — never a stored entity, and never runtime internals: no raw event
 * names, no tool identifiers, no chain of thought.
 */

export type ActivityKind =
  | "working"
  | "planning"
  | "approval"
  | "tool"
  | "research"
  | "delegation"
  | "handoff"
  | "background"
  | "waiting_input"
  | "waiting_takeover"
  | "completed"
  | "failed"
  | "cancelled";

export type ActivityStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type ActivityItem = {
  id: string;

  runId?: string;
  botId: string;
  threadId: string;

  kind: ActivityKind;
  status: ActivityStatus;

  /** Human-readable product language, already localized-safe (no internals). */
  title: string;
  detail?: string;

  actor?: { botId: string; name?: string };
  target?: { botId: string; name?: string };

  startedAt?: string;
  completedAt?: string;

  /** Tool activity only: folded repeats ("Read files ×4"). */
  count?: number;
  durationMs?: number;

  /** Background tasks: the cancelable task id (undefined once terminal). */
  taskId?: string;

  collapsible?: boolean;
  children?: ActivityItem[];
};

/**
 * Visual grouping for a user turn: the root run plus everything it delegated
 * (support runs, helpers, background tasks) via persisted lineage — projection
 * only, no schema change.
 */
export type ActivityGroup = {
  rootRunId: string;
  botId: string;
  items: ActivityItem[];
};

/** Event rows the projector consumes (persisted Product Events). */
export type ActivitySourceEvent = {
  type: string;
  botId: string;
  seq: number;
  createdAt: string;
  runId?: string | null;
  payload?: Record<string, unknown>;
};

/** Run-state context so status-only states (takeover, waiting) project too. */
export type ActivityRunContext = {
  runId: string;
  botId: string;
  status: string;
  startedAt?: string | null;
};

export type ActivityProjectionContext = {
  threadId: string;
  /** Bot display names for actor/target labels. */
  botNames?: Readonly<Record<string, string>>;
  runs?: readonly ActivityRunContext[];
  /** Background task rows (durable, survive refresh and parent completion). */
  backgroundTasks?: readonly ActivityBackgroundTask[];
};

export type ActivityBackgroundTask = {
  taskId: string;
  parentRunId: string;
  botId: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Redacted, bounded task label; never raw prompts or results. */
  label?: string | null;
  error?: string | null;
};
