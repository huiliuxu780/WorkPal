export type BrandedId<Name extends string> = string & { readonly __brand: Name };

export type UserId = BrandedId<"UserId">;
export type SpaceId = BrandedId<"SpaceId">;
export type BotId = BrandedId<"BotId">;
export type GroupId = BrandedId<"GroupId">;
export type ThreadId = BrandedId<"ThreadId">;
export type MessageId = BrandedId<"MessageId">;
export type TaskId = BrandedId<"TaskId">;
export type RunId = BrandedId<"RunId">;
export type AttemptId = BrandedId<"AttemptId">;
export type RuntimeTaskId = BrandedId<"RuntimeTaskId">;
export type InterventionId = BrandedId<"InterventionId">;

export const ROUNDTABLE_CONTRACT_INVALID = "ROUNDTABLE_CONTRACT_INVALID" as const;

export class RoundtableContractError extends Error {
  override readonly name = "RoundtableContractError";
  readonly code = ROUNDTABLE_CONTRACT_INVALID;

  constructor(
    readonly contract: string,
    readonly path: string,
    detail: string,
  ) {
    super(`${contract}${path === "" ? "" : `.${path}`}: ${detail}`);
  }
}

function invalid(contract: string, path: string, detail: string): never {
  throw new RoundtableContractError(contract, path, detail);
}

function asRecord(value: unknown, contract: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(contract, path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, contract: string, path: string): string {
  if (typeof value !== "string") invalid(contract, path, "expected a string");
  return value;
}

function asNonEmptyString(value: unknown, contract: string, path: string): string {
  const parsed = asString(value, contract, path);
  if (parsed.length === 0) invalid(contract, path, "expected a non-empty string");
  return parsed;
}

function asInteger(value: unknown, contract: string, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    invalid(contract, path, `expected an integer >= ${minimum}`);
  }
  return value;
}

function asBoolean(value: unknown, contract: string, path: string): boolean {
  if (typeof value !== "boolean") invalid(contract, path, "expected a boolean");
  return value;
}

function assertAllowedKeys(
  raw: Record<string, unknown>,
  contract: string,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) invalid(contract, path, `unexpected field ${JSON.stringify(key)}`);
  }
}

function parseBrandedId<Name extends string>(
  value: unknown,
  contract: string,
  path: string,
): BrandedId<Name> {
  return asNonEmptyString(value, contract, path) as BrandedId<Name>;
}

export function parseUserId(value: unknown): UserId {
  return parseBrandedId(value, "UserId", "");
}

export function parseSpaceId(value: unknown): SpaceId {
  return parseBrandedId(value, "SpaceId", "");
}

export function parseBotId(value: unknown): BotId {
  return parseBrandedId(value, "BotId", "");
}

export function parseGroupId(value: unknown): GroupId {
  return parseBrandedId(value, "GroupId", "");
}

export function parseThreadId(value: unknown): ThreadId {
  return parseBrandedId(value, "ThreadId", "");
}

export function parseMessageId(value: unknown): MessageId {
  return parseBrandedId(value, "MessageId", "");
}

export function parseTaskId(value: unknown): TaskId {
  return parseBrandedId(value, "TaskId", "");
}

export function parseRunId(value: unknown): RunId {
  return parseBrandedId(value, "RunId", "");
}

export function parseAttemptId(value: unknown): AttemptId {
  return parseBrandedId(value, "AttemptId", "");
}

export function parseRuntimeTaskId(value: unknown): RuntimeTaskId {
  return parseBrandedId(value, "RuntimeTaskId", "");
}

export function parseInterventionId(value: unknown): InterventionId {
  return parseBrandedId(value, "InterventionId", "");
}

export type CollaborationDestination =
  | Readonly<{
      kind: "current_group";
      groupId: GroupId;
      threadId: ThreadId;
    }>
  | Readonly<{
      kind: "agent_pair";
      pairThreadId: ThreadId;
      peerBotId: BotId;
    }>;

export type CollaborationOrigin = Readonly<{
  sourceThreadId: ThreadId;
  sourceRunId: RunId;
  sourceMessageId?: MessageId;
}>;

/** Navigation reference only; readers still authorize the user, Space and Thread. */
export type DestinationLocator =
  | Readonly<{
      kind: "group_message";
      groupId: GroupId;
      threadId: ThreadId;
      messageId: MessageId;
    }>
  | Readonly<{
      kind: "pair_message";
      pairThreadId: ThreadId;
      messageId: MessageId;
    }>;

export type TaskInstructionEnvelope = Readonly<{
  taskId: TaskId;
  revision: number;
  original: Readonly<{
    content: string;
    messageId?: MessageId;
  }>;
  amendments: readonly Readonly<{
    messageId: MessageId;
    seq: number;
    content: string;
  }>[];
}>;

export type RunInstructionRef = Readonly<{
  taskId: TaskId;
  consumedRevision: number;
}>;

export type BackgroundExecutionRef = Readonly<{
  taskId: TaskId;
  runId: RunId;
  attemptId: AttemptId;
  runtimeTaskId: RuntimeTaskId;
  consumedRevision: number;
}>;

export type DeliveryBatchKey = Readonly<{
  threadId: ThreadId;
  threadGeneration: number;
  botId: BotId;
  originRunId: RunId;
  executionTaskId: TaskId;
  executionRunId: RunId;
  attemptId: AttemptId;
  runtimeTaskId: RuntimeTaskId;
  consumedRevision: number;
}>;

export type CollaborationReceiptTarget =
  | Readonly<{
      kind: "bot";
      botId: BotId;
    }>
  | Readonly<{
      kind: "group";
      groupId: GroupId;
      threadId: ThreadId;
    }>;

export type CollaborationReceipt = Readonly<{
  kind: "collaboration_receipt";
  target: CollaborationReceiptTarget;
  state: "sent" | "failed" | "completed" | "cancelled";
  destination: DestinationLocator | null;
}>;

export type UserActor = Readonly<{
  kind: "user";
  userId: UserId;
  spaceId: SpaceId;
}>;

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

export type GroupPageQuery = Readonly<{
  actor: UserActor;
  groupId: GroupId;
  cursor?: string;
  limit: number;
}>;

export type GroupWorkQuery = Readonly<{
  actor: UserActor;
  groupId: GroupId;
  taskId: TaskId;
}>;

export type GroupWorkState =
  | Readonly<{ kind: "queued" }>
  | Readonly<{ kind: "working"; currentAction?: string }>
  | Readonly<{ kind: "waiting"; reason: "approval" | "input" | "resource" }>
  | Readonly<{ kind: "failed"; summary: string }>
  | Readonly<{ kind: "done"; resultMessageId?: MessageId }>
  | Readonly<{ kind: "cancelled" }>;

export type GroupWorkItem = Readonly<{
  taskId: TaskId;
  rootRunId: RunId;
  ownerBotId: BotId;
  state: GroupWorkState;
  updatedAt: string;
  children: readonly GroupWorkItem[];
}>;

export type GroupWorkDetail = Readonly<{
  groupId: GroupId;
  work: GroupWorkItem;
  instruction: TaskInstructionEnvelope;
}>;

export type GroupMemberSummary =
  | Readonly<{
      kind: "user";
      userId: UserId;
      name: string;
    }>
  | Readonly<{
      kind: "bot";
      botId: BotId;
      name: string;
      status: string;
    }>;

/** Read projection for the group panel; groups themselves stay in existing tables. */
export type GroupDetailSummary = Readonly<{
  groupId: GroupId;
  threadId: ThreadId;
  name: string;
  members: readonly GroupMemberSummary[];
}>;

export type ArtifactSummary = Readonly<{
  id: string;
  name: string;
  description: string | null;
  mimeType: string;
  size: number;
  version: number;
  createdAt: string;
}>;

export type GroupRoutineSummary = Readonly<{
  id: string;
  botId: BotId;
  threadId: ThreadId;
  name: string;
  crons: readonly string[];
  timezone: string;
  active: boolean;
  nextRunAt: string | null;
}>;

export interface GroupQueries {
  listWork(input: GroupPageQuery): Promise<Page<GroupWorkItem>>;
  getWork(input: GroupWorkQuery): Promise<GroupWorkDetail>;
  listArtifacts(input: GroupPageQuery): Promise<Page<ArtifactSummary>>;
  listRoutines(input: GroupPageQuery): Promise<Page<GroupRoutineSummary>>;
  listMembers(input: GroupPageQuery): Promise<Page<GroupMemberSummary>>;
}

export function parseCollaborationDestination(value: unknown): CollaborationDestination {
  const contract = "CollaborationDestination";
  const raw = asRecord(value, contract, "destination");
  const kind = asNonEmptyString(raw.kind, contract, "kind");
  switch (kind) {
    case "current_group": {
      assertAllowedKeys(raw, contract, "", ["kind", "groupId", "threadId"]);
      return {
        kind,
        groupId: parseBrandedId(raw.groupId, contract, "groupId"),
        threadId: parseBrandedId(raw.threadId, contract, "threadId"),
      };
    }
    case "agent_pair": {
      assertAllowedKeys(raw, contract, "", ["kind", "pairThreadId", "peerBotId"]);
      return {
        kind,
        pairThreadId: parseBrandedId(raw.pairThreadId, contract, "pairThreadId"),
        peerBotId: parseBrandedId(raw.peerBotId, contract, "peerBotId"),
      };
    }
    default:
      return invalid(contract, "kind", `unknown destination kind ${JSON.stringify(kind)}`);
  }
}

export function parseCollaborationOrigin(value: unknown): CollaborationOrigin {
  const contract = "CollaborationOrigin";
  const raw = asRecord(value, contract, "origin");
  const origin: {
    sourceThreadId: ThreadId;
    sourceRunId: RunId;
    sourceMessageId?: MessageId;
  } = {
    sourceThreadId: parseBrandedId(raw.sourceThreadId, contract, "sourceThreadId"),
    sourceRunId: parseBrandedId(raw.sourceRunId, contract, "sourceRunId"),
  };
  if (raw.sourceMessageId !== undefined) {
    origin.sourceMessageId = parseBrandedId(raw.sourceMessageId, contract, "sourceMessageId");
  }
  return origin;
}

export function parseDestinationLocator(value: unknown): DestinationLocator {
  const contract = "DestinationLocator";
  const raw = asRecord(value, contract, "locator");
  const kind = asNonEmptyString(raw.kind, contract, "kind");
  switch (kind) {
    case "group_message": {
      assertAllowedKeys(raw, contract, "", ["kind", "groupId", "threadId", "messageId"]);
      return {
        kind,
        groupId: parseBrandedId(raw.groupId, contract, "groupId"),
        threadId: parseBrandedId(raw.threadId, contract, "threadId"),
        messageId: parseBrandedId(raw.messageId, contract, "messageId"),
      };
    }
    case "pair_message": {
      assertAllowedKeys(raw, contract, "", ["kind", "pairThreadId", "messageId"]);
      return {
        kind,
        pairThreadId: parseBrandedId(raw.pairThreadId, contract, "pairThreadId"),
        messageId: parseBrandedId(raw.messageId, contract, "messageId"),
      };
    }
    default:
      return invalid(contract, "kind", `unknown locator kind ${JSON.stringify(kind)}`);
  }
}

export function parseTaskInstructionEnvelope(value: unknown): TaskInstructionEnvelope {
  const contract = "TaskInstructionEnvelope";
  const raw = asRecord(value, contract, "envelope");
  const originalRaw = asRecord(raw.original, contract, "original");
  const original: { content: string; messageId?: MessageId } = {
    content: asString(originalRaw.content, contract, "original.content"),
  };
  if (originalRaw.messageId !== undefined) {
    original.messageId = parseBrandedId(originalRaw.messageId, contract, "original.messageId");
  }
  if (!Array.isArray(raw.amendments)) {
    invalid(contract, "amendments", "expected an array");
  }
  let previousSeq = 0;
  const amendments = raw.amendments.map((item, index) => {
    const path = `amendments[${index}]`;
    const amendment = asRecord(item, contract, path);
    const seq = asInteger(amendment.seq, contract, `${path}.seq`, 1);
    if (seq <= previousSeq) {
      invalid(contract, `${path}.seq`, "amendments must be ordered by strictly increasing seq");
    }
    previousSeq = seq;
    return {
      messageId: parseBrandedId<"MessageId">(amendment.messageId, contract, `${path}.messageId`),
      seq,
      content: asString(amendment.content, contract, `${path}.content`),
    };
  });
  return {
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
    revision: asInteger(raw.revision, contract, "revision", 1),
    original,
    amendments,
  };
}

export function parseRunInstructionRef(value: unknown): RunInstructionRef {
  const contract = "RunInstructionRef";
  const raw = asRecord(value, contract, "ref");
  return {
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
    consumedRevision: asInteger(raw.consumedRevision, contract, "consumedRevision", 1),
  };
}

export function parseBackgroundExecutionRef(value: unknown): BackgroundExecutionRef {
  const contract = "BackgroundExecutionRef";
  const raw = asRecord(value, contract, "execution");
  return {
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
    runId: parseBrandedId(raw.runId, contract, "runId"),
    attemptId: parseBrandedId(raw.attemptId, contract, "attemptId"),
    runtimeTaskId: parseBrandedId(raw.runtimeTaskId, contract, "runtimeTaskId"),
    consumedRevision: asInteger(raw.consumedRevision, contract, "consumedRevision", 1),
  };
}

export function parseDeliveryBatchKey(value: unknown): DeliveryBatchKey {
  const contract = "DeliveryBatchKey";
  const raw = asRecord(value, contract, "batchKey");
  return {
    threadId: parseBrandedId(raw.threadId, contract, "threadId"),
    threadGeneration: asInteger(raw.threadGeneration, contract, "threadGeneration", 0),
    botId: parseBrandedId(raw.botId, contract, "botId"),
    originRunId: parseBrandedId(raw.originRunId, contract, "originRunId"),
    executionTaskId: parseBrandedId(raw.executionTaskId, contract, "executionTaskId"),
    executionRunId: parseBrandedId(raw.executionRunId, contract, "executionRunId"),
    attemptId: parseBrandedId(raw.attemptId, contract, "attemptId"),
    runtimeTaskId: parseBrandedId(raw.runtimeTaskId, contract, "runtimeTaskId"),
    consumedRevision: asInteger(raw.consumedRevision, contract, "consumedRevision", 1),
  };
}

function parseCollaborationReceiptTarget(value: unknown): CollaborationReceiptTarget {
  const contract = "CollaborationReceiptTarget";
  const raw = asRecord(value, contract, "target");
  const kind = asNonEmptyString(raw.kind, contract, "kind");
  switch (kind) {
    case "bot": {
      assertAllowedKeys(raw, contract, "", ["kind", "botId"]);
      return { kind, botId: parseBrandedId(raw.botId, contract, "botId") };
    }
    case "group": {
      assertAllowedKeys(raw, contract, "", ["kind", "groupId", "threadId"]);
      return {
        kind,
        groupId: parseBrandedId(raw.groupId, contract, "groupId"),
        threadId: parseBrandedId(raw.threadId, contract, "threadId"),
      };
    }
    default:
      return invalid(contract, "kind", `unknown receipt target kind ${JSON.stringify(kind)}`);
  }
}

export function parseCollaborationReceipt(value: unknown): CollaborationReceipt {
  const contract = "CollaborationReceipt";
  const raw = asRecord(value, contract, "receipt");
  assertAllowedKeys(raw, contract, "", ["kind", "target", "state", "destination"]);
  if (raw.kind !== "collaboration_receipt") {
    invalid(contract, "kind", 'expected "collaboration_receipt"');
  }
  const target = parseCollaborationReceiptTarget(raw.target);
  if (
    raw.state !== "sent" &&
    raw.state !== "failed" &&
    raw.state !== "completed" &&
    raw.state !== "cancelled"
  ) {
    invalid(contract, "state", "expected sent, failed, completed or cancelled");
  }
  const destination = raw.destination === null ? null : parseDestinationLocator(raw.destination);
  if (raw.state === "failed") {
    if (destination !== null) invalid(contract, "destination", "failed receipts have no locator");
  } else if (destination === null) {
    invalid(contract, "destination", "delivered receipts require a locator");
  }
  if (target.kind === "group" && destination !== null) {
    if (
      destination.kind !== "group_message" ||
      destination.groupId !== target.groupId ||
      destination.threadId !== target.threadId
    ) {
      invalid(contract, "destination", "group receipt locator must target the same group Thread");
    }
  }
  return { kind: "collaboration_receipt", target, state: raw.state, destination };
}

function parseUserActor(value: unknown): UserActor {
  const contract = "UserActor";
  const raw = asRecord(value, contract, "actor");
  assertAllowedKeys(raw, contract, "", ["kind", "userId", "spaceId"]);
  if (raw.kind !== "user") invalid(contract, "kind", 'expected "user"');
  return {
    kind: "user",
    userId: parseBrandedId(raw.userId, contract, "userId"),
    spaceId: parseBrandedId(raw.spaceId, contract, "spaceId"),
  };
}

export function parseGroupPageQuery(value: unknown): GroupPageQuery {
  const contract = "GroupPageQuery";
  const raw = asRecord(value, contract, "query");
  const query: {
    actor: UserActor;
    groupId: GroupId;
    cursor?: string;
    limit: number;
  } = {
    actor: parseUserActor(raw.actor),
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    limit: asInteger(raw.limit, contract, "limit", 1),
  };
  if (raw.cursor !== undefined) {
    query.cursor = asNonEmptyString(raw.cursor, contract, "cursor");
  }
  return query;
}

export function parseGroupWorkQuery(value: unknown): GroupWorkQuery {
  const contract = "GroupWorkQuery";
  const raw = asRecord(value, contract, "query");
  return {
    actor: parseUserActor(raw.actor),
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
  };
}

export function parseGroupWorkState(value: unknown): GroupWorkState {
  const contract = "GroupWorkState";
  const raw = asRecord(value, contract, "state");
  const kind = asNonEmptyString(raw.kind, contract, "kind");
  switch (kind) {
    case "queued":
    case "cancelled": {
      assertAllowedKeys(raw, contract, "", ["kind"]);
      return { kind };
    }
    case "working": {
      assertAllowedKeys(raw, contract, "", ["kind", "currentAction"]);
      return raw.currentAction === undefined
        ? { kind }
        : { kind, currentAction: asString(raw.currentAction, contract, "currentAction") };
    }
    case "waiting": {
      assertAllowedKeys(raw, contract, "", ["kind", "reason"]);
      if (raw.reason !== "approval" && raw.reason !== "input" && raw.reason !== "resource") {
        invalid(contract, "reason", "expected approval, input or resource");
      }
      return { kind, reason: raw.reason };
    }
    case "failed": {
      assertAllowedKeys(raw, contract, "", ["kind", "summary"]);
      return { kind, summary: asString(raw.summary, contract, "summary") };
    }
    case "done": {
      assertAllowedKeys(raw, contract, "", ["kind", "resultMessageId"]);
      return raw.resultMessageId === undefined
        ? { kind }
        : {
            kind,
            resultMessageId: parseBrandedId(raw.resultMessageId, contract, "resultMessageId"),
          };
    }
    default:
      return invalid(contract, "kind", `unknown work state kind ${JSON.stringify(kind)}`);
  }
}

export function parseGroupWorkItem(value: unknown): GroupWorkItem {
  const contract = "GroupWorkItem";
  const raw = asRecord(value, contract, "work");
  if (!Array.isArray(raw.children)) invalid(contract, "children", "expected an array");
  return {
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
    rootRunId: parseBrandedId(raw.rootRunId, contract, "rootRunId"),
    ownerBotId: parseBrandedId(raw.ownerBotId, contract, "ownerBotId"),
    state: parseGroupWorkState(raw.state),
    updatedAt: asNonEmptyString(raw.updatedAt, contract, "updatedAt"),
    children: raw.children.map((child) => parseGroupWorkItem(child)),
  };
}

export function parseGroupWorkDetail(value: unknown): GroupWorkDetail {
  const contract = "GroupWorkDetail";
  const raw = asRecord(value, contract, "detail");
  return {
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    work: parseGroupWorkItem(raw.work),
    instruction: parseTaskInstructionEnvelope(raw.instruction),
  };
}

export function parseGroupMemberSummary(value: unknown): GroupMemberSummary {
  const contract = "GroupMemberSummary";
  const raw = asRecord(value, contract, "member");
  const kind = asNonEmptyString(raw.kind, contract, "kind");
  switch (kind) {
    case "user": {
      assertAllowedKeys(raw, contract, "", ["kind", "userId", "name"]);
      return {
        kind,
        userId: parseBrandedId(raw.userId, contract, "userId"),
        name: asString(raw.name, contract, "name"),
      };
    }
    case "bot": {
      assertAllowedKeys(raw, contract, "", ["kind", "botId", "name", "status"]);
      return {
        kind,
        botId: parseBrandedId(raw.botId, contract, "botId"),
        name: asString(raw.name, contract, "name"),
        status: asString(raw.status, contract, "status"),
      };
    }
    default:
      return invalid(contract, "kind", `unknown member kind ${JSON.stringify(kind)}`);
  }
}

export function parseGroupDetailSummary(value: unknown): GroupDetailSummary {
  const contract = "GroupDetailSummary";
  const raw = asRecord(value, contract, "detail");
  if (!Array.isArray(raw.members)) invalid(contract, "members", "expected an array");
  return {
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    threadId: parseBrandedId(raw.threadId, contract, "threadId"),
    name: asString(raw.name, contract, "name"),
    members: raw.members.map((member) => parseGroupMemberSummary(member)),
  };
}

export function parseArtifactSummary(value: unknown): ArtifactSummary {
  const contract = "ArtifactSummary";
  const raw = asRecord(value, contract, "artifact");
  if (raw.description !== null && raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      invalid(contract, "description", "expected a string or null");
    }
  }
  return {
    id: asNonEmptyString(raw.id, contract, "id"),
    name: asString(raw.name, contract, "name"),
    description: typeof raw.description === "string" ? raw.description : null,
    mimeType: asNonEmptyString(raw.mimeType, contract, "mimeType"),
    size: asInteger(raw.size, contract, "size", 0),
    version: asInteger(raw.version, contract, "version", 1),
    createdAt: asNonEmptyString(raw.createdAt, contract, "createdAt"),
  };
}

export function parseGroupRoutineSummary(value: unknown): GroupRoutineSummary {
  const contract = "GroupRoutineSummary";
  const raw = asRecord(value, contract, "routine");
  if (!Array.isArray(raw.crons)) invalid(contract, "crons", "expected an array");
  if (raw.nextRunAt !== null && raw.nextRunAt !== undefined) {
    if (typeof raw.nextRunAt !== "string") {
      invalid(contract, "nextRunAt", "expected a string or null");
    }
  }
  return {
    id: asNonEmptyString(raw.id, contract, "id"),
    botId: parseBrandedId(raw.botId, contract, "botId"),
    threadId: parseBrandedId(raw.threadId, contract, "threadId"),
    name: asString(raw.name, contract, "name"),
    crons: raw.crons.map((cron, index) => asString(cron, contract, `crons[${index}]`)),
    timezone: asNonEmptyString(raw.timezone, contract, "timezone"),
    active: asBoolean(raw.active, contract, "active"),
    nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : null,
  };
}
