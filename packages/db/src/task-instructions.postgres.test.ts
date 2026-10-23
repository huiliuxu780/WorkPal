import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRunInstructionRef, parseTaskInstructionEnvelope } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  answerRunInput,
  appendEventInTransaction,
  clearThread,
  pauseRunForInput,
  resolveIntervention,
} from "./events.js";
import { createManualRetryRun } from "./manual-retry.js";
import { createThreadMessage } from "./messages.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import {
  appendTaskAmendment,
  readTaskInstructionEnvelope,
  readTaskInstructionsForRun,
  TaskAmendmentRejected,
  TaskInstructionIntegrityError,
} from "./task-instructions.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const SECRET = "sk-live-task-instruction-secret";

describePostgres("Task instruction envelope (PostgreSQL)", () => {
  const id = randomUUID();
  const otherUserId = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("task-instructions");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Instruction owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        name: "Instruction other",
        email: `${otherUserId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Instruction test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Instruction test" } });
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
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: id,
        userId: otherUserId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: id,
        organizationId: id,
        userId: otherUserId,
        role: "member",
        createdAt: new Date(),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function newBotThread(label: string) {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: `Instruction ${label}`, color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: bot.id },
    });
    return { botId: bot.id, threadId: thread.id };
  }

  async function newTask(prompt: string, label: string = randomUUID()) {
    const { botId, threadId } = await newBotThread(label);
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt, status: "queued" },
    });
    return { task, botId, threadId };
  }

  function append(
    target: { task: { id: string }; threadId: string },
    content: string,
    clientNonce: string = randomUUID(),
  ) {
    return appendTaskAmendment(prisma, {
      spaceId: id,
      threadId: target.threadId,
      actorUserId: id,
      targetTaskId: target.task.id,
      content,
      clientNonce,
    });
  }

  it("reads an unamended Task as revision 1 with only the original", async () => {
    const { task } = await newTask("Original instructions", "legacy");
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    expect(envelope).toEqual({
      taskId: task.id,
      revision: 1,
      original: { content: "Original instructions" },
      amendments: [],
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1);
  });

  it("appends an explicit amendment without touching the original prompt", async () => {
    const { task, threadId } = await newTask("Original instructions", "explicit");
    const result = await append({ task, threadId }, "Only the tests changed.");

    expect(result.replayed).toBe(false);
    expect(result.ref).toEqual({ taskId: task.id, consumedRevision: 2 });
    expect(result.envelope).toEqual({
      taskId: task.id,
      revision: 2,
      original: { content: "Original instructions" },
      amendments: [{ messageId: result.messageId, seq: 1, content: "Only the tests changed." }],
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      prompt: "Original instructions",
      revision: 2,
    });

    const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message).toMatchObject({
      threadId,
      role: "user",
      authorUserId: id,
      originKind: "human_web",
    });
    const event = await prisma.event.findFirstOrThrow({
      where: { threadId, type: "task.amended" },
    });
    expect(event).toMatchObject({
      causationId: result.messageId,
      payload: {
        taskId: task.id,
        messageId: result.messageId,
        seq: 1,
        revision: 2,
        actorUserId: id,
        source: "explicit",
      },
    });
    const messageEvent = await prisma.event.findFirstOrThrow({
      where: { threadId, type: "thread.message.created" },
    });
    expect(messageEvent.payload).toMatchObject({
      messageId: result.messageId,
      role: "user",
      blocks: [{ kind: "text", text: "Only the tests changed." }],
    });
    expect(messageEvent.seq).toBeLessThan(event.seq);
  });

  it("replays the same nonce and keeps same-text/different-nonce revisions distinct", async () => {
    const { task, threadId } = await newTask("Original instructions", "nonce");
    const first = await append({ task, threadId }, "Add a regression test.", "nonce-1");
    const replay = await append({ task, threadId }, "Add a regression test.", "nonce-1");
    expect(replay).toMatchObject({
      replayed: true,
      messageId: first.messageId,
      seq: 1,
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(2);
    expect(await prisma.message.count({ where: { threadId, clientNonce: "nonce-1" } })).toBe(1);
    expect(await prisma.event.count({ where: { threadId, type: "task.amended" } })).toBe(1);

    const second = await append({ task, threadId }, "Add a regression test.", "nonce-2");
    expect(second.seq).toBe(2);
    expect(second.messageId).not.toBe(first.messageId);
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    expect(envelope?.revision).toBe(3);
    expect(envelope?.amendments.map((item) => item.seq)).toEqual([1, 2]);
    expect(envelope?.amendments.map((item) => item.content)).toEqual([
      "Add a regression test.",
      "Add a regression test.",
    ]);
    const historical = await readTaskInstructionEnvelope(prisma, {
      taskId: task.id,
      atRevision: 2,
    });
    expect(historical?.revision).toBe(2);
    expect(historical?.amendments.map((item) => item.seq)).toEqual([1]);
  });

  it("rejects a nonce already owned by different user content", async () => {
    const { task, threadId } = await newTask("Original instructions", "nonce-conflict");
    await createThreadMessage(prisma, {
      threadId,
      role: "user",
      originKind: "human_web",
      authorUserId: id,
      blocks: [{ kind: "text", text: "Different content" }],
      clientNonce: "nonce-conflict",
    });
    await expect(
      append({ task, threadId }, "Requested amendment", "nonce-conflict"),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1);
    expect(await prisma.event.count({ where: { threadId, type: "task.amended" } })).toBe(0);
  });

  it("serializes concurrent appends into continuous server revisions", async () => {
    const { task, threadId } = await newTask("Concurrent original", "concurrent");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        append({ task, threadId }, `Revision ${index}`, `concurrent-${index}`),
      ),
    );
    expect(results.map((result) => result.seq).sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(results.every((result) => result.replayed === false)).toBe(true);
    expect(new Set(results.map((result) => result.messageId)).size).toBe(8);
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.revision).toBe(9);
    expect(stored.prompt).toBe("Concurrent original");
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    expect(envelope?.revision).toBe(9);
    expect(envelope?.amendments.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await prisma.event.count({ where: { threadId, type: "task.amended" } })).toBe(8);
    expect(await prisma.message.count({ where: { threadId, role: "user" } })).toBe(8);
  });

  it("writes nothing for a foreign user, foreign space, or missing Task", async () => {
    const { task, threadId } = await newTask("Private original", "forbidden");
    const beforeMessages = await prisma.message.count({ where: { threadId } });
    const beforeEvents = await prisma.event.count({ where: { threadId } });

    await expect(
      appendTaskAmendment(prisma, {
        spaceId: id,
        threadId,
        actorUserId: otherUserId,
        targetTaskId: task.id,
        content: "Foreign amendment",
        clientNonce: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      appendTaskAmendment(prisma, {
        spaceId: id,
        threadId,
        actorUserId: id,
        targetTaskId: randomUUID(),
        content: "Missing amendment",
        clientNonce: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(TaskAmendmentRejected);

    const otherOrg = randomUUID();
    await prisma.organization.create({
      data: { id: otherOrg, name: "Other", slug: otherOrg, createdAt: new Date() },
    });
    const otherSpace = await prisma.space.create({
      data: { id: otherOrg, organizationId: otherOrg, name: "Other" },
    });
    const otherBot = await prisma.bot.create({
      data: { spaceId: otherSpace.id, userId: id, name: "Other bot", color: "test" },
    });
    const otherThread = await prisma.thread.create({
      data: { spaceId: otherSpace.id, userId: id, botId: otherBot.id },
    });
    const otherTask = await prisma.task.create({
      data: {
        spaceId: otherSpace.id,
        userId: id,
        botId: otherBot.id,
        threadId: otherThread.id,
        prompt: "Other space original",
        status: "queued",
      },
    });
    await expect(
      appendTaskAmendment(prisma, {
        spaceId: id,
        threadId,
        actorUserId: id,
        targetTaskId: otherTask.id,
        content: "Cross-space amendment",
        clientNonce: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: "not_found" });

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1);
    expect(await prisma.message.count({ where: { threadId } })).toBe(beforeMessages);
    expect(await prisma.event.count({ where: { threadId } })).toBe(beforeEvents);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: otherTask.id } })).revision).toBe(1);
  });

  it("rolls back Message, Task revision, and Event together", async () => {
    const { task, threadId } = await newTask("Atomic original", "rollback");
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reject_task_amended() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'task.amended' THEN
          RAISE EXCEPTION 'task.amended rejected by test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER reject_task_amended_trigger
      BEFORE INSERT ON events
      FOR EACH ROW EXECUTE FUNCTION reject_task_amended();
    `);
    try {
      await expect(
        append({ task, threadId }, "Should roll back", "rollback-nonce"),
      ).rejects.toThrow(/task\.amended rejected/);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS reject_task_amended_trigger ON events",
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS reject_task_amended()");
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1);
    expect(await prisma.message.count({ where: { threadId } })).toBe(0);
    expect(await prisma.event.count({ where: { threadId } })).toBe(0);
  });

  it("pins one Run to its first consumed revision across technical resumes", async () => {
    const { task, botId, threadId } = await newTask("Run original", "run");
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const first = await readTaskInstructionsForRun(prisma, {
      runId: run.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
    });
    expect(first?.ref).toEqual({ taskId: task.id, consumedRevision: 1 });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).consumedRevision).toBe(
      1,
    );

    await append({ task, threadId }, "Second instruction", "resume-1");
    const resumed = await readTaskInstructionsForRun(prisma, {
      runId: run.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
    });
    expect(resumed?.ref.consumedRevision).toBe(1);
    expect(resumed?.envelope.revision).toBe(1);
    expect(resumed?.envelope.amendments).toEqual([]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).consumedRevision).toBe(
      1,
    );

    await append({ task, threadId }, "Third instruction", "resume-2");
    const retry = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-2",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const retryRead = await readTaskInstructionsForRun(prisma, {
      runId: retry.id,
      leaseOwner: "worker-2",
      leaseFence: 1,
    });
    expect(retryRead?.ref.consumedRevision).toBe(3);
    expect(retryRead?.envelope.revision).toBe(3);
    expect(retryRead?.envelope.amendments.map((item) => item.content)).toEqual([
      "Second instruction",
      "Third instruction",
    ]);
    expect(
      await readTaskInstructionsForRun(prisma, {
        runId: retry.id,
        leaseOwner: "worker-2",
        leaseFence: 99,
      }),
    ).toBeNull();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: retry.id } })).consumedRevision).toBe(
      3,
    );
  });

  async function waitingRun(
    prompt: string,
    label: string,
    blocks: Parameters<typeof pauseRunForInput>[1]["blocks"],
  ) {
    const { task, botId, threadId } = await newTask(prompt, label);
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
    expect(
      await pauseRunForInput(prisma, {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        blocks,
      }),
    ).toBe(true);
    const message = await prisma.message.findFirstOrThrow({
      where: { runId: run.id, role: "bot" },
    });
    return { task, run, message, threadId };
  }

  it("appends a user Message for a legacy ask answer without overwriting the prompt", async () => {
    const { task, run, message, threadId } = await waitingRun("Original question", "ask", [
      { kind: "ask", text: "Which city?", status: "pending" },
    ]);
    await expect(
      answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: message.id,
        answeredByUserId: id,
        answer: "Paris",
      }),
    ).resolves.toBe(true);

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).prompt).toBe(
      "Original question",
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(2);
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    const answerMessage = await prisma.message.findFirstOrThrow({
      where: { threadId, runId: run.id, role: "user" },
    });
    expect(answerMessage).toMatchObject({
      originKind: "human_web",
      authorUserId: id,
      blocks: [{ kind: "text", text: "Paris" }],
    });
    expect(answerMessage.id).not.toBe(message.id);
    expect(envelope?.revision).toBe(2);
    expect(envelope?.amendments).toEqual([
      { messageId: answerMessage.id, seq: 1, content: "Paris" },
    ]);
    const event = await prisma.event.findFirstOrThrow({
      where: { threadId, type: "task.amended" },
    });
    expect(event.payload).toMatchObject({
      messageId: answerMessage.id,
      source: "ask_answer",
      seq: 1,
      revision: 2,
    });
    const askCard = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(JSON.stringify(askCard.blocks)).toContain('"status":"answered"');
  });

  it("appends a labeled user Message for a legacy choice answer", async () => {
    const { task, run, message, threadId } = await waitingRun("Original choice", "choice", [
      {
        kind: "ask",
        text: "Which city?",
        status: "pending",
        actions: [
          { id: "city-berlin", label: "Berlin" },
          { id: "city-lyon", label: "Lyon" },
        ],
      },
    ]);
    await expect(
      answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: message.id,
        answeredByUserId: id,
        answer: "city-lyon",
      }),
    ).resolves.toBe(true);

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).prompt).toBe(
      "Original choice",
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(2);
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    const answerMessage = await prisma.message.findFirstOrThrow({
      where: { threadId, runId: run.id, role: "user" },
    });
    expect(answerMessage).toMatchObject({
      originKind: "human_web",
      authorUserId: id,
      blocks: [{ kind: "text", text: "Selected choice city-lyon: Lyon" }],
    });
    expect(answerMessage.id).not.toBe(message.id);
    expect(envelope?.revision).toBe(2);
    expect(envelope?.amendments).toEqual([
      { messageId: answerMessage.id, seq: 1, content: "Selected choice city-lyon: Lyon" },
    ]);
    const event = await prisma.event.findFirstOrThrow({
      where: { threadId, type: "task.amended" },
    });
    expect(event.payload).toMatchObject({
      messageId: answerMessage.id,
      source: "choice_answer",
      seq: 1,
      revision: 2,
    });
  });

  it("migrates historical Task and Run rows without rewriting the prompt", async () => {
    const { task, botId, threadId } = await newTask("Historical prompt", "migration");
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "succeeded",
        trigger: "user",
      },
    });
    await prisma.$executeRawUnsafe('ALTER TABLE "runs" DROP COLUMN "consumedRevision"');
    await prisma.$executeRawUnsafe('ALTER TABLE "tasks" DROP COLUMN "revision"');
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261023120000_task_instruction_envelope/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";");
    for (const statement of statements.map((part) => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }

    const [migratedTask] = await prisma.$queryRaw<Array<{ prompt: string; revision: number }>>`
      SELECT prompt, revision FROM tasks WHERE id = ${task.id}
    `;
    expect(migratedTask).toEqual({ prompt: "Historical prompt", revision: 1 });
    const [migratedRun] = await prisma.$queryRaw<Array<{ consumedRevision: number | null }>>`
      SELECT "consumedRevision" FROM runs WHERE id = ${run.id}
    `;
    expect(migratedRun?.consumedRevision).toBeNull();
    expect(await readTaskInstructionEnvelope(prisma, { taskId: task.id })).toEqual({
      taskId: task.id,
      revision: 1,
      original: { content: "Historical prompt" },
      amendments: [],
    });
  });

  it("returns envelopes and refs accepted by the frozen roundtable parsers", async () => {
    const { task, threadId } = await newTask("Frozen original", "frozen");
    await append({ task, threadId }, "First revision", "frozen-1");
    const second = await append({ task, threadId }, "Second revision", "frozen-2");
    const envelope = await readTaskInstructionEnvelope(prisma, { taskId: task.id });
    if (!envelope) throw new Error("expected an envelope");
    const parsed = parseTaskInstructionEnvelope(envelope);
    expect(parsed.revision).toBe(3);
    expect(parsed.amendments.map((item) => item.seq)).toEqual([1, 2]);
    expect(parseRunInstructionRef(second.ref).consumedRevision).toBe(3);
  });

  it("fails closed after a Thread clear and refuses to retry the cleared Task", async () => {
    const { task, botId, threadId } = await newTask("Original before clear", "clear");
    await append({ task, threadId }, "Amended before clear", "clear-1");
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "failed",
        trigger: "user",
      },
    });
    await prisma.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        type: "run.failed",
        payload: { error: "test failure" },
      }),
    );
    expect((await readTaskInstructionEnvelope(prisma, { taskId: task.id }))?.revision).toBe(2);

    await clearThread(prisma, { spaceId: id, threadId, botId });

    await expect(readTaskInstructionEnvelope(prisma, { taskId: task.id })).rejects.toBeInstanceOf(
      TaskInstructionIntegrityError,
    );
    // An append after clear must not resurrect a partial instruction log.
    await expect(append({ task, threadId }, "After clear", "clear-2")).rejects.toBeInstanceOf(
      TaskInstructionIntegrityError,
    );
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      prompt: "Original before clear",
      revision: 2,
    });
    expect(await prisma.message.count({ where: { threadId } })).toBe(0);
    expect(await prisma.event.count({ where: { threadId, type: "task.amended" } })).toBe(0);
    await expect(
      createManualRetryRun(prisma, {
        spaceId: id,
        userId: id,
        runId: run.id,
        clientNonce: "retry-after-clear",
      }),
    ).rejects.toMatchObject({ reason: "thread_cleared" });
  });

  it("keeps secret ask plaintext out of the instruction log", async () => {
    const { task, run, message, threadId } = await waitingRun("Original secret ask", "secret", [
      {
        kind: "ask",
        text: "API key",
        status: "pending",
        input: "secret",
        purpose: "api_key",
        credential: {
          name: "example_api",
          origin: "https://api.example.test",
          auth: { type: "bearer" as const },
        },
      },
    ]);
    const intervention = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    let seen = "";
    const result = await resolveIntervention(
      prisma,
      {
        spaceId: id,
        threadId,
        interventionId: intervention.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: SECRET,
      },
      undefined,
      {
        store: async (input) => {
          seen = input.plaintext;
        },
      },
    );
    expect(result.outcome).toBe("accepted");
    expect(seen).toBe(SECRET);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1);
    expect(await prisma.event.count({ where: { threadId, type: "task.amended" } })).toBe(0);
    const stored = JSON.stringify({
      task: await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
      message: await prisma.message.findUniqueOrThrow({ where: { id: message.id } }),
      events: await prisma.event.findMany({ where: { threadId } }),
    });
    expect(stored).not.toContain(SECRET);
  });
});
