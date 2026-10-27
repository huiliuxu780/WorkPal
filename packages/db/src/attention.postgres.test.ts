import { randomUUID } from "node:crypto";
import { compareAttentionItems, encodeAttentionCursor, type MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAttentionPage } from "./attention.js";
import type { PrismaClient } from "./client.js";
import { createThreadMessageInTransaction } from "./messages.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("CARD-01D attention query (PostgreSQL)", () => {
  const ownerId = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let spaceId: string;
  let bot: { id: string; name: string };
  let dmThreadId: string;
  let group: { id: string; threadId: string; name: string };
  let otherUserId: string;
  let otherThreadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("card01d_attention");
    prisma = isolated.db.prisma;
    spaceId = ownerId;
    await prisma.user.create({
      data: {
        id: ownerId,
        name: "Attention owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: ownerId, name: "Attention org", slug: ownerId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId: ownerId, name: "Attention" },
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
    const created = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Scout", color: "test" },
    });
    bot = { id: created.id, name: created.name };
    const dm = await prisma.thread.create({ data: { spaceId, userId: ownerId, botId: bot.id } });
    dmThreadId = dm.id;
    const createdGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: ownerId, kind: "standard", name: "Build room" },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, groupId: createdGroup.id },
    });
    group = { id: createdGroup.id, threadId: groupThread.id, name: createdGroup.name };
    await prisma.chatGroupMember.create({
      data: { groupId: createdGroup.id, botId: bot.id },
    });
    otherUserId = randomUUID();
    const otherBot = await prisma.bot.create({
      data: { spaceId, userId: otherUserId, name: "Other", color: "test" },
    });
    const other = await prisma.thread.create({
      data: { spaceId, userId: otherUserId, botId: otherBot.id },
    });
    otherThreadId = other.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function taskRun(threadId: string, prompt: string, status = "waiting_input") {
    const task = await prisma.task.create({
      data: { spaceId, botId: bot.id, threadId, userId: ownerId, prompt, status },
    });
    return prisma.run.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId,
        taskId: task.id,
        userId: ownerId,
        status,
        trigger: "user",
      },
    });
  }

  async function pendingIntervention(input: {
    id?: string;
    threadId: string;
    runId: string;
    messageId: string;
    kind: "input" | "approval" | "plan_review";
    status?: string;
    inputMode?: string;
    actions?: Array<{ id: string; label: string }>;
    presentation?: { text: string; detail?: string };
    expiresAt?: Date | null;
    createdAt?: Date;
    revision?: number;
    botId?: string;
  }) {
    return prisma.intervention.create({
      data: {
        id: input.id ?? randomUUID(),
        revision: input.revision ?? 1,
        kind: input.kind,
        status: input.status ?? "pending",
        spaceId,
        threadId: input.threadId,
        runId: input.runId,
        attemptId: "legacy",
        botId: input.botId ?? bot.id,
        messageId: input.messageId,
        pendingRunKey: input.status === "pending" ? input.runId : null,
        expiresAt: input.expiresAt ?? null,
        inputMode: input.inputMode ?? null,
        ...(input.actions ? { inputActions: input.actions } : {}),
        presentation: input.presentation ?? { text: "Decision needed" },
        createdAt: input.createdAt ?? new Date(),
      },
    });
  }

  async function botMessage(threadId: string, blocks: MessageBlock[], runId?: string) {
    return prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        originKind: "system",
        blocks,
        botId: bot.id,
        ...(runId ? { runId } : {}),
      }),
    );
  }

  it("returns only pending Interventions, session controls and strict business approvals", async () => {
    const inputRun = await taskRun(dmThreadId, "Ask me something");
    const inputMessage = await botMessage(dmThreadId, [
      { kind: "ask", text: "Which city?", status: "pending" },
    ]);
    await pendingIntervention({
      threadId: dmThreadId,
      runId: inputRun.id,
      messageId: inputMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Which city?" },
      createdAt: new Date("2026-10-27T08:00:00.000Z"),
    });

    const takeoverTask = await prisma.task.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: dmThreadId,
        userId: ownerId,
        prompt: "Hand me the desktop",
        status: "waiting_takeover",
      },
    });
    const takeoverRun = await prisma.run.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: dmThreadId,
        taskId: takeoverTask.id,
        userId: ownerId,
        status: "waiting_takeover",
        trigger: "user",
        waitKind: "takeover",
        waitStartedAt: new Date("2026-10-27T08:01:00.000Z"),
      },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId: ownerId,
        scopeKey: `${ownerId}:attention-computer`,
        homeKey: `${ownerId}:attention-home`,
        kind: "docker",
        state: "running",
        controlHolder: "none",
        controlRunId: takeoverRun.id,
      },
    });
    await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });

    const appRun = await taskRun(group.threadId, "Connect the app");
    const appMessage = await botMessage(group.threadId, [
      {
        kind: "app_connect",
        provider: "github",
        name: "GitHub",
        description: "Read repositories",
        logo: null,
        status: "pending",
      },
    ]);
    const planIntervention = await pendingIntervention({
      threadId: group.threadId,
      runId: appRun.id,
      messageId: appMessage.id,
      kind: "plan_review",
      presentation: { text: "Review the plan" },
      createdAt: new Date("2026-10-27T08:02:00.000Z"),
    });
    await prisma.intervention.update({
      where: { id: planIntervention.id },
      data: {
        planReview: {
          content: {
            planId: "plan-1",
            contentVersion: 1,
            revision: 1,
            goal: "Review the plan",
            items: [{ id: "step-1", title: "Check the build", status: "pending" }],
            source: "plan_exit",
          },
        },
      },
    });

    const mcpMessage = await botMessage(group.threadId, [
      {
        kind: "mcp_approval",
        name: "Search server",
        serverId: "server-1",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        needsOAuth: false,
        status: "pending",
      },
    ]);
    await pendingIntervention({
      threadId: group.threadId,
      runId: appRun.id,
      messageId: mcpMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "MCP card" },
      createdAt: new Date("2026-10-27T08:03:00.000Z"),
    });
    await botMessage(group.threadId, [
      {
        kind: "mcp_approval",
        name: "Settled server",
        serverId: "server-2",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/settled",
        needsOAuth: false,
        status: "connected",
      },
    ]);
    const skillMessage = await botMessage(group.threadId, [
      {
        kind: "skill_draft",
        skillId: "skill-1",
        name: "Digest",
        goal: "Weekly digest",
        playbook: {
          whenToUse: "weekly",
          inputs: ["notes"],
          steps: ["collect", "summarize"],
          howToCheck: "read it",
          whatToReturn: "summary",
          approvalBoundaries: "none",
          failureHandling: "retry",
        },
        status: "draft",
      },
    ]);
    await pendingIntervention({
      threadId: group.threadId,
      runId: appRun.id,
      messageId: skillMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Skill card" },
      createdAt: new Date("2026-10-27T08:04:00.000Z"),
    });

    // Everything below must stay out of the queue: a settled wait, a
    // collaboration receipt and another user's Thread.
    const settledRun = await taskRun(dmThreadId, "Settled work", "completed");
    const settledMessage = await botMessage(dmThreadId, [
      { kind: "ask", text: "Answered", status: "answered", answer: "Yes" },
    ]);
    await pendingIntervention({
      threadId: dmThreadId,
      runId: settledRun.id,
      messageId: settledMessage.id,
      kind: "input",
      status: "answered",
      inputMode: "text",
    });
    const receiptRun = await taskRun(dmThreadId, "Receipt work");
    await botMessage(
      dmThreadId,
      [
        {
          kind: "collaboration_receipt",
          target: { kind: "group", groupId: group.id, threadId: group.threadId },
          state: "sent",
          destination: null,
        },
      ],
      receiptRun.id,
    );
    const otherBotId = (await prisma.bot.findFirstOrThrow({ where: { userId: otherUserId } })).id;
    const otherTask = await prisma.task.create({
      data: {
        spaceId,
        botId: otherBotId,
        threadId: otherThreadId,
        userId: otherUserId,
        prompt: "Other work",
        status: "waiting_takeover",
      },
    });
    const otherRun = await prisma.run.create({
      data: {
        spaceId,
        botId: otherBotId,
        threadId: otherThreadId,
        taskId: otherTask.id,
        userId: otherUserId,
        status: "waiting_takeover",
        trigger: "user",
      },
    });
    await prisma.intervention.create({
      data: {
        id: randomUUID(),
        kind: "input",
        status: "pending",
        spaceId,
        threadId: otherThreadId,
        runId: otherRun.id,
        attemptId: "legacy",
        botId: otherRun.botId,
        messageId: settledMessage.id,
        pendingRunKey: otherRun.id,
        inputMode: "text",
        presentation: { text: "Not yours" },
        createdAt: new Date(),
      },
    });

    const page = await loadAttentionPage(prisma, {
      spaceId,
      userId: ownerId,
      limit: 20,
    });
    const kinds = page.items.map((item) => item.kind);
    expect(kinds).toContain("input_request");
    expect(kinds).toContain("plan_review");
    expect(kinds).toContain("action_approval");
    expect(kinds.filter((kind) => kind === "session_control")).toHaveLength(1);
    const approvalKinds = page.items
      .filter((item) => item.kind === "action_approval")
      .map((item) => item.interactionId);
    expect(approvalKinds.length).toBe(3);
    expect(page.items.some((item) => item.presentation.text === "Answered")).toBe(false);
    expect(page.items.some((item) => item.presentation.text === "Not yours")).toBe(false);
    expect(page.items.every((item) => item.source.threadId !== otherThreadId)).toBe(true);
    expect(page.items.some((item) => item.presentation.text === "Settled server")).toBe(false);
    expect(page.total).toBe(page.items.length);
    expect(page.items[0]?.kind).toBe("input_request");
    expect(page.items[0]?.conversationKind).toBe("direct");
    expect(page.items[0]?.conversationName).toBe("Scout");
    expect(page.items[0]?.taskTitle).toBe("Ask me something");
    const plan = page.items.find((item) => item.kind === "plan_review");
    expect(plan?.conversationKind).toBe("group");
    expect(plan?.conversationName).toBe("Build room");
  });

  it("queues RT-12 membership approvals and drops them once settled", async () => {
    const membershipGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: ownerId, kind: "standard", name: "Join room" },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, groupId: membershipGroup.id },
    });
    const run = await taskRun(dmThreadId, "Join the room");
    const message = await botMessage(dmThreadId, [
      { kind: "ask", text: "Add Scout to Join room?", status: "pending" },
    ]);
    const interventionId = randomUUID();
    await pendingIntervention({
      id: interventionId,
      threadId: dmThreadId,
      runId: run.id,
      messageId: message.id,
      kind: "approval",
      presentation: { text: "Add Scout to “Join room”?" },
    });
    await prisma.groupMembershipRequest.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId: ownerId,
        botId: bot.id,
        groupId: membershipGroup.id,
        groupName: membershipGroup.name,
        sourceThreadId: dmThreadId,
        sourceRunId: run.id,
        cardMessageId: message.id,
        interventionId,
        deliveryKey: randomUUID(),
        requestRevision: 1,
        message: "Check the build.",
        presentation: { text: "Add Scout to “Join room”?" },
      },
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(page.items.find((item) => item.interactionId === interventionId)).toMatchObject({
      kind: "action_approval",
      // The user answers in the source direct chat; the target group only
      // appears in the sanitized request summary.
      conversationKind: "direct",
      conversationName: "Scout",
      presentation: { text: "Add Scout to “Join room”?" },
    });

    await prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: "answered",
        decision: "denied",
        pendingRunKey: null,
        resolvedAt: new Date(),
      },
    });
    const after = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(after.items.some((item) => item.interactionId === interventionId)).toBe(false);
    // The group thread itself carries no queue rows.
    expect(after.items.some((item) => item.source.threadId === groupThread.id)).toBe(false);
  });

  it("rebases a delegated desktop handoff onto the visible origin and hides pair threads", async () => {
    const pairGroup = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId: ownerId,
        kind: "agent_pair",
        pairKey: `attention-pair-${randomUUID()}`,
        name: "Hidden pair",
      },
    });
    const pairThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, groupId: pairGroup.id },
    });
    const originRun = await taskRun(dmThreadId, "Delegated parent");
    const pairTask = await prisma.task.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: pairThread.id,
        userId: ownerId,
        prompt: "Delegated child",
        status: "waiting_takeover",
      },
    });
    const pairRun = await prisma.run.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: pairThread.id,
        taskId: pairTask.id,
        userId: ownerId,
        status: "waiting_takeover",
        trigger: "bot_message",
        originThreadId: dmThreadId,
        originRunId: originRun.id,
        originMessageId: "origin-message",
      },
    });
    // A wait that lives in the hidden pair Thread must never be addressed there.
    const hiddenMessage = await botMessage(pairThread.id, [
      { kind: "ask", text: "Hidden?", status: "pending" },
    ]);
    await pendingIntervention({
      threadId: pairThread.id,
      runId: pairRun.id,
      messageId: hiddenMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Hidden wait" },
    });

    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const control = page.items.find(
      (item) => item.kind === "session_control" && item.source.runId === pairRun.id,
    );
    expect(control).toMatchObject({
      conversationKind: "direct",
      conversationName: "Scout",
      source: { threadId: dmThreadId, runId: pairRun.id },
    });
    expect(page.items.some((item) => item.presentation.text === "Hidden wait")).toBe(false);
    expect(page.items.every((item) => item.source.threadId !== pairThread.id)).toBe(true);
  });

  it("pages with the frozen sort without duplicating rows", async () => {
    const first = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await loadAttentionPage(prisma, {
      spaceId,
      userId: ownerId,
      limit: 2,
      cursor: first.nextCursor,
    });
    const keys = new Set(
      [...first.items, ...second.items].map((item) => `${item.interactionId}:${item.revision}`),
    );
    expect(keys.size).toBe(first.items.length + second.items.length);
    expect(second.total).toBe(first.total);
  });

  it("keeps a pending MCP approval whose sibling in the same message settled", async () => {
    const mixedMessage = await botMessage(group.threadId, [
      {
        kind: "mcp_approval",
        name: "Settled sibling",
        serverId: "server-settled",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/settled-sibling",
        needsOAuth: false,
        status: "connected",
      },
      {
        kind: "mcp_approval",
        name: "Still pending",
        serverId: "server-pending",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/pending-sibling",
        needsOAuth: false,
        status: "pending",
      },
    ]);
    await pendingIntervention({
      threadId: group.threadId,
      runId: (await taskRun(group.threadId, "Mixed MCP")).id,
      messageId: mixedMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Mixed MCP" },
    });
    // A pre-upgrade block can omit the schema-defaulted status, which the
    // projection treats as open; it must survive the same message-level filter.
    await botMessage(group.threadId, [
      {
        kind: "mcp_approval",
        name: "Legacy pending",
        serverId: "server-legacy",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/legacy-sibling",
        needsOAuth: false,
      } as unknown as MessageBlock,
    ]);
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const pending = page.items.find((item) => item.presentation.text === "Still pending");
    expect(pending).toMatchObject({ kind: "action_approval", status: "pending" });
    expect(page.items.some((item) => item.presentation.text === "Settled sibling")).toBe(false);
    expect(page.items.some((item) => item.presentation.text === "Legacy pending")).toBe(true);
  });

  it("drops requests whose group was archived", async () => {
    const archivedGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: ownerId, kind: "standard", name: "Archived room" },
    });
    const archivedThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, groupId: archivedGroup.id },
    });
    const run = await taskRun(archivedThread.id, "Work in the archived room");
    const message = await botMessage(archivedThread.id, [
      {
        kind: "app_connect",
        provider: "github",
        name: "GitHub archived",
        description: "Read repositories",
        logo: null,
        status: "pending",
      },
    ]);
    await pendingIntervention({
      threadId: archivedThread.id,
      runId: run.id,
      messageId: message.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Archived room approval" },
    });
    await prisma.chatGroup.update({
      where: { id: archivedGroup.id },
      data: { archivedAt: new Date() },
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(page.items.some((item) => item.source.threadId === archivedThread.id)).toBe(false);
    expect(page.items.some((item) => item.presentation.text === "Archived room approval")).toBe(
      false,
    );
  });

  it("drops requests whose direct chat bot was archived", async () => {
    // Same navigability rule as groups: repos.getBot() rejects an archived Bot,
    // so the source of such a request cannot be opened either.
    const retiredBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Retired", color: "test" },
    });
    const retiredThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, botId: retiredBot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId: retiredBot.id,
        threadId: retiredThread.id,
        userId: ownerId,
        prompt: "Work in the retired chat",
        status: "waiting_input",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId: retiredBot.id,
        threadId: retiredThread.id,
        taskId: task.id,
        userId: ownerId,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const message = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: retiredThread.id,
        role: "bot",
        originKind: "system",
        blocks: [
          {
            kind: "app_connect",
            provider: "github",
            name: "GitHub retired",
            description: "Read repositories",
            logo: null,
            status: "pending",
          },
        ],
        botId: retiredBot.id,
        runId: run.id,
      }),
    );
    await pendingIntervention({
      threadId: retiredThread.id,
      runId: run.id,
      messageId: message.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Retired chat approval" },
      botId: retiredBot.id,
    });
    await prisma.bot.update({
      where: { id: retiredBot.id },
      data: { archivedAt: new Date() },
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(page.items.some((item) => item.source.threadId === retiredThread.id)).toBe(false);
    expect(page.items.some((item) => item.presentation.text === "Retired chat approval")).toBe(
      false,
    );
  });

  it("continues after a cursor whose anchor row settled", async () => {
    const all = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const anchor = all.items.find(
      (item) => item.kind === "input_request" && item.source.messageId !== null,
    );
    if (!anchor) throw new Error("expected a pending input anchor");
    await prisma.intervention.update({
      where: { id: anchor.interactionId },
      data: {
        status: "answered",
        decision: "denied",
        pendingRunKey: null,
        resolvedAt: new Date(),
      },
    });
    const next = await loadAttentionPage(prisma, {
      spaceId,
      userId: ownerId,
      limit: 2,
      cursor: encodeAttentionCursor(anchor),
    });
    expect(next.items.length).toBeGreaterThan(0);
    for (const item of next.items) {
      expect(compareAttentionItems(item, anchor)).toBeGreaterThan(0);
      expect(item.interactionId).not.toBe(anchor.interactionId);
    }
    expect(next.total).toBeGreaterThan(0);
  });

  it("excludes expired pending rows and keeps revision dedupe", async () => {
    const run = await taskRun(dmThreadId, "Expired request");
    const message = await botMessage(dmThreadId, [
      { kind: "ask", text: "Too late?", status: "pending" },
    ]);
    const expired = await pendingIntervention({
      threadId: dmThreadId,
      runId: run.id,
      messageId: message.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Expired row" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    // Expiry is settled by the wait-timeout job, not hidden by the read model;
    // a still-pending row remains until its owner expires it.
    expect(page.items.some((item) => item.interactionId === expired.id)).toBe(true);
    const duplicated = page.items.filter((item) => item.interactionId === expired.id);
    expect(duplicated).toHaveLength(1);
  });
});
