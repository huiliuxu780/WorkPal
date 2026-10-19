// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const memoryRpc = vi.hoisted(() => ({
  factsList: vi.fn(),
  confirm: vi.fn(),
  correct: vi.fn(),
  reject: vi.fn(),
  remove: vi.fn(),
  evidenceList: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    memory: {
      facts: {
        list: memoryRpc.factsList,
        confirm: memoryRpc.confirm,
        correct: memoryRpc.correct,
        reject: memoryRpc.reject,
        delete: memoryRpc.remove,
      },
      factEvidence: { list: memoryRpc.evidenceList },
    },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Skeleton: Container,
  };
});

import { MemoryFactList } from "./memory-facts";

function fact(overrides: Record<string, unknown>) {
  return {
    id: "fact-1",
    scopeKind: "bot",
    scopeId: "bot-1",
    kind: "explicit_preference",
    text: "Prefers short answers",
    literalValues: null,
    language: null,
    origin: "user_confirmed",
    state: "active",
    revision: 1,
    ownerUserId: "user-1",
    botId: "bot-1",
    validFrom: null,
    expiresAt: null,
    expired: false,
    learnedAt: "2026-10-01T00:00:00.000Z",
    lastConfirmedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    evidenceThreadCount: 1,
    evidenceCount: 1,
    supersedesFactId: null,
    promotionSourceFactId: null,
    sourceDocumentId: null,
    indexCleanupPending: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  memoryRpc.evidenceList.mockResolvedValue([]);
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryFactList botId="bot-1" testId="facts" />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    },
    button: (name: string) => {
      const found = [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes(name),
      );
      if (!found) throw new Error(`Missing button: ${name}`);
      return found as HTMLButtonElement;
    },
  };
}

it("groups remembered, pending and expired facts and confirms a candidate", async () => {
  memoryRpc.factsList.mockResolvedValue({
    facts: [
      fact({ id: "f-active", text: "Deploy on sundays" }),
      fact({
        id: "f-candidate",
        text: "Likes friday summaries",
        state: "candidate",
        origin: "model_candidate",
        evidenceThreadCount: 4,
      }),
      fact({ id: "f-expired", text: "Old office code", expired: true, expiresAt: "2026-01-01T00:00:00.000Z" }),
    ],
  });
  memoryRpc.confirm.mockResolvedValue({ status: "updated", fact: fact({ id: "f-candidate", state: "active" }) });
  const view = await mount();
  try {
    expect(view.container.querySelector('[data-testid="facts-remembered"]')?.textContent).toContain(
      "Deploy on sundays",
    );
    expect(view.container.querySelector('[data-testid="facts-pending"]')?.textContent).toContain(
      "Likes friday summaries",
    );
    expect(view.container.querySelector('[data-testid="facts-pending"]')?.textContent).toContain(
      "from 4 conversations",
    );
    expect(view.container.querySelector('[data-testid="facts-expired"]')?.textContent).toContain(
      "Old office code",
    );

    // Confirm the candidate: receipt only after the mutation succeeded.
    await act(async () => {
      view.button("Likes friday summaries").click();
    });
    await act(async () => {
      view.button("Confirm").click();
    });
    expect(memoryRpc.confirm).toHaveBeenCalledWith({ factId: "f-candidate", expectedRevision: 1 });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Remembered");
  } finally {
    await view.unmount();
  }
});

it("surfaces a version conflict without overwriting and reloads", async () => {
  memoryRpc.factsList.mockResolvedValue({
    facts: [fact({ id: "f-1", revision: 3, text: "Deploy on sundays" })],
  });
  memoryRpc.remove.mockResolvedValue({ status: "conflict", currentRevision: 4, fact: null });
  const view = await mount();
  try {
    await act(async () => {
      view.button("Deploy on sundays").click();
    });
    await act(async () => {
      view.button("Delete").click();
    });
    await act(async () => {
      view.button("Confirm delete").click();
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "This memory changed elsewhere; showing the latest version.",
    );
    // The list was reloaded so the user acts on the current revision.
    expect(memoryRpc.factsList.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    await view.unmount();
  }
});

it("shows the pending index-cleanup state on a deleted-but-queued fact", async () => {
  memoryRpc.factsList.mockResolvedValue({
    facts: [fact({ id: "f-1", indexCleanupPending: true })],
  });
  const view = await mount();
  try {
    expect(view.container.textContent).toContain("Cleaning up indexes…");
  } finally {
    await view.unmount();
  }
});
