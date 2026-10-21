// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return {
    Trans: ({ children }: { children?: ReactNode }) => children,
    useLingui: () => ({ t, i18n: { locale: "en" } }),
  };
});
vi.mock("../../lib/rpc", () => ({
  rpc: {
    bots: { avatarChanges: vi.fn().mockResolvedValue([]) },
    voice: { voices: vi.fn().mockResolvedValue([]) },
    me: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => <div>scratchpad</div> }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => <div>knowledge</div> }));
vi.mock("../../components/ModelTreePicker", () => ({
  ModelTreePicker: (props: { id?: string }) => <select id={props.id} aria-label="Model" />,
}));
vi.mock("../../lib/model-options", () => ({
  modelOptionKey: (provider: string, modelId: string) => `${provider}/${modelId}`,
  parseModelOptionKey: (key: string) => {
    const [provider, modelId] = key.split("/");
    return { provider, modelId };
  },
  useConnectedModelOptions: () => ({ credentials: [], catalog: [], ready: true }),
}));
vi.mock("./avatar-studio-popover", () => ({
  AvatarStudioPopover: () => <div>avatar</div>,
}));

import { BotSettings } from "./bot-panel";

i18n.load("en", {});
i18n.activate("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = {
  id: "bot-1",
  name: "Chief",
  title: "Boss",
  description: "",
  instructions: "",
  color: "#0a0a0c",
  avatarMode: "character",
  avatarCharacter: "dot",
  avatarBodyColor: "ink",
  notifyOnFinish: true,
  computerMode: "team",
  memoryScope: null,
  autoSpeak: false,
  voiceId: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
} as unknown as Bot;

let root: Root;
let container: HTMLDivElement;

function renderSettings(
  tab: "detail" | "library" | "computer",
  onTab: (tab: "detail" | "library" | "computer") => void = () => {},
) {
  act(() => {
    root.render(
      <BotSettings
        bot={bot}
        memoryProviderConfigured={false}
        onSkillsChange={() => {}}
        onSave={async () => {}}
        onExport={async () => {}}
        onClear={() => {}}
        onAvatarChanged={async () => {}}
        settingsTab={tab}
        onSettingsTabChange={onTab}
        computerScreen={<div>computer-screen</div>}
        routines={<div>routines</div>}
      />,
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BotSettings three-tab layout", () => {
  it("renders Details with routines, identity fields and model", () => {
    renderSettings("detail");
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(3);
    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.id).toContain("panel-detail");
    expect(panel?.getAttribute("aria-labelledby")).toContain("tab-detail");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    const text = container.textContent ?? "";
    expect(text).toContain("routines");
    expect(container.querySelector('select[aria-label="Model"]')).toBeTruthy();
    // Computer mode belongs to the Computer tab, not Details.
    expect(text).not.toContain("Team");
  });

  it("renders Library and Computer panes with their content", async () => {
    renderSettings("library");
    await flush();
    expect(container.textContent).toContain("scratchpad");
    renderSettings("computer");
    const text = container.textContent ?? "";
    expect(text).toContain("computer-screen");
    expect(text).toContain("Team");
    expect(text).toContain("Private");
  });

  it("moves focus with arrow keys across the tablist", () => {
    const onTab = vi.fn();
    renderSettings("detail", onTab);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    act(() => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(onTab).toHaveBeenCalledWith("library");
    // ArrowLeft wraps backwards from the same (controlled) selection.
    act(() => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
    });
    expect(onTab).toHaveBeenLastCalledWith("computer");
  });

  it("jumps to the first and last tab with Home and End", () => {
    const onTab = vi.fn();
    renderSettings("library", onTab);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    act(() => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
      );
    });
    expect(onTab).toHaveBeenCalledWith("computer");
    act(() => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
      );
    });
    expect(onTab).toHaveBeenLastCalledWith("detail");
  });
});
