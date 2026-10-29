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
    planReview?: unknown;
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
        ...(input.planReview !== undefined ? { planReview: input.planReview as object } : {}),
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

  it("drops a pending row as soon as expiresAt passes while the timeout job owns settlement", async () => {
    const run = await taskRun(dmThreadId, "Expired request");
    const message = await botMessage(dmThreadId, [
      { kind: "ask", text: "Too late?", status: "pending" },
    ]);
    const before = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
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
    // An overdue card is no longer actionable even before the wait-timeout job
    // writes the terminal state; the queue must not keep pointing at it.
    expect(page.items.some((item) => item.interactionId === expired.id)).toBe(false);
    expect(page.total).toBe(before.total);
    expect(
      await prisma.attentionIntervention.findUnique({ where: { interactionId: expired.id } }),
    ).not.toBeNull();
    await prisma.intervention.update({
      where: { id: expired.id },
      data: { status: "expired", pendingRunKey: null, resolvedAt: new Date() },
    });
    // The trigger removes the projection row with the settlement, so the queue
    // cannot resurrect an expired request after a timeout job run.
    expect(
      await prisma.attentionIntervention.findUnique({ where: { interactionId: expired.id } }),
    ).toBeNull();
  });

  it("excludes a pending approval whose posting bot was archived inside an active group", async () => {
    const retiredGroupBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Retired group bot", color: "test" },
    });
    const groupRun = await taskRun(group.threadId, "Retired group work");
    const retiredMessage = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: group.threadId,
        role: "bot",
        originKind: "system",
        blocks: [
          {
            kind: "app_connect",
            provider: "github",
            name: "Retired GitHub",
            description: "Read repositories",
            logo: null,
            status: "pending",
          },
        ],
        botId: retiredGroupBot.id,
        runId: groupRun.id,
      }),
    );
    const retiredInput = await pendingIntervention({
      threadId: group.threadId,
      runId: groupRun.id,
      messageId: retiredMessage.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Retired group input" },
      botId: retiredGroupBot.id,
    });
    const before = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    await prisma.bot.update({
      where: { id: retiredGroupBot.id },
      data: { archivedAt: new Date() },
    });
    const after = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(after.items.some((item) => item.interactionId === retiredInput.id)).toBe(false);
    expect(after.items.some((item) => item.source.messageId === retiredMessage.id)).toBe(false);
    expect(after.total).toBe(before.total - 2);
  });

  it("excludes a membership request whose target group is no longer manageable", async () => {
    const foreignGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: otherUserId, kind: "standard", name: "Foreign room" },
    });
    const before = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const run = await taskRun(dmThreadId, "Join a foreign room");
    const message = await botMessage(dmThreadId, [
      { kind: "ask", text: "Add Scout to Foreign room?", status: "pending" },
    ]);
    const interventionId = randomUUID();
    await pendingIntervention({
      id: interventionId,
      threadId: dmThreadId,
      runId: run.id,
      messageId: message.id,
      kind: "approval",
      presentation: { text: "Add Scout to “Foreign room”?" },
    });
    await prisma.groupMembershipRequest.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId: ownerId,
        botId: bot.id,
        groupId: foreignGroup.id,
        groupName: foreignGroup.name,
        sourceThreadId: dmThreadId,
        sourceRunId: run.id,
        cardMessageId: message.id,
        interventionId,
        deliveryKey: randomUUID(),
        requestRevision: 1,
        message: "Check the build.",
        presentation: { text: "Add Scout to “Foreign room”?" },
      },
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    // Permission is re-read on every request; the total must not count a card
    // the user can no longer act on.
    expect(page.items.some((item) => item.interactionId === interventionId)).toBe(false);
    expect(page.total).toBe(before.total);
  });

  it("keeps a pending Interaction after its Run reaches a terminal status", async () => {
    const run = await taskRun(dmThreadId, "Terminal run keeps its ask");
    const message = await botMessage(dmThreadId, [
      { kind: "ask", text: "Still open?", status: "pending" },
    ]);
    const pending = await pendingIntervention({
      threadId: dmThreadId,
      runId: run.id,
      messageId: message.id,
      kind: "input",
      inputMode: "text",
      presentation: { text: "Still open?" },
    });
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    // Run lifecycle and request lifecycle have separate owners: finishing the
    // Run must not make an unanswered request disappear.
    expect(page.items.some((item) => item.interactionId === pending.id)).toBe(true);
    await prisma.intervention.update({
      where: { id: pending.id },
      data: { status: "cancelled", pendingRunKey: null, resolvedAt: new Date() },
    });
  });

  it("does not count pending rows the strict projection cannot render", async () => {
    const before = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const unrenderable: string[] = [];
    async function drop(
      kind: "input" | "approval" | "plan_review",
      extra: Record<string, unknown>,
    ) {
      const run = await taskRun(dmThreadId, `Unrenderable ${kind}`);
      const message = await botMessage(dmThreadId, [
        { kind: "ask", text: "Unrenderable request", status: "pending" },
      ]);
      const row = await pendingIntervention({
        threadId: dmThreadId,
        runId: run.id,
        messageId: message.id,
        kind,
        presentation: { text: "Unrenderable request" },
        ...extra,
      });
      unrenderable.push(row.id);
      return row;
    }

    // Plan review without its embedded content: the strict projector returns
    // null, so it must not inflate the badge.
    const missingPlan = await drop("plan_review", {});
    // Plan review with a content object that fails the strict plan schema.
    const malformedPlan = await drop("plan_review", { planReview: { content: {} } });
    // Astral characters count as two UTF-16 units in Zod: 600 emoji exceed the
    // 1000-unit goal cap even though PostgreSQL length() sees 600 code points.
    const astralPlan = await drop("plan_review", {
      planReview: {
        content: {
          planId: "plan-astral",
          contentVersion: 1,
          revision: 1,
          goal: "😀".repeat(600),
          items: [{ id: "item-1", title: "Ship", status: "pending" }],
          source: "publish_run_plan",
        },
      },
    });
    // Choice input whose action list has no usable id.
    await drop("input", { inputMode: "choice" });
    // Historical or malformed input modes are not representable by the strict
    // card projector and must not inflate the badge count.
    await drop("input", {});
    await drop("input", { inputMode: "unsupported" });
    // Approval without an ExternalEffect or a RT-12 membership request.
    await drop("approval", {});

    // A membership approval whose request presentation fails the strict
    // projection: the request trigger must persist renderable=false.
    const membershipRun = await taskRun(dmThreadId, "Unrenderable membership");
    const membershipMessage = await botMessage(dmThreadId, [
      { kind: "ask", text: "Unrenderable membership", status: "pending" },
    ]);
    const membershipGroup = await prisma.chatGroup.create({
      data: { spaceId, userId: ownerId, kind: "standard", name: "Unrenderable join" },
    });
    const membership = await pendingIntervention({
      threadId: dmThreadId,
      runId: membershipRun.id,
      messageId: membershipMessage.id,
      kind: "approval",
      presentation: { text: "Unrenderable membership" },
    });
    unrenderable.push(membership.id);
    await prisma.groupMembershipRequest.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId: ownerId,
        botId: bot.id,
        groupId: membershipGroup.id,
        groupName: membershipGroup.name,
        sourceThreadId: dmThreadId,
        sourceRunId: membershipRun.id,
        cardMessageId: membershipMessage.id,
        interventionId: membership.id,
        deliveryKey: randomUUID(),
        requestRevision: 1,
        message: "Check the build.",
        presentation: { text: "Add Scout", extra: true } as never,
      },
    });
    const astralMembershipRun = await taskRun(dmThreadId, "Astral membership");
    const astralMembershipMessage = await botMessage(dmThreadId, [
      { kind: "ask", text: "Astral membership", status: "pending" },
    ]);
    const astralMembership = await pendingIntervention({
      threadId: dmThreadId,
      runId: astralMembershipRun.id,
      messageId: astralMembershipMessage.id,
      kind: "approval",
      presentation: { text: "Astral membership" },
    });
    unrenderable.push(astralMembership.id);
    await prisma.groupMembershipRequest.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId: ownerId,
        botId: bot.id,
        groupId: membershipGroup.id,
        groupName: membershipGroup.name,
        sourceThreadId: dmThreadId,
        sourceRunId: astralMembershipRun.id,
        cardMessageId: astralMembershipMessage.id,
        interventionId: astralMembership.id,
        deliveryKey: randomUUID(),
        requestRevision: 1,
        message: "Check the build.",
        // 3000 emoji are 6000 UTF-16 units, above the 4000-unit presentation cap.
        presentation: { text: "😀".repeat(3000) } as never,
      },
    });
    const flags = await prisma.attentionIntervention.findMany({
      where: { interactionId: { in: unrenderable } },
      select: { interactionId: true, renderable: true },
    });
    const hiddenFlags = new Set(
      flags.filter((row) => !row.renderable).map((row) => row.interactionId),
    );
    expect(hiddenFlags.has(missingPlan.id)).toBe(true);
    expect(hiddenFlags.has(malformedPlan.id)).toBe(true);
    expect(hiddenFlags.has(membership.id)).toBe(true);
    expect(hiddenFlags.has(astralPlan.id)).toBe(true);
    expect(hiddenFlags.has(astralMembership.id)).toBe(true);

    const after = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(after.total).toBe(before.total);
    for (const id of unrenderable) {
      expect(after.items.some((item) => item.interactionId === id)).toBe(false);
    }
    // The same rule must hold across every page, not only the first one.
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await loadAttentionPage(prisma, {
        spaceId,
        userId: ownerId,
        limit: 2,
        cursor,
      });
      ids.push(...page.items.map((item) => item.interactionId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.filter((id) => unrenderable.includes(id))).toEqual([]);

    await prisma.groupMembershipRequest.deleteMany({
      where: { interventionId: { in: unrenderable } },
    });
    await prisma.intervention.deleteMany({ where: { id: { in: unrenderable } } });
  });

  it("applies UTF-16 length semantics to every bounded plan and membership field", async () => {
    const astral = "😀";
    const plan = (
      contentPatch: Record<string, unknown>,
      rootPatch: Record<string, unknown> = {},
    ) => ({
      ...rootPatch,
      content: {
        planId: "plan",
        contentVersion: 1,
        revision: 1,
        goal: "goal",
        items: [{ id: "item", title: "title", status: "pending" }],
        source: "publish_run_plan",
        ...contentPatch,
      },
    });
    const item = (patch: Record<string, unknown>) =>
      plan({ items: [{ id: "item", title: "title", status: "pending", ...patch }] });
    async function planOk(value: unknown) {
      const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT attention_plan_review_valid(${JSON.stringify(value)}::jsonb) AS ok
      `;
      return rows[0]!.ok;
    }

    expect(await planOk(plan({}))).toBe(true);
    expect(await planOk(plan({ goal: astral.repeat(500) }))).toBe(true); // 1000 UTF-16 units
    expect(await planOk(plan({ goal: astral.repeat(501) }))).toBe(false); // 1002
    expect(await planOk(item({ id: astral.repeat(33) }))).toBe(false); // 66 > 64
    expect(await planOk(item({ title: astral.repeat(101) }))).toBe(false); // 202 > 200
    expect(await planOk(plan({}, { feedback: astral.repeat(1001) }))).toBe(false); // 2002 > 2000

    const membership = (patch: Record<string, unknown>) => ({ text: "Add the Bot", ...patch });
    async function membershipOk(presentation: unknown) {
      const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT attention_membership_renderable(
          ${JSON.stringify(presentation)}::jsonb,
          ${"group"},
          ${"bot"},
          ${"request"},
          ${"thread"},
          ${"run"},
          ${"message"},
          ${"space"},
          ${1}
        ) AS ok
      `;
      return rows[0]!.ok;
    }

    expect(await membershipOk(membership({}))).toBe(true);
    expect(await membershipOk(membership({ text: astral.repeat(2000) }))).toBe(true); // 4000
    expect(await membershipOk(membership({ text: astral.repeat(2001) }))).toBe(false); // 4002
    expect(await membershipOk(membership({ detail: astral.repeat(4001) }))).toBe(false); // 8002
    expect(
      await membershipOk(
        membership({
          credential: {
            name: astral.repeat(33),
            origin: "https://example.test",
            authType: "bearer",
          },
        }),
      ),
    ).toBe(false); // 66 > 64
    expect(
      await membershipOk(
        membership({
          credential: { name: "n", origin: astral.repeat(1025), authType: "bearer" },
        }),
      ),
    ).toBe(false); // 2050 > 2048
  });

  it("orders by expiresAt ASC NULLS LAST, then attentionAt, then stableId", async () => {
    const run = await taskRun(dmThreadId, "Ordered requests");
    const older = new Date(Date.now() - 60_000);
    async function ask(text: string, expiresAt: Date | null, createdAt: Date) {
      const message = await botMessage(dmThreadId, [{ kind: "ask", text, status: "pending" }]);
      return pendingIntervention({
        threadId: dmThreadId,
        runId: run.id,
        messageId: message.id,
        kind: "input",
        inputMode: "text",
        presentation: { text },
        expiresAt,
        createdAt,
      });
    }
    const laterExpiry = await ask("Later expiry", new Date(Date.now() + 120_000), older);
    const soonExpiry = await ask("Sooner expiry", new Date(Date.now() + 60_000), older);
    const noExpiry = await ask("No expiry", null, older);
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const position = (id: string) => page.items.findIndex((item) => item.interactionId === id);
    expect(position(soonExpiry.id)).toBeGreaterThanOrEqual(0);
    expect(position(soonExpiry.id)).toBeLessThan(position(laterExpiry.id));
    expect(position(laterExpiry.id)).toBeLessThan(position(noExpiry.id));
  });

  it("counts and pages a source beyond the old 500-row read cap", async () => {
    const bulkBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Bulk", color: "test" },
    });
    const bulkThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, botId: bulkBot.id },
    });
    const bulkRun = await taskRun(bulkThread.id, "Bulk pending requests");
    const bulkMessage = await botMessage(bulkThread.id, [{ kind: "text", text: "bulk requests" }]);
    const before = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const base = Date.now() - 10_000_000;
    await prisma.intervention.createMany({
      data: Array.from({ length: 520 }, (_unused, index) => ({
        id: `bulk-${index}`,
        revision: 1,
        kind: "input",
        status: "pending",
        spaceId,
        threadId: bulkThread.id,
        runId: bulkRun.id,
        attemptId: "legacy",
        botId: bulkBot.id,
        messageId: bulkMessage.id,
        expiresAt: null,
        inputMode: "text",
        presentation: { text: `Bulk request ${index}` },
        createdAt: new Date(base + index * 1_000),
      })),
    });
    const after = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    // The badge must count every pending row, not the first page of one source.
    expect(after.total - before.total).toBe(520);
    await prisma.$executeRawUnsafe('ANALYZE "attention_interventions"');
    const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT "interactionId" FROM "attention_interventions"
      WHERE "userId" = ${ownerId}
        AND "spaceId" = ${spaceId}
        AND ("expiresAt" IS NULL OR "expiresAt" > ${new Date()})
      ORDER BY "expiresAt" ASC NULLS LAST, "attentionAt" ASC, "interactionId" ASC
      LIMIT 21`;
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
    // The first page is a keyset slice of the compact projection; it must not
    // materialize or sort the whole pending set.
    expect(planText).toContain("attention_interventions_user_order");
    const scanned = /rows=(\d+) width/.exec(planText)?.[1];
    expect(Number(scanned ?? Number.NaN)).toBeLessThan(100);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await loadAttentionPage(prisma, {
        spaceId,
        userId: ownerId,
        limit: 50,
        cursor,
      });
      ids.push(...page.items.map((item) => item.interactionId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.length).toBe(after.total);
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 0; index < 520; index += 1) {
      expect(ids).toContain(`bulk-${index}`);
    }
    // Later cases in this file assume a small queue; drop the bulk rows again.
    await prisma.intervention.deleteMany({ where: { threadId: bulkThread.id } });
    expect((await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 })).total).toBe(
      before.total,
    );
  });

  it("reads pending approvals without scanning message history", async () => {
    const historyBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "History", color: "test" },
    });
    const historyThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, botId: historyBot.id },
    });
    const base = Date.now() - 20_000_000;
    // 5,000 unrelated bot messages: the containment read must not visit them.
    await prisma.message.createMany({
      data: Array.from({ length: 5_000 }, (_unused, index) => ({
        id: `hist-${index}`,
        threadId: historyThread.id,
        seq: index + 1,
        role: "bot",
        originKind: "system",
        blocks: [{ kind: "text", text: `history ${index}` }],
        createdAt: new Date(base + index * 100),
      })),
    });
    const approvalMessage = await prisma.message.create({
      data: {
        id: "hist-approval",
        threadId: historyThread.id,
        seq: 5_001,
        role: "bot",
        originKind: "system",
        blocks: [
          {
            kind: "mcp_approval",
            name: "Search server",
            serverId: "server-history",
            transport: "streamable_http",
            endpoint: "https://mcp.example.test",
            needsOAuth: false,
            status: "pending",
          },
        ],
        createdAt: new Date(base + 5_001 * 100),
      },
    });
    await prisma.$executeRawUnsafe('ANALYZE "messages"');
    const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id FROM "messages"
      WHERE "threadId" = ${historyThread.id}
        AND role = 'bot'
        AND blocks @> '[{"kind":"mcp_approval","status":"pending"}]'::jsonb`;
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText).toContain("messages_blocks_gin");
    // The scan touches the matching rows, not the whole history.
    const scanned = /rows=(\d+) width/.exec(planText)?.[1];
    expect(Number(scanned ?? Number.NaN)).toBeLessThan(500);
    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    expect(page.items.some((item) => item.source.messageId === approvalMessage.id)).toBe(true);
    // Later cases assume a small queue.
    await prisma.message.deleteMany({ where: { threadId: historyThread.id } });
    expect(page.total).toBeGreaterThan(0);
  });

  it("keeps a nested delegated takeover whose first hop already completed", async () => {
    const nestedBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Nested", color: "test" },
    });
    const outerBot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Outer", color: "test" },
    });
    const visibleThread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, botId: nestedBot.id },
    });
    async function pairThread(name: string) {
      const pairGroup = await prisma.chatGroup.create({
        data: {
          spaceId,
          userId: ownerId,
          kind: "agent_pair",
          pairKey: `attention-nested-${name}-${randomUUID()}`,
          name,
        },
      });
      const thread = await prisma.thread.create({
        data: { spaceId, userId: ownerId, groupId: pairGroup.id },
      });
      return thread.id;
    }
    async function delegatedRun(input: {
      threadId: string;
      botId: string;
      originThreadId: string;
      originRunId: string;
      status: string;
    }) {
      const task = await prisma.task.create({
        data: {
          spaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: ownerId,
          prompt: "Delegated",
          status: input.status,
        },
      });
      return prisma.run.create({
        data: {
          spaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: ownerId,
          status: input.status,
          trigger: "bot_message",
          originThreadId: input.originThreadId,
          originRunId: input.originRunId,
          originMessageId: "origin-message",
        },
      });
    }
    const visibleTask = await prisma.task.create({
      data: {
        spaceId,
        botId: nestedBot.id,
        threadId: visibleThread.id,
        userId: ownerId,
        prompt: "Nested parent",
        status: "completed",
      },
    });
    const visibleRun = await prisma.run.create({
      data: {
        spaceId,
        botId: nestedBot.id,
        threadId: visibleThread.id,
        taskId: visibleTask.id,
        userId: ownerId,
        status: "completed",
        trigger: "user",
      },
    });
    const outerPairThreadId = await pairThread("nested-outer-pair");
    const innerPairThreadId = await pairThread("nested-inner-pair");
    // The hop delegated from the visible conversation has finished; the pending
    // takeover lives one hidden pair Thread deeper.
    const outerRun = await delegatedRun({
      threadId: outerPairThreadId,
      botId: outerBot.id,
      originThreadId: visibleThread.id,
      originRunId: visibleRun.id,
      status: "completed",
    });
    const nestedRun = await delegatedRun({
      threadId: innerPairThreadId,
      botId: nestedBot.id,
      originThreadId: outerPairThreadId,
      originRunId: outerRun.id,
      status: "waiting_takeover",
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId: ownerId,
        scopeKey: `${ownerId}:nested-computer`,
        homeKey: `${ownerId}:nested-home`,
        kind: "docker",
        state: "running",
        controlHolder: "none",
        controlRunId: nestedRun.id,
      },
    });
    await prisma.bot.update({
      where: { id: nestedBot.id },
      data: { computerId: computer.id },
    });

    const page = await loadAttentionPage(prisma, { spaceId, userId: ownerId, limit: 50 });
    const control = page.items.find(
      (item) => item.kind === "session_control" && item.source.runId === nestedRun.id,
    );
    expect(control).toMatchObject({
      status: "pending",
      source: { threadId: visibleThread.id, runId: nestedRun.id },
    });
    expect(page.items.every((item) => item.source.threadId !== innerPairThreadId)).toBe(true);
    expect(page.items.every((item) => item.source.threadId !== outerPairThreadId)).toBe(true);
  });
});
