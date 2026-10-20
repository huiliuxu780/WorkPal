import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { canonicalKeyFor, memoryEvidenceDigest, deriveMemoryDigestKey } from "./memory-digest.js";
import {
  advanceExtractionCursor,
  claimMemoryOutboxJobs,
  completeMemoryOutboxJob,
  confirmFact,
  correctFact,
  countDistinctEvidenceThreads,
  createFact,
  deleteFact,
  failMemoryOutboxJob,
  findBlockingTombstone,
  getFactForActor,
  invalidateThreadMemoryEvidence,
  listAuthorizedFacts,
  listFactEvidence,
  listLegacyImportedDocumentIds,
  listShardsForScopes,
  loadValidContextSummary,
  memoryOutboxRetryDelay,
  memoryScopeKey,
  persistCompactionRevision,
  promoteFactToSpace,
  publishContextSummary,
  rebuildShardProfile,
  rejectFact,
  revertLegacyImport,
  type FactScope,
} from "./memory-facts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("memory facts three-layer repository (PostgreSQL)", () => {
  const base = randomUUID();
  const userA = `user-a-${base}`;
  const userB = `user-b-${base}`;
  const spaceId = `space-${base}`;
  const orgId = `org-${base}`;
  const digestKey = deriveMemoryDigestKey("test-encryption-key");
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadA: string;
  let threadB: string;

  const botScope = (): FactScope => ({ spaceId, scopeKind: "bot", scopeId: botId });
  const userScope = (userId: string): FactScope => ({
    spaceId,
    scopeKind: "user",
    scopeId: userId,
  });

  const evidence = (threadId: string, seq: number, content: string, authorUserId = userA) => ({
    threadId,
    threadGeneration: 0,
    messageId: `msg-${threadId}-${seq}`,
    messageSeq: seq,
    authorUserId,
    originKind: "human_web",
    evidenceType: "user_message",
    sourceDigest: memoryEvidenceDigest(digestKey, content),
  });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await prisma.user.createMany({
      data: [
        { id: userA, name: "A", email: `a-${base}@example.test`, emailVerified: true },
        { id: userB, name: "B", email: `b-${base}@example.test`, emailVerified: true },
      ],
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Facts", slug: `facts-${base}`, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: orgId, name: "Facts" } });
    await prisma.member.createMany({
      data: [
        { id: `m-a-${base}`, organizationId: orgId, userId: userA, role: "owner", createdAt: new Date() },
        { id: `m-b-${base}`, organizationId: orgId, userId: userB, role: "member", createdAt: new Date() },
      ],
    });
    await prisma.spaceMember.createMany({
      data: [
        {
          id: `sm-a-${base}`,
          spaceId,
          organizationId: orgId,
          userId: userA,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: `sm-b-${base}`,
          spaceId,
          organizationId: orgId,
          userId: userB,
          role: "member",
          createdAt: new Date(),
        },
      ],
    });
    botId = (
      await prisma.bot.create({ data: { spaceId, userId: userA, name: "Fact bot", color: "test" } })
    ).id;
    const bot2 = (
      await prisma.bot.create({ data: { spaceId, userId: userA, name: "Fact bot 2", color: "test" } })
    ).id;
    threadA = (await prisma.thread.create({ data: { spaceId, userId: userA, botId } })).id;
    threadB = (await prisma.thread.create({ data: { spaceId, userId: userA, botId: bot2 } })).id;
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.space.deleteMany({ where: { id: spaceId } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("activates an explicit user fact once and bumps the shard with outbox rows in the same transaction", async () => {
    const result = await createFact(prisma, {
      scope: botScope(),
      ownerUserId: userA,
      botId,
      kind: "explicit_preference",
      text: "Replies should stay under three paragraphs",
      origin: "user_direct",
      state: "active",
      actorUserId: userA,
      evidence: [evidence(threadA, 1, "please keep replies under three paragraphs")],
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.fact.state).toBe("active");
    expect(result.fact.revision).toBe(1);

    const shards = await listShardsForScopes(prisma, {
      spaceId,
      scopes: [{ scopeKind: "bot", scopeId: botId }],
    });
    expect(shards).toHaveLength(1);
    expect(shards[0]!.version).toBe(1);
    expect(shards[0]!.profileVersion).toBe(-1);

    const outbox = await prisma.memoryJobOutbox.findMany({ where: { spaceId } });
    const kinds = outbox.map((row) => row.kind).sort();
    expect(kinds).toEqual(["index_projection", "shard_profile_rebuild", "summary_rebuild"]);

    const evidenceRows = await listFactEvidence(prisma, { spaceId, factId: result.fact.id });
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]!.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dedupes the same proposition and corrects in place on a new explicit instruction", async () => {
    const scope = userScope(userA);
    const first = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      kind: "stable_fact",
      text: "The deploy host is alpha.example.com",
      origin: "user_direct",
      actorUserId: userA,
      evidence: [evidence(threadA, 2, "deploy host is alpha.example.com")],
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    // Case/whitespace/punctuation differences are the same canonical identity:
    // an idempotent re-statement that must not rewrite the stored surface form.
    const duplicate = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      kind: "stable_fact",
      text: "  the DEPLOY host is alpha.example.com. ",
      origin: "user_direct",
      actorUserId: userA,
      evidence: [evidence(threadA, 4, "yes alpha.example.com is the deploy host")],
    });
    expect(duplicate.status).toBe("duplicate");
    if (duplicate.status !== "duplicate") return;
    expect(duplicate.fact.text).toBe("The deploy host is alpha.example.com");
    expect(duplicate.fact.revision).toBe(1);
    expect(await listFactEvidence(prisma, { spaceId, factId: first.fact.id })).toHaveLength(2);

    // A genuinely different proposition is a new fact; the explicit supersede
    // link (used by corrections that replace the identity) is created below.
    const replacement = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      kind: "stable_fact",
      text: "The deploy host is beta.example.com",
      origin: "user_direct",
      actorUserId: userA,
      supersedesFactId: first.fact.id,
      evidence: [evidence(threadA, 3, "actually the deploy host moved to beta.example.com")],
    });
    expect(replacement.status).toBe("created");
    if (replacement.status !== "created") return;
    expect(replacement.fact.supersedesFactId).toBe(first.fact.id);
    const supersededOld = await prisma.memoryFact.findUniqueOrThrow({
      where: { id: first.fact.id },
    });
    expect(supersededOld.state).toBe("superseded");
    expect(supersededOld.revision).toBe(2);

    // In-place correction of the replacement keeps a full revision trail.
    const corrected = await correctFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId: replacement.fact.id,
      expectedRevision: 1,
      text: "The deploy host is gamma.example.com",
      reason: "user_correction",
    });
    expect(corrected.status).toBe("updated");
    if (corrected.status !== "updated") return;
    expect(corrected.fact.revision).toBe(2);
    expect(corrected.fact.canonicalKey).toBe(
      canonicalKeyFor("stable_fact", "The deploy host is gamma.example.com"),
    );
    const revisions = await prisma.memoryFactRevision.findMany({
      where: { factId: replacement.fact.id },
      orderBy: { revision: "asc" },
    });
    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions[1]!.reason).toBe("user_correction");

    // A stale expected revision is an actionable conflict, never a silent overwrite.
    const staleCorrection = await correctFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId: replacement.fact.id,
      expectedRevision: 1,
      text: "The deploy host is delta.example.com",
    });
    expect(staleCorrection.status).toBe("conflict");
  });

  it("enforces the active partial unique index at the database level", async () => {
    const scope = userScope(userA);
    const text = "Unique index probe fact";
    const first = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      kind: "workflow",
      text,
      origin: "user_direct",
      actorUserId: userA,
    });
    expect(first.status).toBe("created");
    await expect(
      prisma.memoryFact.create({
        data: {
          spaceId,
          ownerUserId: userA,
          scopeKind: scope.scopeKind,
          scopeKey: memoryScopeKey(scope.scopeKind, scope.scopeId),
          canonicalKey: canonicalKeyFor("workflow", text),
          kind: "workflow",
          text,
          origin: "user_direct",
          state: "active",
          createdBy: userA,
          lastChangedBy: userA,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("refuses model-candidate activation and never lets inference overwrite a user fact", async () => {
    const scope = botScope();
    await expect(
      createFact(prisma, {
        scope,
        ownerUserId: userA,
        botId,
        kind: "workflow",
        text: "Model tried to self-activate",
        origin: "model_candidate",
        state: "active",
        actorUserId: "service:extraction",
      }),
    ).rejects.toThrow(/must stay candidates/);

    const existing = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "User confirmed weekly report format",
      origin: "user_direct",
      actorUserId: userA,
    });
    expect(existing.status).toBe("created");
    if (existing.status !== "created") return;

    const inferred = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "User confirmed weekly report format",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
      evidence: [evidence(threadB, 1, "weekly report format again")],
    });
    expect(inferred.status).toBe("blocked_by_user_fact");

    // A candidate merges into an existing candidate instead of duplicating.
    const c1 = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "User tends to ask for a summary on fridays",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
      evidence: [evidence(threadA, 10, "friday summary please")],
    });
    expect(c1.status).toBe("created");
    const c2 = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "User tends to ask for a summary on Fridays",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
      evidence: [evidence(threadB, 11, "friday summary again")],
    });
    expect(c2.status).toBe("merged");
    if (c1.status !== "created") return;
    expect(await countDistinctEvidenceThreads(prisma, c1.fact.id)).toBe(2);
  });

  it("confirms and rejects candidates with expected-revision CAS", async () => {
    const scope = botScope();
    const created = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "explicit_preference",
      text: "Prefers tables over prose for status",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
      evidence: [evidence(threadA, 20, "can you make it a table")],
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    const factId = created.fact.id;

    const stale = await confirmFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: 99,
    });
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.currentRevision).toBe(1);

    const confirmed = await confirmFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: 1,
    });
    expect(confirmed.status).toBe("updated");
    if (confirmed.status !== "updated") return;
    expect(confirmed.fact.state).toBe("active");
    expect(confirmed.fact.origin).toBe("user_confirmed");

    const replay = await confirmFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: 2,
    });
    expect(replay.status).toBe("replayed");

    const second = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "explicit_preference",
      text: "Prefers morning digests",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
    });
    if (second.status !== "created") throw new Error("expected candidate creation");
    const rejected = await rejectFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId: second.fact.id,
      expectedRevision: 1,
      reason: "not accurate",
    });
    expect(rejected.status).toBe("updated");
    // Confirming a rejected fact is refused.
    const invalid = await confirmFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId: second.fact.id,
      expectedRevision: 2,
    });
    expect(invalid.status).toBe("invalid_state");

    // The rejected tombstone blocks re-recommendation from the same evidence.
    const blocking = await findBlockingTombstone(prisma, {
      spaceId,
      scopeKind: "bot",
      scopeId: botId,
      canonicalKey: canonicalKeyFor("explicit_preference", "Prefers morning digests"),
      evidenceDigests: [],
    });
    expect(blocking?.state).toBe("rejected");
    const notBlocking = await findBlockingTombstone(prisma, {
      spaceId,
      scopeKind: "bot",
      scopeId: botId,
      canonicalKey: canonicalKeyFor("explicit_preference", "Some brand new proposition"),
      evidenceDigests: [],
    });
    expect(notBlocking).toBeNull();
  });

  it("deletes with body purge, tombstone and visible cleanup outbox", async () => {
    const scope = userScope(userA);
    const created = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      kind: "stable_fact",
      text: "Temporary office wifi name is SECRET-DO-NOT-LEAK",
      literalValues: { ssid: "SECRET-DO-NOT-LEAK" },
      origin: "user_direct",
      actorUserId: userA,
    });
    if (created.status !== "created") throw new Error("expected creation");
    const factId = created.fact.id;

    await correctFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: 1,
      text: "Temporary office wifi name is SECRET-DO-NOT-LEAK v2",
    });

    const deleted = await deleteFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: 2,
    });
    expect(deleted.status).toBe("updated");

    const revisions = await prisma.memoryFactRevision.findMany({ where: { factId } });
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    for (const revision of revisions) {
      expect(revision.text).toBeNull();
      expect(revision.literalValues).toBeNull();
    }
    const row = await prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } });
    expect(row.state).toBe("deleted");
    expect(row.text).toBe("");
    expect(row.literalValues).toBeNull();

    const cleanup = await prisma.memoryJobOutbox.findFirst({
      where: { kind: "index_cleanup", targetId: factId },
    });
    expect(cleanup).not.toBeNull();

    // Deleted facts never appear on the read path.
    const facts = await listAuthorizedFacts(prisma, { spaceId, userId: userA });
    expect(facts.some((fact) => fact.id === factId)).toBe(false);

    // Deleting twice replays instead of erroring.
    const replay = await deleteFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId,
      expectedRevision: row.revision,
    });
    expect(replay.status).toBe("replayed");
  });

  it("keeps personal facts invisible to other users and promotes per item to space scope", async () => {
    const created = await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "stable_fact",
      text: "User A home office closes at 18:00",
      origin: "user_direct",
      actorUserId: userA,
    });
    if (created.status !== "created") throw new Error("expected creation");

    const visibleToB = await listAuthorizedFacts(prisma, { spaceId, userId: userB, botId });
    expect(visibleToB.some((fact) => fact.id === created.fact.id)).toBe(false);
    expect(await getFactForActor(prisma, { spaceId, userId: userB, factId: created.fact.id })).toBeNull();
    expect(await getFactForActor(prisma, { spaceId, userId: userA, factId: created.fact.id })).not.toBeNull();

    const promoted = await promoteFactToSpace(prisma, {
      spaceId,
      actorUserId: userA,
      factId: created.fact.id,
      expectedRevision: 1,
    });
    expect(promoted.status).toBe("updated");
    if (promoted.status !== "updated") return;
    expect(promoted.fact.scopeKind).toBe("space");
    expect(promoted.fact.promotionSourceFactId).toBe(created.fact.id);

    const visibleToBNow = await listAuthorizedFacts(prisma, { spaceId, userId: userB, botId });
    expect(visibleToBNow.some((fact) => fact.id === promoted.fact.id)).toBe(true);

    const replay = await promoteFactToSpace(prisma, {
      spaceId,
      actorUserId: userA,
      factId: created.fact.id,
      expectedRevision: 1,
    });
    expect(replay.status).toBe("replayed");
  });

  it("excludes expired facts from the read path but keeps them for management", async () => {
    const past = new Date(Date.now() - 60_000);
    const created = await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "stable_fact",
      text: "One-time verification code preference expired",
      origin: "user_direct",
      actorUserId: userA,
      expiresAt: past,
    });
    if (created.status !== "created") throw new Error("expected creation");
    const readable = await listAuthorizedFacts(prisma, { spaceId, userId: userA });
    expect(readable.some((fact) => fact.id === created.fact.id)).toBe(false);
    const management = await listAuthorizedFacts(prisma, {
      spaceId,
      userId: userA,
      includeExpired: true,
    });
    expect(management.some((fact) => fact.id === created.fact.id)).toBe(true);
  });

  it("rebuilds shard profiles with a version CAS so stale rebuilds cannot win", async () => {
    const shards = await listShardsForScopes(prisma, {
      spaceId,
      scopes: [{ scopeKind: "user", scopeId: userA }],
    });
    expect(shards).toHaveLength(1);
    const shardId = shards[0]!.id;

    const first = await rebuildShardProfile(prisma, shardId);
    expect(first.rebuilt).toBe(true);
    const shard = await prisma.memoryShard.findUniqueOrThrow({ where: { id: shardId } });
    expect(shard.profileVersion).toBe(shard.version);
    expect(shard.profileMarkdown).toContain("deploy host is gamma.example.com");

    // A concurrent fact change bumps the version; the stale rebuild loses.
    await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "workflow",
      text: "Another workflow fact for CAS probe",
      origin: "user_direct",
      actorUserId: userA,
    });
    const staleRebuild = await prisma.memoryShard.updateMany({
      where: { id: shardId, version: shard.version },
      data: { profileMarkdown: "stale projection", profileVersion: shard.version },
    });
    expect(staleRebuild.count).toBe(0);
    const fresh = await rebuildShardProfile(prisma, shardId);
    expect(fresh.rebuilt).toBe(true);
    const after = await prisma.memoryShard.findUniqueOrThrow({ where: { id: shardId } });
    expect(after.profileMarkdown).toContain("Another workflow fact for CAS probe");
  });

  it("publishes summaries only for exact shard versions and refuses stale reads", async () => {
    const shards = await listShardsForScopes(prisma, {
      spaceId,
      scopes: [
        { scopeKind: "user", scopeId: userA },
        { scopeKind: "bot", scopeId: botId },
      ],
    });
    const versions: Record<string, number> = {};
    for (const shard of shards) versions[shard.id] = shard.version;

    const published = await publishContextSummary(prisma, {
      spaceId,
      recipientUserId: userA,
      recipientBotId: botId,
      sourceVersions: versions,
      content: "User A prefers short replies; deploy host is gamma.",
      summaryModel: "test/summary-model",
      promptVersion: "auxiliary/memory-summary@v1",
      tokenEstimate: 42,
    });
    expect(published.status).toBe("ready");

    const valid = await loadValidContextSummary(prisma, {
      spaceId,
      recipientUserId: userA,
      recipientBotId: botId,
      currentShardVersions: versions,
    });
    expect(valid?.stale).toBe(false);

    // Any shard change makes the summary stale instead of injecting it.
    const bumped = { ...versions, [shards[0]!.id]: shards[0]!.version + 1 };
    const stale = await loadValidContextSummary(prisma, {
      spaceId,
      recipientUserId: userA,
      recipientBotId: botId,
      currentShardVersions: bumped,
    });
    expect(stale?.stale).toBe(true);

    // A permission-scope change (missing shard) also refuses the summary.
    const partial = { [shards[0]!.id]: shards[0]!.version };
    const partialRead = await loadValidContextSummary(prisma, {
      spaceId,
      recipientUserId: userA,
      recipientBotId: botId,
      currentShardVersions: partial,
    });
    expect(partialRead?.stale).toBe(true);
  });

  it("claims outbox jobs with SKIP LOCKED, completes by delete and retries visibly on failure", async () => {
    const claimed = await claimMemoryOutboxJobs(prisma, { workerId: "w1", limit: 100 });
    expect(claimed.length).toBeGreaterThan(0);
    // A second claimer cannot steal the same rows.
    const second = await claimMemoryOutboxJobs(prisma, { workerId: "w2", limit: 100 });
    expect(second.length).toBe(0);

    const [job] = claimed;
    await completeMemoryOutboxJob(prisma, job!.id);
    expect(await prisma.memoryJobOutbox.count({ where: { id: job!.id } })).toBe(0);

    const [retryJob] = claimed.slice(1);
    if (retryJob) {
      await failMemoryOutboxJob(prisma, {
        jobId: retryJob.id,
        error: "provider unreachable",
        nextAttemptAt: new Date(Date.now() + memoryOutboxRetryDelay(retryJob.attempts)),
      });
      const row = await prisma.memoryJobOutbox.findUniqueOrThrow({ where: { id: retryJob.id } });
      expect(row.lastError).toBe("provider unreachable");
      expect(row.claimedBy).toBeNull();
      expect(row.attempts).toBe(1);
    }
    await prisma.memoryJobOutbox.deleteMany({ where: { spaceId } });
  });

  it("advances extraction cursors only for the expected generation and watermark", async () => {
    const advanced = await prisma.$transaction((tx) =>
      advanceExtractionCursor(tx, {
        spaceId,
        userId: userA,
        botId,
        threadId: threadA,
        expectedGeneration: 0,
        expectedWatermark: -1,
        newWatermark: 10,
      }),
    );
    expect(advanced).toBe(true);
    const late = await prisma.$transaction((tx) =>
      advanceExtractionCursor(tx, {
        spaceId,
        userId: userA,
        botId,
        threadId: threadA,
        expectedGeneration: 0,
        expectedWatermark: -1,
        newWatermark: 50,
      }),
    );
    expect(late).toBe(false);
    const wrongGeneration = await prisma.$transaction((tx) =>
      advanceExtractionCursor(tx, {
        spaceId,
        userId: userA,
        botId,
        threadId: threadA,
        expectedGeneration: 1,
        expectedWatermark: 10,
        newWatermark: 50,
      }),
    );
    expect(wrongGeneration).toBe(false);
    const cursor = await prisma.memoryExtractionCursor.findUniqueOrThrow({
      where: { threadId: threadA },
    });
    expect(cursor.highWatermarkSeq).toBe(10);
  });

  it("invalidates evidence on thread clear, removes orphan candidates and keeps confirmed facts", async () => {
    const scope = botScope();
    const candidate = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "Candidate only backed by thread B evidence",
      origin: "model_candidate",
      state: "candidate",
      actorUserId: "service:extraction",
      evidence: [evidence(threadB, 30, "candidate source message")],
    });
    if (candidate.status !== "created") throw new Error("expected candidate");
    const confirmed = await createFact(prisma, {
      scope,
      ownerUserId: userA,
      botId,
      kind: "workflow",
      text: "Confirmed fact with thread B source",
      origin: "user_confirmed",
      state: "active",
      actorUserId: userA,
      evidence: [evidence(threadB, 31, "confirmed source message")],
    });
    if (confirmed.status !== "created") throw new Error("expected confirmed fact");

    const result = await prisma.$transaction((tx) =>
      invalidateThreadMemoryEvidence(tx, { threadId: threadB, newGeneration: 1 }),
    );
    expect(result.removedCandidateIds).toEqual([candidate.fact.id]);

    const surviving = await prisma.memoryFact.findUnique({ where: { id: confirmed.fact.id } });
    expect(surviving?.state).toBe("active");
    const confirmedEvidence = await listFactEvidence(prisma, {
      spaceId,
      factId: confirmed.fact.id,
    });
    expect(confirmedEvidence.every((row) => row.accessible === false)).toBe(true);
  });

  it("persists compaction revisions as an auditable chain with generation CAS", async () => {
    const first = await persistCompactionRevision(prisma, {
      threadId: threadA,
      expectedCursor: null,
      expectedGeneration: 0,
      fromSeqExclusive: -1,
      toSeqInclusive: 49,
      summary: "First summary",
      inputDigest: "digest-1",
      sourceRunId: "run-1",
      modelProvider: "openrouter",
      modelId: "test/model",
      promptVersion: "auxiliary/history-compaction@v1",
    });
    expect(first.advanced).toBe(true);
    const second = await persistCompactionRevision(prisma, {
      threadId: threadA,
      expectedCursor: 49,
      expectedGeneration: 0,
      fromSeqExclusive: 49,
      toSeqInclusive: 99,
      summary: "Second summary",
      inputDigest: "digest-2",
      sourceRunId: "run-2",
      modelProvider: "openrouter",
      modelId: "test/model",
      promptVersion: "auxiliary/history-compaction@v1",
    });
    expect(second.advanced).toBe(true);

    // A late job from a cleared generation cannot advance the cursor.
    const cleared = await persistCompactionRevision(prisma, {
      threadId: threadA,
      expectedCursor: 99,
      expectedGeneration: 1,
      fromSeqExclusive: 99,
      toSeqInclusive: 149,
      summary: "Late summary",
      inputDigest: "digest-3",
      modelProvider: "openrouter",
      modelId: "test/model",
      promptVersion: "auxiliary/history-compaction@v1",
    });
    expect(cleared.advanced).toBe(false);

    const revisions = await prisma.threadCompactionRevision.findMany({
      where: { threadId: threadA },
      orderBy: { toSeqInclusive: "asc" },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[1]!.previousRevisionId).toBe(revisions[0]!.id);
    expect(revisions[0]!.includesToolResults).toBe(false);
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadA } });
    expect(thread.historyCompactedUpToSeq).toBe(99);
    expect(thread.historyCompactionSummary).toBe("Second summary");
  });

  it("tracks legacy-imported documents so the assembler never injects them twice", async () => {
    const doc = await prisma.memoryDocument.create({
      data: { spaceId, userId: userA, scope: "user", path: "LEGACY.md", content: "old note" },
    });
    expect((await listLegacyImportedDocumentIds(prisma, { spaceId })).has(doc.id)).toBe(false);
    const imported = await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "legacy_document",
      text: "old note",
      origin: "legacy_import",
      actorUserId: userA,
      sourceDocumentId: doc.id,
    });
    expect(imported.status).toBe("created");
    expect((await listLegacyImportedDocumentIds(prisma, { spaceId })).has(doc.id)).toBe(true);
    if (imported.status !== "created") return;

    // Review P1-2: DELETING the imported fact must NOT resurrect the legacy
    // document — "delete this memory" means gone, not "fall back to the old
    // injection path".
    await deleteFact(prisma, {
      spaceId,
      actorUserId: userA,
      factId: imported.fact.id,
      expectedRevision: 1,
    });
    expect((await listLegacyImportedDocumentIds(prisma, { spaceId })).has(doc.id)).toBe(true);

    // Only the explicit revert separates the two semantics: undo the import
    // and the document becomes the legacy-format entry again.
    const secondImport = await createFact(prisma, {
      scope: botScope(),
      ownerUserId: userA,
      botId,
      kind: "legacy_document",
      text: "bot legacy note",
      origin: "legacy_import",
      actorUserId: userA,
      sourceDocumentId: doc.id,
    });
    if (secondImport.status !== "created") throw new Error("expected second import");
    const reverted = await revertLegacyImport(prisma, {
      spaceId,
      actorUserId: userA,
      factId: secondImport.fact.id,
      expectedRevision: 1,
    });
    expect(reverted.status).toBe("updated");
    if (reverted.status !== "updated") return;
    expect(reverted.fact.state).toBe("reverted");
    expect(reverted.fact.text).toBe("");

    // The first (deleted) import still blocks; the reverted one no longer
    // does — with both facts on the same document the block set is decided
    // per document by ANY non-reverted import, so re-check with a fresh doc.
    const doc2 = await prisma.memoryDocument.create({
      data: { spaceId, userId: userA, scope: "user", path: "LEGACY2.md", content: "second note" },
    });
    const import2 = await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "legacy_document",
      text: "second note",
      origin: "legacy_import",
      actorUserId: userA,
      sourceDocumentId: doc2.id,
    });
    if (import2.status !== "created") throw new Error("expected import2");
    expect((await listLegacyImportedDocumentIds(prisma, { spaceId })).has(doc2.id)).toBe(true);
    await revertLegacyImport(prisma, {
      spaceId,
      actorUserId: userA,
      factId: import2.fact.id,
      expectedRevision: 1,
    });
    expect((await listLegacyImportedDocumentIds(prisma, { spaceId })).has(doc2.id)).toBe(false);

    // Revert guards: stale revision is an actionable conflict, and non-import
    // facts cannot be "reverted".
    const conflict = await revertLegacyImport(prisma, {
      spaceId,
      actorUserId: userA,
      factId: secondImport.fact.id,
      expectedRevision: 1,
    });
    expect(conflict.status).toBe("conflict");
    const plain = await createFact(prisma, {
      scope: userScope(userA),
      ownerUserId: userA,
      kind: "stable_fact",
      text: "Plain fact is not an import",
      origin: "user_direct",
      actorUserId: userA,
    });
    if (plain.status !== "created") throw new Error("expected plain fact");
    const invalid = await revertLegacyImport(prisma, {
      spaceId,
      actorUserId: userA,
      factId: plain.fact.id,
      expectedRevision: 1,
    });
    expect(invalid.status).toBe("invalid_state");
  });
});
