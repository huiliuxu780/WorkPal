import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor, type ExecutorDeps } from "./executor.js";

// #93 review P1: the pinned resolver must cover every model configuration a
// completed run could have pinned — user-connected credentials, the
// deployment key, the credentialless deployment-settings local model and the
// scripted runtime fallback — while NEVER resolving a substitute identity.
function executorFor(options: {
  deploymentModelKey?: string;
  settings?: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  scripted?: boolean;
}) {
  const prisma = {
    // No connected credentials: the connected chain must fail so the exact
    // credentialless matches below are what resolve the pin.
    spaceModelPreference: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    userModelCredential: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findUnique: vi.fn(async () => options.settings ?? null) },
    secret: { findFirst: vi.fn(async () => null) },
  };
  const runtime = {
    describe: () => ({
      id: "test-runtime",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: false,
        scripted: options.scripted ?? false,
      },
    }),
  };
  const deps = {
    prisma,
    runtime,
    deploymentModelKey: options.deploymentModelKey,
    web: {},
    browser: {},
    sandbox: {},
    secretStore: { load: () => "" },
  } as unknown as ExecutorDeps;
  return createRunExecutor(deps);
}

const scope = { userId: "user-1", spaceId: "space-1" };

describe("resolvePinnedModel exact identity resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the pinned deployment-key model when no user credential is connected", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "openrouter/pinned");
    const executor = executorFor({ deploymentModelKey: "deployment-key" });

    await expect(
      executor.resolvePinnedModel(scope, "openrouter", "openrouter/pinned"),
    ).resolves.toMatchObject({
      provider: "openrouter",
      id: "openrouter/pinned",
      apiKey: "deployment-key",
    });
  });

  it("resolves the credentialless local model configured in deployment settings", async () => {
    const executor = executorFor({
      settings: { defaultModelProvider: "openai-compatible", defaultModelId: " local/model " },
    });

    const model = await executor.resolvePinnedModel(scope, "openai-compatible", "local/model");

    expect(model).toMatchObject({ provider: "openai-compatible", id: "local/model" });
    expect(model.apiKey).toBeUndefined();
  });

  it("resolves the scripted runtime fallback identity so scripted pins skip instead of failing", async () => {
    const executor = executorFor({ scripted: true });

    await expect(executor.resolvePinnedModel(scope, "scripted", "scripted")).resolves.toMatchObject(
      {
        provider: "scripted",
        id: "scripted",
      },
    );
  });

  it("never substitutes: a different pinned model fails visibly despite an available deployment key", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "openrouter/pinned");
    const executor = executorFor({ deploymentModelKey: "deployment-key" });

    await expect(
      executor.resolvePinnedModel(scope, "openrouter", "openrouter/other"),
    ).rejects.toThrow(/Connect that model provider first/);
  });

  it("never substitutes: a different provider fails visibly despite a settings local model", async () => {
    const executor = executorFor({
      settings: { defaultModelProvider: "openai-compatible", defaultModelId: "local/model" },
    });

    await expect(executor.resolvePinnedModel(scope, "openrouter", "local/model")).rejects.toThrow(
      /Connect that model provider first/,
    );
  });

  it("keeps failing visibly when nothing is configured for the pinned identity", async () => {
    const executor = executorFor({});

    await expect(executor.resolvePinnedModel(scope, "openrouter", "any/model")).rejects.toThrow(
      /Connect that model provider first/,
    );
  });
});
