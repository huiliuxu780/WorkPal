import { randomUUID } from "node:crypto";
import type { ActionApprovalView, MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import { cardMessageFact, projectThreadCardSurface } from "./card-interactions.js";
import type { PrismaClient } from "./client.js";
import { pauseRunForGroupMembership, resolveIntervention } from "./events.js";
import {
  inspectGroupMembershipTarget,
  loadGroupMembershipApprovalFacts,
  recordGroupMembershipFailureInTransaction,
} from "./group-membership.js";
import { cancelPendingInterventions, loadInterventionViews } from "./interventions.js";
import { createThreadMessageInTransaction } from "./messages.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const TX = { timeout: 20_000, maxWait: 20_000 } as const;

describePostgres("RT-12 group membership approval (PostgreSQL)", () => {
  const ownerId = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let joy: { id: string; name: string };
  let purple: { id: string; name: string };
  let joyThreadId: string;
  let group: { id: string; threadId: string; name: string };
  let deliverySeq = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("rt12_group_membership");
    prisma = isolated.db.prisma;
    const spaceId = ownerId;
    await prisma.user.create({
      data: {
        id: ownerId,
        name: "RT12 owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: ownerId, name: "RT12 org", slug: ownerId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId: ownerId, name: "RT12 space" },
    });
    await prisma.member.create({
      data: {
        id: ownerId,
        organizationId: ownerId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: ownerId,
        spaceId,
        organizationId: ownerId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const makeBot = async (name: string) => {
      const bot = await prisma.bot.create({
        data: { spaceId, userId: ownerId, name, color: "test" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId, userId: ownerId, botId: bot.id },
      });
      return { id: bot.id, name: bot.name, threadId: thread.id };
    };
    const joyBot = await makeBot("Joy");
    const purpleBot = await makeBot("Purple");
    const blueBot = await makeBot("Blue");
    joy = { id: joyBot.id, name: joyBot.name };
    purple = { id: purpleBot.id, name: purpleBot.name };
    joyThreadId = joyBot.threadId;
    const createdGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: ownerId, kind: CHAT_GROUP_KIND_STANDARD, name: "新版发布圆桌" },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, groupId: createdGroup.id },
    });
    await prisma.chatGroupMember.createMany({
      data: [
        { groupId: createdGroup.id, botId: blueBot.id },
        { groupId: createdGroup.id, botId: purpleBot.id },
      ],
    });
    group = { id: createdGroup.id, threadId: groupThread.id, name: createdGroup.name };
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  function nextKey() {
    deliverySeq += 1;
    return `rt12-${deliverySeq}`;
  }

  async function createSourceRun() {
    const task = await prisma.task.create({
      data: {
        spaceId: ownerId,
        botId: joy.id,
        threadId: joyThreadId,
        userId: ownerId,
        prompt: "Take the performance risk review to the group.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: ownerId,
        botId: joy.id,
        threadId: joyThreadId,
        taskId: task.id,
        userId: ownerId,
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
    const userMessage = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: joyThreadId,
        role: "user",
        originKind: "human_web",
        authorUserId: ownerId,
        blocks: [{ kind: "text", text: "Go to the group." }],
        botId: joy.id,
        runId: run.id,
      }),
    );
    await prisma.run.update({ where: { id: run.id }, data: { sourceMessageId: userMessage.id } });
    return { runId: run.id, attemptId: attempt.id, sourceMessageId: userMessage.id };
  }

  async function pause(
    source: { runId: string; attemptId: string },
    key: string,
    message = "Check the launch performance risk and report back.",
  ) {
    return pauseRunForGroupMembership(prisma, {
      spaceId: ownerId,
      threadId: joyThreadId,
      botId: joy.id,
      runId: source.runId,
      attemptId: source.attemptId,
      leaseOwner: "worker",
      leaseFence: 1,
      groupId: group.id,
      botName: joy.name,
      message,
      topic: "性能风险核对",
      deliveryKey: key,
    });
  }

  async function resolve(
    interventionId: string,
    source: { runId: string },
    answer: "approve" | "deny",
    submissionId = randomUUID(),
    requestRevision = 1,
  ) {
    return resolveIntervention(
      prisma,
      {
        spaceId: ownerId,
        threadId: joyThreadId,
        interventionId,
        clientSubmissionId: submissionId,
        answeredByUserId: ownerId,
        answer,
        requestRevision,
      },
      undefined,
      undefined,
      { cardsUnifiedV2: true },
    );
  }

  async function factsFor() {
    return prisma.$transaction(async (tx) => {
      const messages = await tx.message.findMany({ where: { threadId: joyThreadId } });
      const facts = await loadGroupMembershipApprovalFacts(tx, {
        spaceId: ownerId,
        userId: ownerId,
        threadId: joyThreadId,
        messageIds: messages.map((row) => row.id),
        recentRunIds: [],
      });
      const views = await loadInterventionViews(
        tx,
        joyThreadId,
        messages.map((row) => ({ id: row.id, runId: row.runId, blocks: row.blocks })),
        [],
      );
      const surface = projectThreadCardSurface({
        spaceId: ownerId,
        threadId: joyThreadId,
        messages: messages.map((row) =>
          cardMessageFact(
            {
              id: row.id,
              threadId: row.threadId,
              botId: row.botId ?? undefined,
              runId: row.runId ?? undefined,
              createdAt: row.createdAt.toISOString(),
              blocks: row.blocks as MessageBlock[],
            },
            ownerId,
          ),
        ),
        interventions: views,
        runs: [],
        groupMembershipApprovals: facts,
      });
      return { facts, surface };
    }, TX);
  }

  async function targetWork(runId: string) {
    const targetRuns = await prisma.run.findMany({
      where: { originRunId: runId, trigger: "message_group" },
      select: { id: true },
    });
    const messages = targetRuns.length
      ? await prisma.message.count({ where: { runId: { in: targetRuns.map((run) => run.id) } } })
      : 0;
    const members = await prisma.chatGroupMember.count({
      where: { groupId: group.id, botId: joy.id },
    });
    return { runs: targetRuns.length, messages, members };
  }

  it("pauses on a scoped approval without touching the target group", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const paused = await pause(source, key);
    expect(paused.outcome).toBe("paused");
    if (paused.outcome !== "paused") return;

    const run = await prisma.run.findUniqueOrThrow({ where: { id: source.runId } });
    expect(run.status).toBe("waiting_input");
    expect(run.waitKind).toBe("approval");

    const request = await prisma.groupMembershipRequest.findUniqueOrThrow({
      where: { interventionId: paused.interventionId },
    });
    expect(request).toMatchObject({
      spaceId: ownerId,
      userId: ownerId,
      botId: joy.id,
      groupId: group.id,
      groupName: group.name,
      sourceThreadId: joyThreadId,
      sourceRunId: source.runId,
      requestMessageId: source.sourceMessageId,
      cardMessageId: paused.messageId,
      deliveryKey: key,
      requestRevision: 1,
      message: "Check the launch performance risk and report back.",
      topic: "性能风险核对",
      targetRunId: null,
      targetMessageId: null,
      receiptMessageId: null,
    });
    expect(request.presentation).toMatchObject({ text: expect.stringContaining(group.name) });

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention).toMatchObject({
      kind: "approval",
      status: "pending",
      effectId: null,
      runId: source.runId,
      messageId: paused.messageId,
    });
    expect(intervention.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    const ask = await prisma.message.findUniqueOrThrow({ where: { id: paused.messageId } });
    const askBlock = (ask.blocks as MessageBlock[]).find((block) => block.kind === "ask");
    expect(askBlock).toMatchObject({ status: "pending", interventionId: paused.interventionId });
    if (askBlock?.kind === "ask") {
      expect(askBlock.actions?.map((action) => action.id)).toEqual(["approve", "deny"]);
    }

    const work = await targetWork(source.runId);
    expect(work).toEqual({ runs: 0, messages: 0, members: 0 });

    const { facts, surface } = await factsFor();
    const fact = facts.find((item) => item.interactionId === paused.interventionId);
    expect(fact).toMatchObject({
      messageGroupRequestId: request.id,
      requestRevision: 1,
      status: "pending",
      canManageMembers: true,
      sourceMessageId: paused.messageId,
    });
    const card = surface.interactions.find(
      (view) => view.interactionId === paused.interventionId,
    ) as ActionApprovalView | undefined;
    expect(card?.kind).toBe("action_approval");
    expect(card?.status).toBe("pending");
    if (card?.kind === "action_approval") {
      expect(card.approval.kind).toBe("group_membership");
    }
  });

  it("approves once: joins, delivers, returns, and settles the same card", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const paused = await pause(source, key);
    if (paused.outcome !== "paused") throw new Error("pause failed");
    const submissionId = randomUUID();
    const userMessagesBefore = await prisma.message.count({
      where: { threadId: joyThreadId, role: "user" },
    });

    const result = await resolve(paused.interventionId, source, "approve", submissionId);
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.applied).toBe(true);
    expect(result.resume).toBe(true);
    expect(result.membershipDelivery?.targetRunId).toBeTruthy();

    const member = await prisma.chatGroupMember.findUnique({
      where: { groupId_botId: { groupId: group.id, botId: joy.id } },
    });
    expect(member).not.toBeNull();

    const targetRun = await prisma.run.findUniqueOrThrow({
      where: { id: result.membershipDelivery!.targetRunId },
    });
    expect(targetRun).toMatchObject({
      threadId: group.threadId,
      trigger: "message_group",
      originThreadId: joyThreadId,
      originRunId: source.runId,
      status: "queued",
    });
    const targetMessage = await prisma.message.findFirstOrThrow({
      where: { threadId: group.threadId, runId: targetRun.id },
    });
    expect(targetMessage.blocks).toMatchObject([
      { kind: "text", text: "Check the launch performance risk and report back." },
    ]);

    const receipt = await prisma.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: joyThreadId,
          clientNonce: `group-message:${key}`,
        },
      },
    });
    expect(receipt.blocks).toMatchObject([
      { kind: "collaboration_receipt", state: "sent", destination: { kind: "group_message" } },
    ]);
    expect(targetRun.originMessageId).toBe(receipt.id);

    const request = await prisma.groupMembershipRequest.findUniqueOrThrow({
      where: { id: paused.requestId },
    });
    expect(request).toMatchObject({
      targetRunId: targetRun.id,
      targetMessageId: targetMessage.id,
      receiptMessageId: receipt.id,
    });

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention).toMatchObject({ status: "answered", decision: "approved", revision: 2 });
    const submission = await prisma.interventionSubmission.findUnique({
      where: {
        interventionId_clientSubmissionId: {
          interventionId: paused.interventionId,
          clientSubmissionId: submissionId,
        },
      },
    });
    expect(submission).not.toBeNull();

    const run = await prisma.run.findUniqueOrThrow({ where: { id: source.runId } });
    expect(run).toMatchObject({ status: "queued", waitKind: null });
    // Approval continues the same Run; it never becomes a new user chat turn.
    expect(await prisma.message.count({ where: { threadId: joyThreadId, role: "user" } })).toBe(
      userMessagesBefore,
    );

    const ask = await prisma.message.findUniqueOrThrow({ where: { id: paused.messageId } });
    expect((ask.blocks as MessageBlock[])[0]).toMatchObject({
      kind: "ask",
      status: "answered",
      answer: "approve",
    });

    const { facts, surface } = await factsFor();
    const fact = facts.find((item) => item.interactionId === paused.interventionId);
    expect(fact).toMatchObject({ status: "answered", decision: "approved", revision: 2 });
    const card = surface.interactions.find(
      (view) => view.interactionId === paused.interventionId,
    ) as ActionApprovalView | undefined;
    expect(card?.status).toBe("answered");
    expect(card?.decision).toBe("approved");

    const replay = await resolve(paused.interventionId, source, "approve", submissionId);
    expect(replay.outcome).toBe("accepted");
    if (replay.outcome === "accepted") {
      expect(replay.applied).toBe(false);
      expect(replay.membershipDelivery).toBeUndefined();
    }
    const duplicate = await resolve(paused.interventionId, source, "approve");
    expect(duplicate.outcome).toBe("already_handled");
    const targetRuns = await prisma.run.count({
      where: { originRunId: source.runId, trigger: "message_group" },
    });
    expect(targetRuns).toBe(1);
    expect(
      await prisma.chatGroupMember.count({ where: { groupId: group.id, botId: joy.id } }),
    ).toBe(1);
    // Later cases assert the pre-decision state; this case owns the one join.
    await prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: joy.id } });
  });

  it("denies without joining, delivering, or creating target work", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const paused = await pause(source, key);
    if (paused.outcome !== "paused") throw new Error("pause failed");

    const result = await resolve(paused.interventionId, source, "deny");
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.applied).toBe(true);
    expect(result.membershipDelivery).toBeUndefined();
    expect(
      await prisma.chatGroupMember.count({ where: { groupId: group.id, botId: joy.id } }),
    ).toBe(0);
    expect(await targetWork(source.runId)).toEqual({ runs: 0, messages: 0, members: 0 });
    expect(await prisma.run.count({ where: { originRunId: source.runId } })).toBe(0);

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention).toMatchObject({ status: "answered", decision: "denied" });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: source.runId } });
    expect(run.status).toBe("queued");

    const { facts } = await factsFor();
    expect(facts.find((item) => item.interactionId === paused.interventionId)).toMatchObject({
      status: "answered",
      decision: "denied",
    });
  });

  it("expires a stale decision without joining or delivering", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const paused = await pause(source, key);
    if (paused.outcome !== "paused") throw new Error("pause failed");
    await prisma.intervention.update({
      where: { id: paused.interventionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await resolve(paused.interventionId, source, "approve");
    expect(result.outcome).toBe("rejected");
    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention.status).toBe("expired");
    expect(await targetWork(source.runId)).toEqual({ runs: 0, messages: 0, members: 0 });
  });

  it("rejects a stale request revision", async () => {
    const source = await createSourceRun();
    const paused = await pause(source, nextKey());
    if (paused.outcome !== "paused") throw new Error("pause failed");
    const result = await resolve(paused.interventionId, source, "approve", randomUUID(), 2);
    expect(result.outcome).toBe("rejected");
    expect(await targetWork(source.runId)).toEqual({ runs: 0, messages: 0, members: 0 });
    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention.status).toBe("pending");
  });

  it("cancels with the source Run and leaves no target work", async () => {
    const source = await createSourceRun();
    const paused = await pause(source, nextKey());
    if (paused.outcome !== "paused") throw new Error("pause failed");
    await prisma.$transaction(
      (tx) =>
        cancelPendingInterventions(tx, [source.runId], new Date(), {
          status: "waiting_input",
        }),
      TX,
    );
    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: paused.interventionId },
    });
    expect(intervention.status).toBe("cancelled");
    expect(await targetWork(source.runId)).toEqual({ runs: 0, messages: 0, members: 0 });
    const { facts } = await factsFor();
    expect(facts.find((item) => item.interactionId === paused.interventionId)).toMatchObject({
      status: "cancelled",
      decision: null,
    });
  });

  it("hides a pending card when the target group is not manageable", async () => {
    const target = await inspectGroupMembershipTarget(prisma, {
      spaceId: ownerId,
      userId: ownerId,
      botId: joy.id,
      groupId: group.id,
    });
    expect(target.ok).toBe(true);
    const otherUserId = randomUUID();
    await prisma.chatGroup.update({ where: { id: group.id }, data: { userId: otherUserId } });
    const denied = await inspectGroupMembershipTarget(prisma, {
      spaceId: ownerId,
      userId: ownerId,
      botId: joy.id,
      groupId: group.id,
    });
    expect(denied).toMatchObject({ ok: false, reason: "not_manageable" });
    await prisma.chatGroup.update({ where: { id: group.id }, data: { userId: ownerId } });
  });

  it("records X-GROUP-FAIL and writes no target work when permission is lost before approval", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const paused = await pause(source, key);
    if (paused.outcome !== "paused") throw new Error("pause failed");
    const otherUserId = randomUUID();
    await prisma.chatGroup.update({ where: { id: group.id }, data: { userId: otherUserId } });
    try {
      const result = await resolve(paused.interventionId, source, "approve");
      expect(result.outcome).toBe("accepted");
      if (result.outcome === "accepted") expect(result.membershipDelivery).toBeUndefined();
      expect(await targetWork(source.runId)).toEqual({ runs: 0, messages: 0, members: 0 });
      const intervention = await prisma.intervention.findUniqueOrThrow({
        where: { id: paused.interventionId },
      });
      // The wait settles as answered so the suspended checkpoint can resume;
      // the failure reason, not a decision, records that nothing was applied.
      expect(intervention).toMatchObject({ status: "answered", decision: "approved" });
      const request = await prisma.groupMembershipRequest.findUniqueOrThrow({
        where: { id: paused.requestId },
      });
      expect(request.failureReason).toBe("not_manageable");
      expect(request.targetRunId).toBeNull();
      const ask = await prisma.message.findUniqueOrThrow({ where: { id: paused.messageId } });
      expect(ask.blocks).toMatchObject([
        { kind: "group_membership_failure", groupId: group.id, groupName: group.name },
      ]);
      expect(
        await prisma.message.count({
          where: { threadId: joyThreadId, clientNonce: `group-membership-failure:${key}` },
        }),
      ).toBe(0);
      const run = await prisma.run.findUniqueOrThrow({ where: { id: source.runId } });
      expect(run.status).toBe("queued");
    } finally {
      await prisma.chatGroup.update({ where: { id: group.id }, data: { userId: ownerId } });
    }
  });

  it("loads membership facts for an older page beyond the newest rows", async () => {
    const oldestSource = await createSourceRun();
    const oldestKey = nextKey();
    const oldest = await pause(oldestSource, oldestKey);
    if (oldest.outcome !== "paused") throw new Error("pause failed");
    // More than 50 newer requests must not hide the older card's fact.
    for (let index = 0; index < 55; index += 1) {
      const source = await createSourceRun();
      const paused = await pause(source, nextKey());
      if (paused.outcome !== "paused") throw new Error("pause failed");
      await prisma.intervention.update({
        where: { id: paused.interventionId },
        data: { status: "cancelled", pendingRunKey: null, resolvedAt: new Date() },
      });
    }
    const facts = await prisma.$transaction((tx) =>
      loadGroupMembershipApprovalFacts(tx, {
        spaceId: ownerId,
        userId: ownerId,
        threadId: joyThreadId,
        messageIds: [oldest.messageId],
        recentRunIds: [],
      }),
    );
    expect(facts.some((fact) => fact.interactionId === oldest.interventionId)).toBe(true);
  });

  it("records X-GROUP-FAIL once as a durable card", async () => {
    const source = await createSourceRun();
    const key = nextKey();
    const first = await prisma.$transaction((tx) =>
      recordGroupMembershipFailureInTransaction(tx, {
        spaceId: ownerId,
        threadId: joyThreadId,
        botId: joy.id,
        runId: source.runId,
        groupId: group.id,
        groupName: group.name,
        deliveryKey: key,
      }),
    );
    expect(first?.messageId).toBeTruthy();
    const message = await prisma.message.findUniqueOrThrow({ where: { id: first!.messageId } });
    expect(message.blocks).toMatchObject([
      {
        kind: "group_membership_failure",
        groupId: group.id,
        groupName: group.name,
        botId: joy.id,
        reason: "member_permission",
      },
    ]);
    const second = await prisma.$transaction((tx) =>
      recordGroupMembershipFailureInTransaction(tx, {
        spaceId: ownerId,
        threadId: joyThreadId,
        botId: joy.id,
        runId: source.runId,
        groupId: group.id,
        groupName: group.name,
        deliveryKey: key,
      }),
    );
    expect(second).toBeNull();
    expect(
      await prisma.message.count({
        where: { threadId: joyThreadId, clientNonce: `group-membership-failure:${key}` },
      }),
    ).toBe(1);
  });
});
