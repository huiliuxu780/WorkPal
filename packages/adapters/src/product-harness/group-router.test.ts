import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { runGroupRouter } from "./group-router.js";

const members = [
  { id: "finance", name: "Finance", title: "Budget owner", description: "spreadsheets" },
  { id: "coding", name: "Coding", title: "Engineer", description: "software architecture" },
];

const routing = { message: "which CRM should we buy?", members, leadBotId: "finance" };
const identity = { spaceId: "space-1", userId: "user-1", botId: "finance" };
const model = { provider: "openai", id: "gpt-mini" };

function fakeRuntime(outputs: Array<{ text?: string; throw?: Error }>) {
  const requests: AgentRunRequest[] = [];
  let call = 0;
  const runtime = {
    describe: () => ({ capabilities: {} }),
    run(request: AgentRunRequest) {
      requests.push(request);
      const output = outputs[call++] ?? { throw: new Error("no scripted output") };
      return (async function* () {
        if (output.throw) throw output.throw;
        yield { type: "done", text: output.text ?? "" };
      })();
    },
    abort: async () => {},
  } as unknown as AgentRuntime;
  return { runtime, requests };
}

describe("runGroupRouter", () => {
  it("resolves a valid decision and runs the isolated auxiliary execution", async () => {
    const { runtime, requests } = fakeRuntime([
      {
        text: '{"ownerBotId":"coding","responseMode":"single","reasonCode":"specialist_match","confidence":"high"}',
      },
    ]);

    const decision = await runGroupRouter({ config: { runtime, model }, routing, identity });

    expect(decision).toEqual({
      ownerBotId: "coding",
      responseMode: "single",
      reasonCode: "specialist_match",
      confidence: "high",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    // Isolation contract: turn-routing scope, no tools, no history, no skills,
    // and a synthetic session distinct from any real chat thread/run.
    expect(request.executionScope).toBe("turn-routing");
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.skills).toBeUndefined();
    expect(request.botId).toBe("finance");
    expect(request.threadId).toMatch(/^turn-routing:/);
    expect(request.runId).toBe(request.threadId);
    expect(request.threadId).not.toBe("thread-1");
    expect(request.prompt).toContain("id=coding");
  });

  it("tolerates markdown-fenced JSON output", async () => {
    const { runtime } = fakeRuntime([
      {
        text: '```json\n{"ownerBotId":"finance","responseMode":"single","reasonCode":"generalist_match","confidence":"medium"}\n```',
      },
    ]);
    const decision = await runGroupRouter({ config: { runtime, model }, routing, identity });
    expect(decision?.ownerBotId).toBe("finance");
  });

  it("rejects an invented bot id", async () => {
    const { runtime } = fakeRuntime([
      {
        text: '{"ownerBotId":"hal-9000","responseMode":"single","reasonCode":"specialist_match","confidence":"high"}',
      },
    ]);
    await expect(
      runGroupRouter({ config: { runtime, model }, routing, identity }),
    ).resolves.toBeNull();
  });

  it("rejects multi answers and free-form reasoning", async () => {
    const multi = fakeRuntime([
      {
        text: '{"ownerBotId":"coding","responseMode":"multi","reasonCode":"collaboration_request","confidence":"high"}',
      },
    ]);
    expect(await runGroupRouter({ config: { runtime: multi.runtime, model }, routing, identity })).toBeNull();

    const prose = fakeRuntime([{ text: "I think Coding would be best here." }]);
    expect(await runGroupRouter({ config: { runtime: prose.runtime, model }, routing, identity })).toBeNull();
  });

  it("returns null on runtime failure and never throws at the caller", async () => {
    const { runtime } = fakeRuntime([{ throw: new Error("upstream timeout") }]);
    await expect(runGroupRouter({ config: { runtime, model }, routing, identity })).resolves.toBeNull();
  });

  it("skips the model call entirely when no router model is resolvable", async () => {
    const { runtime, requests } = fakeRuntime([{ text: "{}" }]);
    const decision = await runGroupRouter({ config: { runtime, model: null }, routing, identity });
    expect(decision).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
