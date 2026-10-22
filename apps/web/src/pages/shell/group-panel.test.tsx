// @vitest-environment jsdom
/**
 * RT-22 AC33-AC36 regression net for the group right panel:
 * - AC33 group name edits commit on blur/Enter and are dropped on Escape.
 * - AC34 the Work tab carries no count.
 * - AC35 member rows and the ＋ add entries stay borderless and the member head
 *   counts Agents only (never the current user).
 * - AC36 the library groups by day without an outer frame and keeps every file
 *   row a real button.
 */
import type { GroupMembers, GroupRoutineSummary } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupPanel, type GroupPanelTab } from "./group-panel";
import type { GroupArtifactItem } from "./use-group-panel";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

const MEMBERS: GroupMembers = {
  groupId: "group-1",
  threadId: "thread-1",
  currentUser: {
    kind: "user",
    userId: "user-1",
    name: "Rivers",
    image: null,
    avatarStyle: "bloub",
  },
  agents: [
    {
      kind: "agent",
      botId: "bot-1",
      name: "Joy",
      color: "#111111",
      avatarMode: "character",
      avatarCharacter: "dot",
      avatarBodyColor: "ink",
      status: "idle",
    },
    {
      kind: "agent",
      botId: "bot-2",
      name: "Blue",
      color: "#222222",
      avatarMode: "character",
      avatarCharacter: "wave",
      avatarBodyColor: "blue",
      status: "running",
    },
  ],
  agentCount: 2,
  memberCount: 3,
};

const ROUTINES: readonly GroupRoutineSummary[] = [
  {
    id: "routine-1",
    botId: "bot-1",
    threadId: "thread-1",
    name: "Release digest",
    prompt: "summarize",
    crons: ["0 18 * * 1-5"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    executorBot: MEMBERS.agents[0]!,
  },
];

function artifact(id: string, createdAt: string): GroupArtifactItem {
  return {
    id,
    botId: "bot-1",
    groupId: "group-1",
    runId: null,
    name: `${id}.md`,
    description: null,
    mimeType: "text/markdown",
    size: 10,
    version: 1,
    versionCount: 1,
    createdAt,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(overrides: Partial<Parameters<typeof GroupPanel>[0]> = {}) {
  const onSave = vi.fn(async () => undefined);
  act(() => {
    root.render(
      <GroupPanel
        members={MEMBERS}
        membersError={null}
        groupName="Release roundtable"
        tab="details"
        onTabChange={() => undefined}
        onClose={() => undefined}
        onRename={onSave}
        onManageMembers={() => undefined}
        routines={ROUTINES}
        routinesError={null}
        artifacts={[artifact("a1", new Date().toISOString())]}
        artifactsError={null}
        artifactsLoading={false}
        nextCursor={null}
        onLoadMoreArtifacts={async () => undefined}
        onOpenArtifact={() => undefined}
        onRetry={() => undefined}
        {...overrides}
      />,
    );
  });
  return onSave;
}

function nameField(): HTMLInputElement {
  const field = container.querySelector<HTMLInputElement>("[data-testid='group-name-field']");
  if (!field) throw new Error("name field missing");
  return field;
}

function typeInto(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter missing");
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(field: HTMLInputElement, key: string) {
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function blur(field: HTMLInputElement) {
  act(() => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("group name inline edit (AC33)", () => {
  it("is read-only until clicked, then saves on Enter", () => {
    const onSave = render();
    const field = nameField();
    expect(field.readOnly).toBe(true);
    act(() => {
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(field.readOnly).toBe(false);
    typeInto(field, "  Friday release  ");
    press(field, "Enter");
    expect(onSave).toHaveBeenCalledWith("Friday release");
  });

  it("saves on blur", () => {
    const onSave = render();
    const field = nameField();
    act(() => {
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    typeInto(field, "Renamed");
    blur(field);
    expect(onSave).toHaveBeenCalledWith("Renamed");
  });

  it("drops the draft on Escape without saving", () => {
    const onSave = render();
    const field = nameField();
    act(() => {
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    typeInto(field, "Wrong");
    press(field, "Escape");
    expect(onSave).not.toHaveBeenCalled();
    expect(field.value).toBe("Release roundtable");
    expect(field.readOnly).toBe(true);
  });

  it("does not save an unchanged or empty name", () => {
    const onSave = render();
    const field = nameField();
    act(() => {
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    typeInto(field, "   ");
    blur(field);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("panel tabs (AC34)", () => {
  it("shows no count on any tab", () => {
    render();
    const tabs = container.querySelectorAll("[role='tab']");
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) {
      expect(tab.textContent).not.toMatch(/\d/);
    }
  });

  it("renders the work view as an honest unconnected state", () => {
    render({ tab: "work" as GroupPanelTab });
    const note = container.querySelector("[data-testid='group-work-unavailable']");
    expect(note?.textContent?.length).toBeGreaterThan(0);
    expect(
      container.querySelectorAll(
        "[role='tabpanel']:not([hidden]) [data-testid='group-routine-row']",
      ),
    ).toHaveLength(0);
  });
});

describe("members page (AC35)", () => {
  it("counts Agents only and keeps rows and add entry borderless", () => {
    render({ tab: "members" as GroupPanelTab });
    const head = container.querySelector("[role='tabpanel']:not([hidden]) .mx-0\\.5");
    expect(head?.textContent).toContain("2 Agents");
    expect(head?.textContent).not.toContain("3");
    const rows = container.querySelectorAll("[data-testid='group-member-row']");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain("border-0");
    }
    const add = container.querySelector("[data-testid='group-add-agent']");
    expect(add?.className).toContain("border-0");
    expect(add?.textContent).toContain("＋");
  });
});

describe("library page (AC36)", () => {
  it("groups by day without an outer frame and keeps rows focusable", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    render({
      tab: "library" as GroupPanelTab,
      artifacts: [artifact("a1", new Date().toISOString()), artifact("a2", yesterday.toISOString())],
    });
    const rows = container.querySelectorAll("[data-testid='group-library-row']");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
    }
    const sections = container.querySelectorAll("[role='tabpanel']:not([hidden]) > section");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.textContent).toMatch(/^Today/);
    expect(sections[1]?.textContent).toMatch(/^Yesterday/);
    for (const section of sections) {
      expect(section.className).not.toContain("border");
    }
  });
});
