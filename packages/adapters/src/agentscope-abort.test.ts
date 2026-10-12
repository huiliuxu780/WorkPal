import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";

describe("AgentScope run abort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runtimeWithController(runId: string) {
    const runtime = new AgentScopeAgentRuntime();
    const controller = new AbortController();
    (runtime as unknown as { active: Map<string, AbortController> }).active.set(runId, controller);
    return { runtime, controller };
  }

  it("aborts the local controller before a failing remote DELETE", async () => {
    const { runtime, controller } = runtimeWithController("run-1");
    let abortedBeforeFetch = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        abortedBeforeFetch = controller.signal.aborted;
        throw new Error("network down");
      }),
    );
    await expect(runtime.abort("run-1")).rejects.toThrow("network down");
    expect(abortedBeforeFetch).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("treats HTTP 404 as a successful abort", async () => {
    const { runtime, controller } = runtimeWithController("run-2");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(runtime.abort("run-2")).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
  });

  it("throws when the remote DELETE returns a non-404 error", async () => {
    const { runtime, controller } = runtimeWithController("run-3");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(runtime.abort("run-3")).rejects.toThrow("AgentScope run abort failed (503)");
    expect(controller.signal.aborted).toBe(true);
  });
});
