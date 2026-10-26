import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardMessageFact, projectThreadCardSurface } from "./card-interactions.js";
import { createDb, type PrismaClient } from "./client.js";
import { pauseRunForInput, resolveIntervention } from "./events.js";
import { loadInterventionViews } from "./interventions.js";
import { outboundDraftFingerprint, updateOutboundDraftRevision } from "./outbound-drafts.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const TX = { timeout: 20_000, maxWait: 20_000 } as const;

describePostgres("A10 outbound draft revisions (PostgreSQL)", () => {
  const id = randomUUID();
  const otherUserId = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let side: PrismaClient;
  let botId: string;
  let threadId: string;
  let sequence = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("outbound_drafts");
    prisma = isolated.db.prisma;
    const connectionString = isolated.db.pool.options.connectionString;
    if (!connectionString) throw new Error("isolated pool is missing its connection string");
    side = createDb(connectionString, { applicationName: "outbound_side", poolMax: 4 }).prisma;
    await prisma.user.create({
      data: { id, name: "Outbound owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        name: "Outbound other",
        email: `${otherUserId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Outbound test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Outbound test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Outbound bot", color: "test" },
    });
    botId = bot.id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
  }, 180_000);

  afterAll(async () => {
    await side?.$disconnect().catch(() => undefined);
    await isolated?.drop();
  }, 60_000);

  async function seedOutbound(
    request: Record<string, unknown> = {
      to: ["ada@example.test"],
      subject: "Weekly digest",
      text: "Original body",
    },
    kind = "send_email",
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: `outbound ${++sequence}`,
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: run.id,
        kind,
        idempotencyKey: `outbound-${run.id}`,
        status: "intended",
        request: request as never,
      },
    });
    const paused = await pauseRunForInput(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      blocks: [
        {
          kind: "ask",
          text: "Review before send_email",
          detail: "to: ada@example.test\nsubject: Weekly digest\nbody: Original body",
          status: "pending",
          approvalEffectId: effect.id,
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    expect(paused).toBe(true);
    const intervention = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    return { run, effect, intervention };
  }

  async function surfaceFor(runId: string) {
    return prisma.$transaction(async (tx) => {
      const messages = await tx.message.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
      });
      const views = await loadInterventionViews(
        tx,
        threadId,
        messages.map((row) => ({ id: row.id, runId: row.runId, blocks: row.blocks })),
        [runId],
      );
      return projectThreadCardSurface({
        spaceId: id,
        threadId,
        messages: messages.map((row) =>
          cardMessageFact(
            {
              id: row.id,
              threadId: row.threadId,
              botId: row.botId ?? undefined,
              runId: row.runId ?? undefined,
              createdAt: row.createdAt.toISOString(),
              blocks: row.blocks as never,
            },
            id,
          ),
        ),
        interventions: views,
        runs: [],
      });
    }, TX);
  }

  function outboundInteraction(surface: Awaited<ReturnType<typeof surfaceFor>>) {
    const interaction = surface.interactions.find(
      (view) => view.kind === "action_approval" && view.approval.kind === "outbound",
    );
    if (!interaction || interaction.kind !== "action_approval") {
      throw new Error("outbound interaction missing");
    }
    if (interaction.approval.kind !== "outbound") throw new Error("outbound payload missing");
    return interaction.approval;
  }

  it("projects the effect request as r1 and only the latest saved revision as pending", async () => {
    const { run, intervention } = await seedOutbound();
    const initial = outboundInteraction(await surfaceFor(run.id));
    expect(initial.draftState?.draft).toMatchObject({
      revision: 1,
      recipients: ["ada@example.test"],
      subject: "Weekly digest",
      body: "Original body",
    });
    expect(initial.draftState?.revisions).toEqual([
      expect.objectContaining({ revision: 1, status: "pending" }),
    ]);
    expect(initial.fingerprint).toBe(outboundDraftFingerprint(initial.draftState!.draft));

    const saved = await updateOutboundDraftRevision(prisma, {
      spaceId: id,
      threadId,
      userId: id,
      interventionId: intervention.id,
      expectedRevision: 1,
      recipients: ["ada@example.test", "lin@example.test"],
      subject: "Weekly digest r2",
      body: "Edited body",
    });
    expect(saved).toMatchObject({ outcome: "updated" });
    if (saved.outcome !== "updated") return;
    expect(saved.state.draft).toMatchObject({
      revision: 2,
      subject: "Weekly digest r2",
      body: "Edited body",
    });

    const projected = outboundInteraction(await surfaceFor(run.id));
    expect(projected.draftState?.draft.revision).toBe(2);
    expect(projected.draftState?.revisions.map((entry) => entry.status)).toEqual([
      "superseded",
      "pending",
    ]);
    expect(projected.draftState?.revisions[0]).toMatchObject({
      revision: 1,
      subject: "Weekly digest",
      status: "superseded",
    });
    expect(projected.draftState?.draft.body).toBe("Edited body");
    expect(projected.recipientCount).toBe(2);
    expect(projected.fingerprint).toBe(saved.state.draft.fingerprint);
  });

  it("saves immutably, moves the effect request, and rejects stale or foreign edits", async () => {
    const { run, effect, intervention } = await seedOutbound();
    const first = await updateOutboundDraftRevision(prisma, {
      spaceId: id,
      threadId,
      userId: id,
      interventionId: intervention.id,
      expectedRevision: 1,
      recipients: ["ada@example.test"],
      subject: "Weekly digest r2",
      body: "Edited body",
    });
    expect(first.outcome).toBe("updated");
    const second = await updateOutboundDraftRevision(prisma, {
      spaceId: id,
      threadId,
      userId: id,
      interventionId: intervention.id,
      expectedRevision: 2,
      recipients: ["ada@example.test"],
      subject: "Weekly digest r3",
      body: "Edited body again",
    });
    expect(second.outcome).toBe("updated");
    expect(
      await prisma.outboundDraftRevision.findMany({
        where: { interventionId: intervention.id },
        orderBy: { revision: "asc" },
        select: { revision: true, subject: true },
      }),
    ).toEqual([
      { revision: 1, subject: "Weekly digest" },
      { revision: 2, subject: "Weekly digest r2" },
      { revision: 3, subject: "Weekly digest r3" },
    ]);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).request,
    ).toEqual({
      to: ["ada@example.test"],
      subject: "Weekly digest r3",
      text: "Edited body again",
    });
    const message = await prisma.message.findFirstOrThrow({
      where: { runId: run.id, role: "bot" },
    });
    expect(JSON.stringify(message.blocks)).toContain("body: Edited body again");
    expect(
      await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } }),
    ).toMatchObject({
      presentation: expect.objectContaining({
        detail: expect.stringContaining("Edited body again"),
      }),
    });
    expect(
      await prisma.event.count({
        where: { runId: run.id, type: "thread.message.updated" },
      }),
    ).toBe(2);

    await expect(
      updateOutboundDraftRevision(prisma, {
        spaceId: id,
        threadId,
        userId: id,
        interventionId: intervention.id,
        expectedRevision: 1,
        recipients: ["ada@example.test"],
        subject: "Stale",
        body: "Stale",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
    await expect(
      updateOutboundDraftRevision(prisma, {
        spaceId: id,
        threadId,
        userId: otherUserId,
        interventionId: intervention.id,
        expectedRevision: 3,
        recipients: ["ada@example.test"],
        subject: "Foreign",
        body: "Foreign",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "forbidden" });
    await expect(
      updateOutboundDraftRevision(prisma, {
        spaceId: randomUUID(),
        threadId,
        userId: id,
        interventionId: intervention.id,
        expectedRevision: 3,
        recipients: ["ada@example.test"],
        subject: "Wrong space",
        body: "Wrong space",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "not_found" });
  });

  it("ignores non-email effects and rejects edits after the card settles", async () => {
    const tool = await seedOutbound({ token: "opaque" }, "tool");
    const toolSurface = await surfaceFor(tool.run.id);
    expect(
      toolSurface.interactions.some(
        (view) =>
          view.kind === "action_approval" &&
          view.approval.kind === "outbound" &&
          view.source.runId === tool.run.id,
      ),
    ).toBe(false);
    await expect(
      updateOutboundDraftRevision(prisma, {
        spaceId: id,
        threadId,
        userId: id,
        interventionId: tool.intervention.id,
        expectedRevision: 1,
        recipients: ["ada@example.test"],
        subject: "Nope",
        body: "Nope",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "not_found" });

    const { intervention } = await seedOutbound();
    const resolved = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: intervention.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "deny",
    });
    expect(resolved.outcome).toBe("accepted");
    await expect(
      updateOutboundDraftRevision(prisma, {
        spaceId: id,
        threadId,
        userId: id,
        interventionId: intervention.id,
        expectedRevision: 1,
        recipients: ["ada@example.test"],
        subject: "After settle",
        body: "After settle",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
  });

  it("binds an approving decision to the latest revision after an edit", async () => {
    const { intervention } = await seedOutbound();
    const initial = await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } });
    const r1Fingerprint = outboundDraftFingerprint({
      recipients: ["ada@example.test"],
      subject: "Weekly digest",
      body: "Original body",
    });
    expect(initial.status).toBe("pending");

    const saved = await updateOutboundDraftRevision(prisma, {
      spaceId: id,
      threadId,
      userId: id,
      interventionId: intervention.id,
      expectedRevision: 1,
      recipients: ["ada@example.test"],
      subject: "Weekly digest r2",
      body: "Edited body",
    });
    if (saved.outcome !== "updated") throw new Error("edit failed");

    await expect(
      resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: intervention.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: "allow",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
    await expect(
      resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: intervention.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: "allow",
        outbound: { revision: 1, fingerprint: r1Fingerprint },
      }),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });

    const accepted = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: intervention.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "allow",
      outbound: { revision: 2, fingerprint: saved.state.draft.fingerprint },
    });
    expect(accepted.outcome).toBe("accepted");
    if (accepted.outcome === "accepted") {
      expect(accepted.intervention.approval?.decision).toBe("approved");
    }
  });

  it("keeps a denial available without a revision binding after an edit", async () => {
    const { intervention } = await seedOutbound();
    const saved = await updateOutboundDraftRevision(prisma, {
      spaceId: id,
      threadId,
      userId: id,
      interventionId: intervention.id,
      expectedRevision: 1,
      recipients: ["ada@example.test"],
      subject: "Weekly digest r2",
      body: "Edited body",
    });
    expect(saved.outcome).toBe("updated");
    const denied = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: intervention.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "deny",
    });
    expect(denied.outcome).toBe("accepted");
    if (denied.outcome === "accepted") {
      expect(denied.intervention.approval?.decision).toBe("denied");
    }
  });
});
