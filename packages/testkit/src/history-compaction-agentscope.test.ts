import { AgentScopeAgentRuntime } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.skipIf(!process.env.AGENTSCOPE_URL)("history compaction with AgentScope Java", () => {
  // Real-chain coverage uses the truly empty completion (""). AgentScope
  // 2.0.3 RE-REASONS on a whitespace-only response instead of completing
  // (verified by event-stream trace: one run consumes both emulator steps
  // and completes with the concatenated text), so a whitespace case here
  // would pin emulator mechanics, not product behavior. The whitespace-trim
  // guard stays pinned at the unit level (history-compaction.test.ts,
  // controlled fake runtime): done text that trims to empty never advances
  // the cursor.
  it.each([""])("preserves history and retries an empty summary (%j)", async (text) => {
    const summary = "Earlier decisions and the new conversation facts.";
    const server = await startModelEmulator({
      apiKey: "compaction-fixture-key",
      steps: [text, summary].map((response) => ({
        expect(request) {
          expect(JSON.stringify(request.messages)).toContain("Earlier decisions.");
          expect(JSON.stringify(request.messages)).toContain("New conversation facts.");
        },
        response: { type: "text", text: response },
      })),
    });
    cleanups.push(() => server.close());
    // Unique thread per case: the auxiliary session slot is keyed by
    // scope+runId, so a shared id would leak the previous case's persisted
    // AgentScope state into this one.
    const threadId = `fixture-thread-${text.trim().length}-${text.length}`;
    const thread = {
      id: threadId,
      botId: "fixture-bot",
      spaceId: "fixture-space",
      userId: "fixture-user",
      nextMessageSeq: 51,
      historyCompactedUpToSeq: 49,
      historyCompactionGeneration: 0,
      historyCompactionSummary: "Earlier decisions.",
    };
    const updateMany = vi.fn(
      async (args: {
        data: { historyCompactedUpToSeq: number; historyCompactionSummary: string };
      }) => {
        Object.assign(thread, args.data);
        return { count: 1 };
      },
    );
    const prisma = {
      // persistCompactionRevision wraps the revision insert and the pointer
      // CAS in one interactive transaction.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
      thread: { findUniqueOrThrow: vi.fn(async () => thread), updateMany },
      threadCompactionRevision: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: `rev-${args.data.toSeqInclusive}`,
          ...args.data,
        })),
      },
      message: {
        findMany: vi.fn(async () => [
          {
            seq: 50,
            role: "user",
            blocks: [{ kind: "text", text: "New conversation facts." }],
          },
        ]),
      },
    };
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      runtime: new AgentScopeAgentRuntime(),
      jobs,
      memoryProviders,
      memoryDigestKey: "test-digest-key",
      resolveModel: async () => server.model,
    };

    // The contract is: an empty summary never advances the cursor and stays
    // retryable. The error surface depends on how the runtime reports an
    // empty completion — AgentScope 2.0.3 ends the run without a result
    // event ("Agent execution failed"); the TS-level guard message
    // ("summarizer returned no summary") applies when a done event arrives
    // with empty text. Both are retryable throws; pinning either string
    // alone would couple this suite to runtime-version behavior.
    await expect(compactHistory(deps, thread.id)).rejects.toThrow(
      /summarizer returned no summary|Agent execution failed/,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(thread.historyCompactedUpToSeq).toBe(49);
    expect(thread.historyCompactionSummary).toBe("Earlier decisions.");
    expect(memoryProviders.resolve).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();

    await compactHistory(deps, thread.id);
    server.assertComplete();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: thread.id,
        historyCompactedUpToSeq: 49,
        historyCompactionGeneration: 0,
      },
      data: { historyCompactedUpToSeq: 50, historyCompactionSummary: summary },
    });
    expect(memoryProviders.resolve).toHaveBeenCalledOnce();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
