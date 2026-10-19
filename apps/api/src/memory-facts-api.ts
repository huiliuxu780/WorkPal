import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getSpaceMemoryPolicy, setSpaceMemoryPolicy } from "@rakazo/db";
import {
  confirmFactAsActor,
  correctFactAsActor,
  deleteFactAsActor,
  EmptyImportError,
  FactForbiddenError,
  FactNotFoundError,
  getFactForActorWithEvidence,
  importLegacyDocumentAsFact,
  listFactsForActor,
  loadMemoryInjectionReadModel,
  promoteFactAsActor,
  recordMemoryFromEdit,
  rejectFactAsActor,
  evidenceToDto,
  loadFactViews,
  type FactServiceDeps,
} from "@rakazo/memory";
import type {
  MemoryFactConfirmInput,
  MemoryFactCorrectInput,
  MemoryFactCreateInput,
  MemoryFactDeleteInput,
  MemoryFactEvidenceListInput,
  MemoryFactGetInput,
  MemoryFactImportLegacyInput,
  MemoryFactListInput,
  MemoryFactMutationResult,
  MemoryFactPromoteInput,
  MemoryFactRejectInput,
  MemorySummaryGetInput,
} from "@rakazo/contracts";

/**
 * RPC surface for first-party memory facts (ME-01/ME-02). Every call goes
 * through the same fact service the tools and worker use, so per-item delete,
 * revision CAS and evidence governance cannot be bypassed. Business outcomes
 * (conflict, invalid state) are typed results; authorization failures are
 * ORPC errors.
 */

export interface MemoryFactsApiDeps {
  prisma: PrismaClient;
  memoryDigestKey: string;
}

function serviceDeps(deps: MemoryFactsApiDeps): FactServiceDeps {
  return { prisma: deps.prisma, digestKey: deps.memoryDigestKey };
}

function actorOf(actor: Actor): { userId: string; spaceId: string } {
  return { userId: actor.userId, spaceId: actor.spaceId };
}

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

async function runFactMutation(
  mutate: () => Promise<MemoryFactMutationResult>,
): Promise<MemoryFactMutationResult> {
  try {
    return await mutate();
  } catch (error) {
    if (error instanceof FactNotFoundError) throw new ORPCError("NOT_FOUND");
    if (error instanceof FactForbiddenError) {
      throw new ORPCError("FORBIDDEN", { message: error.message });
    }
    if (error instanceof EmptyImportError) {
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    throw error;
  }
}

export async function listMemoryFacts(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactListInput,
) {
  const facts = await listFactsForActor(serviceDeps(deps), {
    actor: actorOf(actor),
    ...(input.botId ? { botId: input.botId } : {}),
    ...(input.states ? { states: input.states } : {}),
    ...(input.includeExpired !== undefined ? { includeExpired: input.includeExpired } : {}),
  });
  return { facts };
}

export async function getMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactGetInput,
) {
  const loaded = await getFactForActorWithEvidence(serviceDeps(deps), {
    actor: actorOf(actor),
    ...(input.botId ? { botId: input.botId } : {}),
    factId: input.factId,
  });
  if (!loaded) throw new ORPCError("NOT_FOUND");
  return loaded;
}

export async function createMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactCreateInput,
): Promise<MemoryFactMutationResult> {
  if (input.scopeKind === "bot" && !input.botId) {
    throw new ORPCError("BAD_REQUEST", { message: "botId is required for bot-scope facts" });
  }
  if (input.scopeKind === "bot" && input.botId) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId },
      select: { id: true },
    });
    if (!bot) throw new ORPCError("NOT_FOUND");
  }
  return runFactMutation(async () => {
    const result = await recordMemoryFromEdit(serviceDeps(deps), {
      actor: actorOf(actor),
      scopeKind: input.scopeKind,
      scopeId: input.scopeKind === "bot" ? input.botId! : actor.userId,
      ...(input.botId ? { botId: input.botId } : {}),
      text: input.text,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.literalValues !== undefined ? { literalValues: input.literalValues } : {}),
    });
    if (result.status === "duplicate" || result.status === "merged") {
      const views = await loadFactViews(deps.prisma, [result.fact]);
      return { status: "replayed" as const, fact: views[0]! };
    }
    if (result.status === "blocked_by_user_fact") {
      const views = await loadFactViews(deps.prisma, [result.fact]);
      return { status: "invalid_state" as const, fact: views[0]! };
    }
    const views = await loadFactViews(deps.prisma, [result.fact]);
    return { status: "updated" as const, fact: views[0]! };
  });
}

export async function confirmMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactConfirmInput,
) {
  return runFactMutation(() =>
    confirmFactAsActor(serviceDeps(deps), actorOf(actor), {
      factId: input.factId,
      expectedRevision: input.expectedRevision,
    }),
  );
}

export async function correctMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactCorrectInput,
) {
  return runFactMutation(() =>
    correctFactAsActor(serviceDeps(deps), actorOf(actor), {
      factId: input.factId,
      expectedRevision: input.expectedRevision,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.literalValues !== undefined ? { literalValues: input.literalValues } : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }
        : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  );
}

export async function rejectMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactRejectInput,
) {
  return runFactMutation(() =>
    rejectFactAsActor(serviceDeps(deps), actorOf(actor), {
      factId: input.factId,
      expectedRevision: input.expectedRevision,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  );
}

export async function deleteMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactDeleteInput,
) {
  return runFactMutation(() =>
    deleteFactAsActor(serviceDeps(deps), actorOf(actor), {
      factId: input.factId,
      expectedRevision: input.expectedRevision,
    }),
  );
}

export async function promoteMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactPromoteInput,
) {
  // Promotion publishes a personal fact to every Space member: space-owner
  // authority plus the per-item action is the authorization.
  await requireSpaceOwner(deps.prisma, actor);
  return runFactMutation(() =>
    promoteFactAsActor(serviceDeps(deps), actorOf(actor), {
      factId: input.factId,
      expectedRevision: input.expectedRevision,
    }),
  );
}

export async function importLegacyMemoryFact(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactImportLegacyInput,
) {
  return runFactMutation(() =>
    importLegacyDocumentAsFact(serviceDeps(deps), actorOf(actor), {
      documentId: input.documentId,
      ...(input.text !== undefined ? { text: input.text } : {}),
    }),
  );
}

export async function listMemoryFactEvidence(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemoryFactEvidenceListInput,
) {
  // Audit-only surface: the fact must be visible to the actor first.
  const loaded = await getFactForActorWithEvidence(serviceDeps(deps), {
    actor: actorOf(actor),
    factId: input.factId,
  });
  if (!loaded) throw new ORPCError("NOT_FOUND");
  return loaded.evidence;
}

export async function getMemorySummary(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: MemorySummaryGetInput,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  const model = await loadMemoryInjectionReadModel(serviceDeps(deps), {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: input.botId,
  });
  return {
    available: model.summary !== null,
    stale: model.summaryStale,
    content: model.summary?.content ?? null,
    generatedAt: model.summary ? model.summary.generatedAt.toISOString() : null,
    summaryModel: model.summary?.summaryModel ?? null,
    promptVersion: model.summary?.promptVersion ?? null,
    tokenEstimate: model.summary?.tokenEstimate ?? null,
    shardVersions: model.shardVersions,
  };
}

export async function getSpaceMemoryPolicyRpc(deps: MemoryFactsApiDeps, actor: Actor) {
  return getSpaceMemoryPolicy(deps.prisma, actor.spaceId);
}

export async function setSpaceMemoryPolicyRpc(
  deps: MemoryFactsApiDeps,
  actor: Actor,
  input: { autoExtraction: "off" | "on" | "paused" },
) {
  await requireSpaceOwner(deps.prisma, actor);
  return setSpaceMemoryPolicy(deps.prisma, {
    spaceId: actor.spaceId,
    autoExtraction: input.autoExtraction,
    actorUserId: actor.userId,
  });
}

export { evidenceToDto };
