// @vitest-environment jsdom

import type {
  ActionApprovalPayload,
  ActionApprovalView,
  InputRequestPayload,
  InputRequestView,
  InterventionPresentation,
  PlanReviewView,
  SessionControlView,
} from "@rakazo/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const mocks = vi.hoisted(() => ({
  resolveIntervention: vi.fn(),
  updateDraft: vi.fn(),
  saveSkill: vi.fn(),
  removeSkill: vi.fn(),
  beginConnection: vi.fn(),
  completeConnection: vi.fn(),
  appConnected: vi.fn(),
  approveAssignment: vi.fn(),
  dismissAssignment: vi.fn(),
  releaseComputer: vi.fn(),
  connectMcpOauth: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../../lib/rpc", () => ({
  rpc: {
    threads: { resolveIntervention: mocks.resolveIntervention },
    skills: {
      updateDraft: mocks.updateDraft,
      save: mocks.saveSkill,
      remove: mocks.removeSkill,
    },
    connections: {
      begin: mocks.beginConnection,
      complete: mocks.completeConnection,
    },
    onboarding: { appConnected: mocks.appConnected },
    mcp: {
      assignments: {
        approve: mocks.approveAssignment,
        dismiss: mocks.dismissAssignment,
      },
    },
    computer: { release: mocks.releaseComputer },
  },
}));
vi.mock("../../../lib/mcp-connect", () => ({
  connectMcpOauth: mocks.connectMcpOauth,
}));

import { ActionApprovalCard, GroupMembershipFailureCard } from "./ActionApprovalCard";
import { InputRequestCard } from "./InputRequestCard";
import { InteractionRegion } from "./InteractionRegion";
import { PlanReviewInteractionCard } from "./PlanReviewInteractionCard";
import { SessionControlCard } from "./SessionControlCard";

const ISO = "2026-10-25T09:30:00.000Z";
const presentation: InterventionPresentation = {
  text: "Review the outbound send",
  detail: "One email to the requester.",
};
const source = {
  spaceId: "space-1",
  threadId: "thread-1",
  messageId: "message-1",
  runId: "run-1",
  botId: "bot-1",
};
const base = {
  revision: 1,
  createdAt: ISO,
  expiresAt: null,
  attentionAt: ISO,
  source,
  presentation,
};

const inputView = (
  input: InputRequestPayload,
  overrides: Partial<InputRequestView> = {},
): InputRequestView => ({
  kind: "input_request",
  interactionId: "i-input",
  status: "pending",
  ...base,
  input,
  ...overrides,
});

const actionView = (
  approval: ActionApprovalPayload,
  overrides: Partial<ActionApprovalView> = {},
): ActionApprovalView => ({
  kind: "action_approval",
  interactionId: "i-action",
  status: "pending",
  decision: null,
  ...base,
  approval,
  ...overrides,
});

const planView = (overrides: Partial<PlanReviewView> = {}): PlanReviewView => ({
  kind: "plan_review",
  interactionId: "i-plan",
  status: "pending",
  decision: null,
  feedback: null,
  ...base,
  plan: {
    planId: "plan-1",
    contentVersion: 2,
    revision: 1,
    goal: "Ship the reviewed summary",
    source: "plan_exit",
    items: [
      { id: "p1", title: "Inspect the data", status: "completed" },
      { id: "p2", title: "Draft the summary", status: "pending" },
    ],
  },
  ...overrides,
});

const sessionView = (
  action: "takeover" | "return",
  overrides: Partial<SessionControlView> = {},
): SessionControlView => ({
  kind: "session_control",
  interactionId: `i-${action}`,
  revision: 1,
  status: "pending",
  createdAt: ISO,
  expiresAt: null,
  attentionAt: ISO,
  source,
  presentation,
  action,
  runId: "run-1",
  botId: "bot-1",
  computerId: "computer-1",
  executionLeaseActive: true,
  controlLeaseExpiresAt: action === "return" ? "2026-10-25T10:00:00.000Z" : null,
  ...overrides,
});

const toolApproval = (overrides: Partial<Extract<ActionApprovalPayload, { kind: "tool" }>> = {}) =>
  ({
    kind: "tool",
    authority: "external_effect",
    effectId: "effect-1",
    effectStatus: "intended",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ],
    ...overrides,
  }) satisfies ActionApprovalPayload;

const paymentApproval = (): ActionApprovalPayload => ({
  kind: "payment",
  authority: "external_effect",
  effectId: "effect-payment",
  effectStatus: "intended",
  amount: "42.50",
  currency: "USD",
  merchant: "Paper Supply",
  cardLast4: "4242",
});

const outboundApproval = (): ActionApprovalPayload => ({
  kind: "outbound",
  authority: "external_effect",
  effectId: "effect-outbound",
  effectStatus: "intended",
  channel: "email",
  recipientCount: 2,
  subject: "Weekly digest",
  fingerprint: "fp-12345678",
});

const routineApproval = (): ActionApprovalPayload => ({
  kind: "routine",
  authority: "business_transaction",
  routineId: "routine-1",
  action: "update",
  cron: "0 9 * * 1",
  timezone: "Asia/Shanghai",
});

const installApproval = (): ActionApprovalPayload => ({
  kind: "install",
  authority: "business_transaction",
  capabilityKind: "skill",
  name: "Digest writer",
  source: "workspace",
  version: "2",
});

const skillApproval = (): ActionApprovalPayload => ({
  kind: "skill_save",
  authority: "business_transaction",
  skillId: "skill-1",
  name: "Weekly digest",
  goal: "Summarize the week in five bullets.",
  contentRevision: 1,
  playbook: {
    whenToUse: "Every Friday afternoon.",
    inputs: ["inbox", "calendar"],
    steps: ["Read the threads", "Write five bullets"],
    howToCheck: "Every bullet cites a thread.",
    whatToReturn: "A five-bullet summary.",
    approvalBoundaries: "Never send without approval.",
    failureHandling: "Report missing sources.",
  },
});

const appAuthorization = (): ActionApprovalPayload => ({
  kind: "connect.app_authorization",
  authority: "business_transaction",
  connectorId: "connector-1",
  provider: "notion",
  name: "Notion",
  description: "Read the team wiki.",
});

const mcpAssignment = (): ActionApprovalPayload => ({
  kind: "connect.mcp_assignment",
  authority: "business_transaction",
  serverId: "server-1",
  name: "Search server",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test",
  needsOAuth: false,
  allowAllTools: true,
});

const groupMembership = (): ActionApprovalPayload => {
  const groupPresentation = {
    text: "Add Scout to “Design”?",
    detail: "Scout can read the discussion and continue this work.",
  };
  return {
    kind: "group_membership",
    authority: "business_transaction",
    action: "add_bot_to_group",
    groupId: "group-1",
    botId: "bot-1",
    messageGroupRequestId: "request-1",
    requestRevision: 1,
    sourceThreadId: source.threadId,
    sourceMessageId: source.messageId,
    presentation: groupPresentation,
  } as ActionApprovalPayload;
};

const target = { botId: "bot-1" };

type Rendered = { root: Root; host: HTMLElement };
const rendered: Rendered[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  rendered.push({ root, host });
  await act(async () => {
    root.render(node);
  });
  return host;
}

async function typeInto(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
): Promise<void> {
  if (!element) throw new Error("field missing");
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(host: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function byTestId(host: ParentNode, testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolveIntervention.mockResolvedValue({ outcome: "applied", intervention: null });
  mocks.updateDraft.mockResolvedValue(undefined);
  mocks.saveSkill.mockResolvedValue(undefined);
  mocks.removeSkill.mockResolvedValue(undefined);
  mocks.beginConnection.mockResolvedValue({ connectionId: "connection-1" });
  mocks.completeConnection.mockResolvedValue({ status: "connected" });
  mocks.appConnected.mockResolvedValue(undefined);
  mocks.approveAssignment.mockResolvedValue(undefined);
  mocks.dismissAssignment.mockResolvedValue(undefined);
  mocks.releaseComputer.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const { root, host } of rendered.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  document.body.innerHTML = "";
});

describe("interaction card shell", () => {
  it("shows a pending card with source and a readable time, never internal IDs", async () => {
    const host = await render(
      <InputRequestCard
        view={inputView({ mode: "question", prompt: "Which city?", placeholder: null })}
        target={target}
        botName="Writer"
        conversationName="Design room"
      />,
    );

    const card = byTestId(host, "interaction-card");
    expect(card?.getAttribute("data-kind")).toBe("input_request");
    expect(card?.getAttribute("data-tone")).toBe("wait");
    expect(card?.className).toContain("bg-muted/70");
    expect(card?.className).not.toContain("opacity-");
    expect(card?.textContent).toContain("Waiting for your answer");
    expect(card?.textContent).toContain("Bot: Writer");
    expect(card?.textContent).toContain("Design room");
    const expectedTime = new Date(ISO).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(byTestId(host, "interaction-source")?.textContent).toContain(expectedTime);
    expect(host.textContent).not.toContain("run-1");
    expect(host.textContent).not.toContain("message-1");
    expect(host.textContent).not.toContain("i-input");
  });

  it("keeps a terminal card legible with an inset outline instead of opacity", async () => {
    const host = await render(
      <PlanReviewInteractionCard
        view={planView({ status: "answered", decision: "approve", feedback: "Looks right" })}
        target={target}
      />,
    );

    const card = byTestId(host, "interaction-card");
    expect(card?.getAttribute("data-tone")).toBe("ok");
    expect(card?.className).toContain("bg-transparent");
    expect(card?.className).toContain("shadow-[inset_0_0_0_1px_var(--border)]");
    expect(card?.className).not.toContain("opacity-");
    expect(card?.textContent).toContain("Plan approved");
    expect(card?.textContent).toContain("Looks right");
    expect(byTestId(host, "approval-primary")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("input request card", () => {
  it("submits a question answer once with a stable submission id", async () => {
    const host = await render(
      <InputRequestCard
        view={inputView({ mode: "question", prompt: "Which city?", placeholder: "City" })}
        target={target}
      />,
    );
    const submit = byTestId(host, "input-card-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await typeInto(host.querySelector("textarea"), "Paris");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    expect(mocks.resolveIntervention).toHaveBeenCalledTimes(1);
    expect(mocks.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        interventionId: "i-input",
        answer: "Paris",
        clientSubmissionId: expect.any(String),
      }),
    );
    expect(host.textContent).toContain("Submitted. Syncing the current state");
  });

  it("masks a login secret, requires both fields, and clears it after saving", async () => {
    const host = await render(
      <InputRequestCard
        view={inputView({
          mode: "secret",
          prompt: "Sign in",
          purpose: "password",
          credential: { name: "Acme", origin: "https://acme.test", authType: "login" },
        })}
        target={target}
      />,
    );
    const username = host.querySelector<HTMLInputElement>('input[aria-label="Username"]');
    const secret = host.querySelector<HTMLInputElement>('input[aria-label="Password"]');
    expect(secret?.type).toBe("password");
    const submit = byTestId(host, "input-card-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await typeInto(username, "ada");
    expect(submit.disabled).toBe(true);
    await typeInto(secret, "hunter2");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flush();

    expect(mocks.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ answer: "hunter2", username: "ada" }),
    );
    expect(document.body.textContent).not.toContain("hunter2");
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it("validates required form fields locally before calling the server", async () => {
    const host = await render(
      <InputRequestCard
        view={inputView({
          mode: "form",
          prompt: "Shipping details",
          fields: [
            { id: "name", label: "Name", required: true, secret: false },
            { id: "note", label: "Note", required: false, secret: false },
          ],
        })}
        target={target}
      />,
    );

    await act(async () => (byTestId(host, "input-card-submit") as HTMLButtonElement).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Fill in this field");
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();

    await typeInto(host.querySelector("#input-field-i-input-name"), "Ada");
    await act(async () => (byTestId(host, "input-card-submit") as HTMLButtonElement).click());
    expect(mocks.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ answer: JSON.stringify({ name: "Ada" }) }),
    );
  });

  it("shows a masked saved item and never claims that selecting it charges", async () => {
    const host = await render(
      <InputRequestCard
        view={inputView({
          mode: "saved_item",
          prompt: "Which card?",
          itemKind: "card",
          items: [{ id: "card-1", label: "Team card", display: "•••• 4242" }],
        })}
        target={target}
      />,
    );

    expect(host.textContent).toContain("•••• 4242");
    expect(host.textContent).toContain("Selecting a saved item does not charge anything.");
    expect(host.textContent).not.toContain("Confirm payment");
    expect(byTestId(host, "input-card-submit")?.textContent).toContain("Confirm selection");
  });
});

describe("action approval cards", () => {
  it("limits a pending tool card to two buttons plus one more-options entry", async () => {
    const host = await render(
      <ActionApprovalCard
        view={actionView(toolApproval(), {
          presentation: { text: "Allow the lookup?", detail: "Reads one record." },
        })}
        target={target}
      />,
    );

    const actions = byTestId(host, "interaction-actions");
    expect(actions?.querySelectorAll("button")).toHaveLength(3);
    expect(byTestId(host, "approval-primary")?.textContent).toContain("Allow once");
    expect(byTestId(host, "approval-secondary")?.textContent).toContain("Deny");
    expect(byTestId(host, "approval-more")?.textContent).toContain("More options");
    expect(host.textContent).toContain(
      "completing the tool activity does not prove the external result",
    );

    await act(async () => (byTestId(host, "approval-more") as HTMLButtonElement).click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Always allow this tool");
  });

  it("separates the decision from the external effect result", async () => {
    const host = await render(
      <ActionApprovalCard
        view={actionView(toolApproval({ effectStatus: "failed" }), {
          status: "answered",
          decision: "approved",
        })}
        target={target}
      />,
    );

    expect(host.textContent).toContain("Allowed");
    expect(byTestId(host, "approval-effect")?.textContent).toContain("Effect failed");
    expect(byTestId(host, "approval-primary")).toBeNull();
  });

  it("shows payment facts and a distinct decline/confirm pair", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(paymentApproval())} target={target} />,
    );

    expect(host.textContent).toContain("Paper Supply");
    expect(host.textContent).toContain("USD 42.50");
    expect(host.textContent).toContain("•••• 4242");
    expect(byTestId(host, "approval-primary")?.textContent).toContain("Confirm payment");
    expect(byTestId(host, "approval-secondary")?.textContent).toContain("Decline payment");
  });

  it("binds an outbound decision to the revision and fingerprint in a read-only dialog", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(outboundApproval(), { revision: 3 })} target={target} />,
    );

    expect(host.textContent).toContain("Outbound draft · r3");
    await act(async () => (byTestId(host, "outbound-open") as HTMLButtonElement).click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("fp-12345678");
    expect(dialog?.textContent).toContain("Weekly digest");
    expect(dialog?.textContent).toContain("Closing this view does not reject, cancel, or send");
    expect(dialog?.querySelector("textarea")).toBeNull();
    expect(button(dialog!, "Edit")).toBeUndefined();

    await act(async () => button(dialog!, "Close")?.click());
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
  });

  it("shows the routine schedule without inventing one when absent", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(routineApproval())} target={target} />,
    );

    expect(host.textContent).toContain("Asia/Shanghai");
    expect(host.textContent).toContain("0 9 * * 1");
    expect(host.textContent).toContain("The result comes from the Routine transaction.");
  });

  it("keeps installation and authorization as two separate steps", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(installApproval())} target={target} />,
    );

    const steps = [...host.querySelectorAll('[data-testid="install-step"]')];
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
      "pending",
      "not_started",
    ]);
    expect(host.textContent).toContain(
      "Installation and authorization are separate back-end actions",
    );
  });
});

describe("skill save (A8)", () => {
  it("opens the full read-only playbook without changing the save request", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(skillApproval())} target={target} />,
    );

    await act(async () => (byTestId(host, "skill-save-open") as HTMLButtonElement).click());
    const dialog = document.querySelector('[data-testid="skill-playbook-dialog"]');
    for (const copy of [
      "Skill playbook",
      "Every Friday afternoon.",
      "inbox",
      "calendar",
      "Read the threads",
      "Every bullet cites a thread.",
      "A five-bullet summary.",
      "Never send without approval.",
      "Report missing sources.",
    ]) {
      expect(dialog?.textContent).toContain(copy);
    }
    expect(dialog?.querySelector("textarea, input")).toBeNull();
    expect(dialog?.textContent).toContain("Viewing this playbook does not change the skill");

    await act(async () => button(dialog!, "Close")?.click());
    expect(mocks.updateDraft).not.toHaveBeenCalled();
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
  });

  it("saves through the skill transactions rather than resolveIntervention", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(skillApproval())} target={target} />,
    );

    await act(async () => (byTestId(host, "skill-save-save") as HTMLButtonElement).click());

    expect(mocks.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1", name: "Weekly digest" }),
    );
    expect(mocks.saveSkill).toHaveBeenCalledWith({
      skillId: "skill-1",
      name: "Weekly digest",
    });
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Saved");
  });

  it("discards through skills.remove and then shows no decision buttons", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(skillApproval())} target={target} />,
    );

    await act(async () => (byTestId(host, "skill-save-discard") as HTMLButtonElement).click());

    expect(mocks.removeSkill).toHaveBeenCalledWith({ skillId: "skill-1" });
    expect(host.textContent).toContain("Discarded");
    expect(byTestId(host, "skill-save-save")).toBeNull();
  });

  it("restores the discarded card from the persisted cancelled view", async () => {
    const host = await render(
      <ActionApprovalCard
        view={actionView(skillApproval(), { status: "cancelled", decision: "denied" })}
        target={target}
      />,
    );

    expect(host.textContent).toContain("Discarded");
    expect(byTestId(host, "interaction-status")?.textContent).toContain("Discarded");
    expect(byTestId(host, "skill-save-save")).toBeNull();
    expect(byTestId(host, "skill-save-discard")).toBeNull();
    expect(mocks.removeSkill).not.toHaveBeenCalled();
  });
});

describe("account and assignment cards", () => {
  it("renders app authorization and MCP assignment as two separate A7 cards", async () => {
    const host = await render(
      <InteractionRegion
        interactions={[
          actionView(appAuthorization(), {
            interactionId: "i-app",
            presentation: { text: "AUTHORIZE-NOTION", detail: "Read the team wiki." },
          }),
          actionView(mcpAssignment(), { interactionId: "i-mcp" }),
        ]}
        target={target}
      />,
    );

    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="interaction-card"]')];
    expect(cards).toHaveLength(2);
    const app = cards.find((card) => card.textContent?.includes("AUTHORIZE-NOTION"));
    const mcp = cards.find((card) => card.textContent?.includes("MCP assignment"));
    expect(app).toBeDefined();
    expect(mcp).toBeDefined();
    expect(app?.textContent).not.toContain("allowAllTools");
    expect(app?.textContent).toContain("does not install a connector or approve individual tools");
    expect(byTestId(mcp!, "mcp-allow-all-tools")?.textContent).toContain("allowAllTools: true");
    expect(mcp?.textContent).toContain("Search server");
  });

  it("keeps the MCP risk note on the MCP card only", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(mcpAssignment())} target={target} />,
    );

    expect(byTestId(host, "mcp-allow-all-tools")?.textContent).toContain("High risk");
    expect(host.textContent).toContain("All tools on this server");
  });

  it("authorizes the app without claiming tool approval", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(appAuthorization())} target={target} />,
    );

    expect(host.textContent).toContain("does not install a connector or approve individual tools");
    await act(async () =>
      (byTestId(host, "app-authorization-approve") as HTMLButtonElement).click(),
    );

    expect(mocks.beginConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "notion", connectorId: "connector-1" }),
    );
    expect(mocks.appConnected).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-1", provider: "notion" }),
    );
    expect(host.textContent).toContain("Authorized");
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
  });

  it("exposes the allow-all-tools risk and routes to the assignment RPC", async () => {
    const host = await render(
      <ActionApprovalCard view={actionView(mcpAssignment())} target={target} />,
    );

    expect(byTestId(host, "mcp-allow-all-tools")?.textContent).toContain("allowAllTools: true");
    expect(host.textContent).toContain("All tools on this server");
    await act(async () => (byTestId(host, "mcp-assignment-approve") as HTMLButtonElement).click());

    expect(mocks.approveAssignment).toHaveBeenCalledWith({
      botId: "bot-1",
      serverId: "server-1",
      threadId: "thread-1",
    });
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
  });
});

describe("group membership exception (X-GROUP)", () => {
  it("uses the confirmed inline card, not the generic card shell", async () => {
    const onGroupDecision = vi.fn();
    const host = await render(
      <ActionApprovalCard
        view={actionView(groupMembership())}
        target={target}
        botName="Scout"
        groupNameOf={() => "Design"}
        onGroupDecision={onGroupDecision}
      />,
    );

    expect(byTestId(host, "interaction-card")).toBeNull();
    expect(byTestId(host, "group-membership-approval")?.textContent).toContain(
      "Add Scout to “Design”?",
    );
    expect(host.textContent).toContain("Join and continue");

    await act(async () =>
      (byTestId(host, "group-membership-approve") as HTMLButtonElement).click(),
    );
    expect(onGroupDecision).toHaveBeenCalledWith(expect.anything(), "approve");
    expect(host.textContent).toContain("Joined");
    expect(mocks.resolveIntervention).not.toHaveBeenCalled();
  });

  it("disables the join while no membership mutation exists", async () => {
    const host = await render(
      <ActionApprovalCard
        view={actionView(groupMembership())}
        target={target}
        botName="Scout"
        groupNameOf={() => "Design"}
      />,
    );

    expect((byTestId(host, "group-membership-approve") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Joining from this card is not available yet.");
  });

  it("renders a failed join as its own card with no actions", async () => {
    const host = await render(<GroupMembershipFailureCard botName="Scout" groupName="Design" />);

    expect(byTestId(host, "group-membership-failure")?.textContent).toContain(
      "Could not add Scout to “Design”",
    );
    expect(byTestId(host, "group-membership-failure")?.textContent).toContain(
      "No member permission",
    );
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("plan review and session control", () => {
  it("approves the exact plan version and requires feedback before requesting changes", async () => {
    const approveHost = await render(
      <PlanReviewInteractionCard view={planView()} target={target} />,
    );
    expect(approveHost.textContent).toContain("Review plan · v2");
    expect(approveHost.textContent).toContain("Draft the summary");
    expect(approveHost.textContent).toContain("does not approve any tool");
    // A13: plan approval never renders the tool-approval DOM or copy.
    expect(approveHost.querySelector('[data-testid="approval-primary"]')).toBeNull();
    expect(approveHost.textContent).not.toContain("Allow once");
    await act(async () =>
      (byTestId(approveHost, "plan-review-approve") as HTMLButtonElement).click(),
    );
    expect(mocks.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ interventionId: "i-plan", answer: "approve" }),
    );

    mocks.resolveIntervention.mockClear();
    const changesHost = await render(
      <PlanReviewInteractionCard view={planView()} target={target} />,
    );
    await act(async () =>
      (byTestId(changesHost, "plan-review-request-changes") as HTMLButtonElement).click(),
    );
    expect((byTestId(changesHost, "plan-review-send-feedback") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await typeInto(
      byTestId(changesHost, "plan-review-feedback") as HTMLTextAreaElement | null,
      "Split item two",
    );
    await act(async () =>
      (byTestId(changesHost, "plan-review-send-feedback") as HTMLButtonElement).click(),
    );
    expect(mocks.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ answer: "request_changes", feedback: "Split item two" }),
    );
  });

  it("opens the desktop for takeover and hands back only on the explicit action", async () => {
    const onOpenComputer = vi.fn();
    const takeoverHost = await render(
      <SessionControlCard view={sessionView("takeover")} onOpenComputer={onOpenComputer} />,
    );
    expect(takeoverHost.textContent).toContain("Needs you at the desktop");
    expect(takeoverHost.textContent).toContain("Closing the desktop does not abandon");
    await act(async () =>
      (byTestId(takeoverHost, "session-control-takeover") as HTMLButtonElement).click(),
    );
    expect(onOpenComputer).toHaveBeenCalledWith("bot-1");
    expect(mocks.releaseComputer).not.toHaveBeenCalled();

    const returnHost = await render(<SessionControlCard view={sessionView("return")} />);
    expect(returnHost.textContent).toContain("Closing this card does not hand control back");
    await act(async () =>
      (byTestId(returnHost, "session-control-return") as HTMLButtonElement).click(),
    );
    expect(mocks.releaseComputer).toHaveBeenCalledWith({ botId: "bot-1", reason: "done" });
  });
});

describe("interaction region", () => {
  it("orders pending cards plan → approval → input, then terminal, with session control separate", async () => {
    const host = await render(
      <InteractionRegion
        interactions={[
          inputView({ mode: "question", prompt: "Which city?", placeholder: null }),
          planView(),
          actionView(paymentApproval(), { interactionId: "i-approval" }),
          planView({
            interactionId: "i-plan-old",
            status: "answered",
            decision: "reject",
            createdAt: "2026-10-24T09:00:00.000Z",
          }),
          sessionView("takeover"),
        ]}
        target={target}
      />,
    );

    const region = byTestId(host, "intervention-region");
    expect(region?.getAttribute("data-surface")).toBe("interaction-v2");
    const kinds = [...region!.querySelectorAll<HTMLElement>('[data-testid="interaction-card"]')]
      .filter((card) => card.getAttribute("data-kind") !== "session_control")
      .map((card) => card.getAttribute("data-kind"));
    expect(kinds).toEqual(["plan_review", "action_approval", "input_request", "plan_review"]);
    const session = byTestId(host, "session-control-region");
    expect(session?.querySelector('[data-kind="session_control"]')).not.toBeNull();
    expect(region?.textContent).toContain("Confirm payment");
  });
});
