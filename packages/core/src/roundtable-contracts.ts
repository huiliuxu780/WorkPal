import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";

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

function asInteger(
  value: unknown,
  contract: string,
  path: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const range = maximum === undefined ? `>= ${minimum}` : `between ${minimum} and ${maximum}`;
    invalid(contract, path, `expected a safe integer ${range}`);
  }
  return value;
}

function asBoolean(value: unknown, contract: string, path: string): boolean {
  if (typeof value !== "boolean") invalid(contract, path, "expected a boolean");
  return value;
}

function asNullableMessageProvider(value: unknown, contract: string, path: string): string | null {
  const parsed = asNullableNonEmptyString(value, contract, path);
  if (parsed !== null && (parsed.length > 50 || !/^[a-z0-9._-]+$/i.test(parsed))) {
    invalid(contract, path, "expected 1-50 letters, digits, dots, underscores or hyphens");
  }
  return parsed;
}

function asOneOf<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  contract: string,
  path: string,
): Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    invalid(contract, path, `expected one of ${allowed.join(", ")}`);
  }
  return value as Value;
}

function asNullableString(value: unknown, contract: string, path: string): string | null {
  return value === null ? null : asString(value, contract, path);
}

function asNullableNonEmptyString(value: unknown, contract: string, path: string): string | null {
  return value === null ? null : asNonEmptyString(value, contract, path);
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

function parseNullableBrandedId<Name extends string>(
  value: unknown,
  contract: string,
  path: string,
): BrandedId<Name> | null {
  return value === null ? null : parseBrandedId<Name>(value, contract, path);
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

export type GroupQuery = Readonly<{
  actor: UserActor;
  groupId: GroupId;
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

const GROUP_AGENT_AVATAR_MODES = ["legacy", "character", "upload"] as const;
const GROUP_AGENT_AVATAR_CHARACTERS = ["dot", "treble", "wave", "bounce"] as const;
const GROUP_AGENT_AVATAR_BODY_COLORS = [
  "orange",
  "blue",
  "purple",
  "brown",
  "pink",
  "ink",
] as const;
const GROUP_USER_AVATAR_STYLES = ["robot", "organic", "bloub"] as const;

export type GroupAgentAvatarMode = (typeof GROUP_AGENT_AVATAR_MODES)[number];
export type GroupAgentAvatarCharacter = (typeof GROUP_AGENT_AVATAR_CHARACTERS)[number];
export type GroupAgentAvatarBodyColor = (typeof GROUP_AGENT_AVATAR_BODY_COLORS)[number];
export type GroupUserAvatarStyle = (typeof GROUP_USER_AVATAR_STYLES)[number];

/** Identity shared by group headers, member rows and routine executor labels. */
export type GroupAgentIdentity = Readonly<{
  kind: "agent";
  botId: BotId;
  name: string;
  color: string;
  avatarMode: GroupAgentAvatarMode;
  avatarCharacter: GroupAgentAvatarCharacter | null;
  avatarBodyColor: GroupAgentAvatarBodyColor;
}>;

export type GroupAgentMember = GroupAgentIdentity &
  Readonly<{
    status: string;
  }>;

export type GroupUserMember = Readonly<{
  kind: "user";
  userId: UserId;
  name: string;
  image: string | null;
  avatarStyle: GroupUserAvatarStyle;
}>;

/**
 * Groups are capped at six Agents, so members are returned as one unpaged
 * projection. `agentCount` never includes the current user; `memberCount` is
 * always `agentCount + 1`.
 */
export type GroupMembersSummary = Readonly<{
  groupId: GroupId;
  threadId: ThreadId;
  currentUser: GroupUserMember;
  agents: readonly GroupAgentMember[];
  agentCount: number;
  memberCount: number;
}>;

export type ArtifactSummary = Readonly<{
  id: string;
  botId: BotId | null;
  groupId: GroupId | null;
  runId: RunId | null;
  name: string;
  description: string | null;
  mimeType: string;
  size: number;
  version: number;
  versionCount: number;
  createdAt: string;
}>;

/** Routines stay Bot-owned; the group only scopes which executors are visible. */
export type GroupRoutineSummary = Readonly<{
  id: string;
  botId: BotId;
  threadId: ThreadId;
  name: string;
  prompt: string;
  crons: readonly string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  executorBot: GroupAgentIdentity;
}>;

/** Panel read projection; implemented by the group data module. */
export interface GroupPanelQueries {
  listArtifacts(input: GroupPageQuery): Promise<Page<ArtifactSummary>>;
  listRoutines(input: GroupQuery): Promise<readonly GroupRoutineSummary[]>;
  listMembers(input: GroupQuery): Promise<GroupMembersSummary>;
}

/** Work read projection; implemented by the work projection module. */
export interface GroupWorkQueries {
  listWork(input: GroupPageQuery): Promise<Page<GroupWorkItem>>;
  getWork(input: GroupWorkQuery): Promise<GroupWorkDetail>;
}

/** Composite for consumers that need both projections. */
export interface GroupQueries extends GroupPanelQueries, GroupWorkQueries {}

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
  const revision = asInteger(raw.revision, contract, "revision", 1);
  if (revision !== amendments.length + 1) {
    invalid(contract, "revision", "must equal the original revision plus all amendments");
  }
  return {
    taskId: parseBrandedId(raw.taskId, contract, "taskId"),
    revision,
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
    limit: asInteger(raw.limit, contract, "limit", 1, 60),
  };
  if (raw.cursor !== undefined) {
    query.cursor = asNonEmptyString(raw.cursor, contract, "cursor");
  }
  return query;
}

export function parseGroupQuery(value: unknown): GroupQuery {
  const contract = "GroupQuery";
  const raw = asRecord(value, contract, "query");
  assertAllowedKeys(raw, contract, "", ["actor", "groupId"]);
  return {
    actor: parseUserActor(raw.actor),
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
  };
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
  const work = parseGroupWorkItem(raw.work);
  const instruction = parseTaskInstructionEnvelope(raw.instruction);
  if (work.taskId !== instruction.taskId) {
    invalid(contract, "instruction.taskId", "must match work.taskId");
  }
  return {
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    work,
    instruction,
  };
}

const GROUP_AGENT_IDENTITY_KEYS = [
  "kind",
  "botId",
  "name",
  "color",
  "avatarMode",
  "avatarCharacter",
  "avatarBodyColor",
] as const;

function parseGroupAgentIdentityValue(
  raw: Record<string, unknown>,
  contract: string,
  allowed: readonly string[],
): GroupAgentIdentity {
  assertAllowedKeys(raw, contract, "", allowed);
  if (raw.kind !== "agent") invalid(contract, "kind", 'expected "agent"');
  const avatarMode = asOneOf(raw.avatarMode, GROUP_AGENT_AVATAR_MODES, contract, "avatarMode");
  const avatarCharacter =
    raw.avatarCharacter === null
      ? null
      : asOneOf(raw.avatarCharacter, GROUP_AGENT_AVATAR_CHARACTERS, contract, "avatarCharacter");
  if (avatarMode === "character" && avatarCharacter === null) {
    invalid(contract, "avatarCharacter", "character avatars require an avatarCharacter");
  }
  if (avatarMode !== "character" && avatarCharacter !== null) {
    invalid(contract, "avatarCharacter", "only character avatars carry an avatarCharacter");
  }
  return {
    kind: "agent",
    botId: parseBrandedId(raw.botId, contract, "botId"),
    name: asString(raw.name, contract, "name"),
    color: asString(raw.color, contract, "color"),
    avatarMode,
    avatarCharacter,
    avatarBodyColor: asOneOf(
      raw.avatarBodyColor,
      GROUP_AGENT_AVATAR_BODY_COLORS,
      contract,
      "avatarBodyColor",
    ),
  };
}

export function parseGroupAgentIdentity(value: unknown): GroupAgentIdentity {
  const contract = "GroupAgentIdentity";
  const raw = asRecord(value, contract, "agent");
  return parseGroupAgentIdentityValue(raw, contract, GROUP_AGENT_IDENTITY_KEYS);
}

export function parseGroupAgentMember(value: unknown): GroupAgentMember {
  const contract = "GroupAgentMember";
  const raw = asRecord(value, contract, "member");
  const identity = parseGroupAgentIdentityValue(raw, contract, [
    ...GROUP_AGENT_IDENTITY_KEYS,
    "status",
  ]);
  return { ...identity, status: asString(raw.status, contract, "status") };
}

export function parseGroupUserMember(value: unknown): GroupUserMember {
  const contract = "GroupUserMember";
  const raw = asRecord(value, contract, "member");
  assertAllowedKeys(raw, contract, "", ["kind", "userId", "name", "image", "avatarStyle"]);
  if (raw.kind !== "user") invalid(contract, "kind", 'expected "user"');
  return {
    kind: "user",
    userId: parseBrandedId(raw.userId, contract, "userId"),
    name: asString(raw.name, contract, "name"),
    image: asNullableString(raw.image, contract, "image"),
    avatarStyle: asOneOf(raw.avatarStyle, GROUP_USER_AVATAR_STYLES, contract, "avatarStyle"),
  };
}

export function parseGroupMembersSummary(value: unknown): GroupMembersSummary {
  const contract = "GroupMembersSummary";
  const raw = asRecord(value, contract, "members");
  assertAllowedKeys(raw, contract, "", [
    "groupId",
    "threadId",
    "currentUser",
    "agents",
    "agentCount",
    "memberCount",
  ]);
  if (!Array.isArray(raw.agents)) invalid(contract, "agents", "expected an array");
  const currentUser = parseGroupUserMember(raw.currentUser);
  const agents = raw.agents.map((member) => parseGroupAgentMember(member));
  const agentCount = asInteger(
    raw.agentCount,
    contract,
    "agentCount",
    GROUP_MEMBER_MIN,
    GROUP_MEMBER_MAX,
  );
  if (agents.length < GROUP_MEMBER_MIN) {
    invalid(contract, "agents", `must contain at least ${GROUP_MEMBER_MIN} agents`);
  }
  if (agents.length > GROUP_MEMBER_MAX) {
    invalid(contract, "agents", `must contain at most ${GROUP_MEMBER_MAX} agents`);
  }
  const memberCount = asInteger(raw.memberCount, contract, "memberCount", 1);
  if (agentCount !== agents.length) {
    invalid(contract, "agentCount", "must equal the number of agents");
  }
  if (memberCount !== agentCount + 1) {
    invalid(contract, "memberCount", "must equal agentCount + 1");
  }
  const seen = new Set<string>();
  agents.forEach((agent, index) => {
    if (seen.has(agent.botId)) invalid(contract, `agents[${index}].botId`, "duplicate agent");
    seen.add(agent.botId);
  });
  return {
    groupId: parseBrandedId(raw.groupId, contract, "groupId"),
    threadId: parseBrandedId(raw.threadId, contract, "threadId"),
    currentUser,
    agents,
    agentCount,
    memberCount,
  };
}

export function parseArtifactSummary(value: unknown): ArtifactSummary {
  const contract = "ArtifactSummary";
  const raw = asRecord(value, contract, "artifact");
  if (raw.description !== null && typeof raw.description !== "string") {
    invalid(contract, "description", "expected a string or null");
  }
  return {
    id: asNonEmptyString(raw.id, contract, "id"),
    botId: parseNullableBrandedId<"BotId">(raw.botId, contract, "botId"),
    groupId: parseNullableBrandedId<"GroupId">(raw.groupId, contract, "groupId"),
    runId: parseNullableBrandedId<"RunId">(raw.runId, contract, "runId"),
    name: asString(raw.name, contract, "name"),
    description: raw.description,
    mimeType: asNonEmptyString(raw.mimeType, contract, "mimeType"),
    size: asInteger(raw.size, contract, "size", 0),
    version: asInteger(raw.version, contract, "version", 1),
    versionCount: asInteger(raw.versionCount, contract, "versionCount", 1),
    createdAt: asNonEmptyString(raw.createdAt, contract, "createdAt"),
  };
}

export function parseGroupRoutineSummary(value: unknown): GroupRoutineSummary {
  const contract = "GroupRoutineSummary";
  const raw = asRecord(value, contract, "routine");
  if (!Array.isArray(raw.crons)) invalid(contract, "crons", "expected an array");
  if (raw.executorBot === undefined) {
    invalid(contract, "executorBot", "expected an executor agent");
  }
  const botId = parseBrandedId<"BotId">(raw.botId, contract, "botId");
  const executorBot = parseGroupAgentIdentity(raw.executorBot);
  if (executorBot.botId !== botId) {
    invalid(contract, "executorBot.botId", "executor must be the routine's bot");
  }
  return {
    id: asNonEmptyString(raw.id, contract, "id"),
    botId,
    threadId: parseBrandedId(raw.threadId, contract, "threadId"),
    name: asString(raw.name, contract, "name"),
    prompt: asString(raw.prompt, contract, "prompt"),
    crons: raw.crons.map((cron, index) => asString(cron, contract, `crons[${index}]`)),
    timezone: asNonEmptyString(raw.timezone, contract, "timezone"),
    active: asBoolean(raw.active, contract, "active"),
    notify: asBoolean(raw.notify, contract, "notify"),
    webhookEnabled: asBoolean(raw.webhookEnabled, contract, "webhookEnabled"),
    githubEnabled: asBoolean(raw.githubEnabled, contract, "githubEnabled"),
    messageProvider: asNullableMessageProvider(raw.messageProvider, contract, "messageProvider"),
    lastRunAt: asNullableNonEmptyString(raw.lastRunAt, contract, "lastRunAt"),
    nextRunAt: asNullableNonEmptyString(raw.nextRunAt, contract, "nextRunAt"),
    createdAt: asNonEmptyString(raw.createdAt, contract, "createdAt"),
    executorBot,
  };
}
