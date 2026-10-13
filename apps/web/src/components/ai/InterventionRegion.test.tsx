// @vitest-environment jsdom

import type { InterventionView, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveIntervention = vi.hoisted(() => vi.fn());

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { resolveIntervention } },
}));

import { InterventionRegion } from "./InterventionRegion";

function view(overrides: Partial<InterventionView>): InterventionView {
  return {
    id: "intervention-1",
    revision: 1,
    kind: "approval",
    status: "pending",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    botId: "bot-1",
    messageId: "message-approval",
    createdAt: "2026-10-12T00:00:00.000Z",
    requestingActor: { botId: "bot-1" },
    approval: {
      effectId: "effect-1",
      effectStatus: "intended",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
    ...overrides,
  };
}

function message(id: string, block: ThreadMessage["blocks"][number]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: [block],
    runId: "run-1",
    createdAt: "2026-10-12T00:00:00.000Z",
  };
}

const approvalMessage = message("message-approval", {
  kind: "ask",
  text: "Send the email?",
  status: "pending",
  approvalEffectId: "effect-1",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow" },
    { id: "deny", label: "Deny" },
  ],
});
const inputMessage = message("message-input", {
  kind: "ask",
  text: "Which city?",
  status: "pending",
});

function Harness({
  initial,
  onSettled,
}: {
  initial: InterventionView[];
  onSettled?: (view: InterventionView) => void;
}) {
  const [items, setItems] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setItems((current) => current.map((item) => item.kind === "approval" ? { ...item, revision: item.revision + 1 } : item))}>
        bump approval
      </button>
      <InterventionRegion
        interventions={items}
        messages={[approvalMessage, inputMessage]}
        target={{ botId: "bot-1" }}
        onSettled={(next) => {
          onSettled?.(next);
          setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
        }}
      />
    </>
  );
}

describe("InterventionRegion", () => {
  beforeEach(() => {
    resolveIntervention.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("places approval before input and keeps the input card mounted", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const input = view({
      id: "input-1",
      kind: "input",
      messageId: "message-input",
      createdAt: "2026-10-12T00:00:01.000Z",
      approval: undefined,
      input: { mode: "text" },
    });
    try {
      await act(async () => {
        root.render(<Harness initial={[input, view({})]} />);
      });
      const region = host.querySelector('[role="region"]');
      expect(region?.getAttribute("aria-label")).toBe("需要你处理");
      const ids = [...host.querySelectorAll("[data-intervention-id]")].map((node) =>
        node.getAttribute("data-intervention-id"),
      );
      expect(ids).toEqual(["intervention-1", "input-1"]);
      expect(host.querySelector("[data-testid=intervention-approvals]")?.compareDocumentPosition(
        host.querySelector("[data-testid=intervention-inputs]")!,
      )).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      const mount = host.querySelector('[data-intervention-id="input-1"]')?.getAttribute("data-mount");
      const edit = [...host.querySelectorAll("button")].find((button) => button.textContent === "Edit first");
      await act(async () => {
        edit?.click();
      });
      const field = host.querySelector<HTMLInputElement>('input[aria-label="Answer"]');
      await act(async () => {
        if (!field) return;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(field, "Paris");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field?.value).toBe("Paris");
      await act(async () => {
        [...host.querySelectorAll("button")].find((button) => button.textContent === "bump approval")?.click();
      });
      expect(host.querySelector('[data-intervention-id="input-1"]')?.getAttribute("data-mount")).toBe(mount);
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Answer"]')?.value).toBe("Paris");
      const deny = [...host.querySelectorAll("button")].find((button) => button.textContent === "Deny");
      expect(deny?.tagName).toBe("BUTTON");
      deny?.focus();
      expect(document.activeElement).toBe(deny);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("moves focus to the authoritative status after another client handles the card", async () => {
    resolveIntervention.mockResolvedValue({
      outcome: "already_handled",
      intervention: view({
        status: "answered",
        revision: 2,
        approval: { effectId: "effect-1", decision: "denied", effectStatus: "denied" },
      }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<Harness initial={[view({})]} />);
      });
      const deny = [...host.querySelectorAll("button")].find((button) => button.textContent === "Deny");
      await act(async () => {
        deny?.click();
      });
      const authority = host.querySelector<HTMLElement>('[data-testid="intervention-authority"]');
      expect(authority?.textContent).toBe("Denied");
      expect(document.activeElement).toBe(authority);
      expect(resolveIntervention).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: "bot-1",
          interventionId: "intervention-1",
          answer: "deny",
        }),
      );
      const submissionId = resolveIntervention.mock.calls[0]?.[0]?.clientSubmissionId as string;
      expect(submissionId.length).toBeGreaterThanOrEqual(8);
      expect(submissionId).not.toContain("deny");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not store a secret draft", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const secret = view({
      id: "secret-1",
      kind: "input",
      messageId: "message-secret",
      approval: undefined,
      input: { mode: "secret", purpose: "api_key" },
    });
    const secretMessage = message("message-secret", {
      kind: "ask",
      text: "API key",
      status: "pending",
      input: "secret",
      purpose: "api_key",
    });
    try {
      await act(async () => {
        root.render(
          <InterventionRegion
            interventions={[secret]}
            messages={[secretMessage]}
            target={{ botId: "bot-1" }}
            onSettled={() => undefined}
          />,
        );
      });
      const field = host.querySelector<HTMLInputElement>('input[type="password"]');
      const secretValue = "sk-test-secret-value";
      await act(async () => {
        if (!field) return;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(field, secretValue);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(JSON.stringify(localStorage)).not.toContain(secretValue);
      expect(JSON.stringify(sessionStorage)).not.toContain(secretValue);
      expect(host.querySelector("[data-testid=secret-ask-card]")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("still renders a legacy pending id", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <InterventionRegion
            interventions={[
              view({
                id: "legacy_message-approval",
                kind: "input",
                approval: undefined,
                input: { mode: "text" },
              }),
            ]}
            messages={[approvalMessage]}
            target={{ botId: "bot-1" }}
            onSettled={() => undefined}
          />,
        );
      });
      expect(host.querySelector('[data-intervention-id="legacy_message-approval"]')).not.toBeNull();
      expect(host.textContent).toContain("Send the email?");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("restores a terminal card from the projection when its message is off the page", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const secret = view({
      id: "secret-off-page",
      kind: "input",
      status: "answered",
      revision: 2,
      messageId: "message-not-loaded",
      approval: undefined,
      input: { mode: "secret", purpose: "api_key" },
      presentation: {
        text: "Paste the API key for the import",
        credential: { name: "import_api", origin: "https://api.example.test", authType: "bearer" },
      },
    });
    try {
      await act(async () => {
        root.render(
          <InterventionRegion
            interventions={[secret]}
            messages={[]}
            target={{ botId: "bot-1" }}
            onSettled={() => undefined}
          />,
        );
      });
      const region = host.querySelector('[role="region"]');
      expect(region?.getAttribute("aria-label")).toBe("需要你处理");
      expect(region?.querySelector('[data-intervention-id="secret-off-page"]')).not.toBeNull();
      expect(region?.textContent).toContain("Paste the API key for the import");
      expect(region?.querySelector('[data-testid="intervention-authority"]')?.textContent).toBe("Saved");
      expect(host.querySelector('input[type="password"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("shows a restored approval decision and the effect status separately", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const approval = view({
      id: "approval-off-page",
      status: "answered",
      revision: 2,
      messageId: "message-not-loaded",
      approval: { effectId: "effect-1", decision: "approved", effectStatus: "executing" },
      presentation: { text: "Send the email to the client?", detail: "Body: 4 KB attachment" },
    });
    try {
      await act(async () => {
        root.render(
          <InterventionRegion
            interventions={[approval]}
            messages={[]}
            target={{ botId: "bot-1" }}
            onSettled={() => undefined}
          />,
        );
      });
      const card = host.querySelector('[data-intervention-id="approval-off-page"]');
      expect(card?.textContent).toContain("Send the email to the client?");
      expect(card?.querySelector('[data-testid="intervention-authority"]')?.textContent).toBe("Approved");
      expect(card?.querySelector('[data-testid="intervention-effect"]')?.textContent).toBe("Effect running");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("renders a cancelled restored card as inactive with the Cancelled authority", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const cancelled = view({
      id: "cancelled-1",
      kind: "input",
      status: "cancelled",
      revision: 2,
      messageId: "message-not-loaded",
      approval: undefined,
      input: { mode: "text" },
      presentation: { text: "Which city?" },
    });
    try {
      await act(async () => {
        root.render(
          <InterventionRegion
            interventions={[cancelled]}
            messages={[]}
            target={{ botId: "bot-1" }}
            onSettled={() => undefined}
          />,
        );
      });
      const card = host.querySelector('[data-intervention-id="cancelled-1"]');
      expect(card?.querySelector('[data-testid="intervention-authority"]')?.textContent).toBe("Cancelled");
      expect(host.querySelector('input[aria-label="Answer"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
