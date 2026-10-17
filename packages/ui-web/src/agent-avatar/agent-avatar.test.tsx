import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TO_AVATAR,
  type AvatarActivity,
  avatarActivityForItem,
  selectAvatarActivity,
} from "./activity-map.js";
import { AgentAvatar, AVATAR_POINT_SHAPES } from "./agent-avatar.js";

describe("avatar activity mapping", () => {
  it("covers all 13 product ActivityKinds", () => {
    expect(Object.keys(ACTIVITY_TO_AVATAR)).toHaveLength(13);
    expect(Object.entries(ACTIVITY_TO_AVATAR)).toEqual([
      ["working", "working"],
      ["planning", "working"],
      ["approval", "approval"],
      ["tool", "working"],
      ["research", "working"],
      ["delegation", "working"],
      ["handoff", "working"],
      ["background", "working"],
      ["waiting_input", "waiting"],
      ["waiting_takeover", "waiting"],
      ["completed", "idle"],
      ["failed", "failed"],
      ["cancelled", "idle"],
    ]);
  });

  it("does not keep terminal background work active and respects failure acknowledgement", () => {
    expect(avatarActivityForItem("background", "completed")).toBe("idle");
    expect(avatarActivityForItem("tool", "cancelled")).toBe("idle");
    expect(avatarActivityForItem("failed", "failed", true)).toBe("idle");
    expect(avatarActivityForItem("failed", "failed", false)).toBe("failed");
  });

  it("ranks state before recency, then transition time and stable Run ID", () => {
    expect(
      selectAvatarActivity([
        { runId: "work", kind: "working", status: "running", updatedAt: "2026-10-17T00:10:00Z" },
        {
          runId: "approval",
          kind: "approval",
          status: "pending",
          updatedAt: "2026-10-17T00:00:00Z",
        },
        { runId: "failure-z", kind: "failed", status: "failed", updatedAt: "2026-10-17T00:01:00Z" },
        { runId: "failure-a", kind: "failed", status: "failed", updatedAt: "2026-10-17T00:01:00Z" },
      ]),
    ).toEqual({ state: "failed", runId: "failure-a", updatedAt: "2026-10-17T00:01:00Z" });
    expect(selectAvatarActivity([])).toEqual({ state: "idle", runId: null, updatedAt: null });
  });
});

describe("AgentAvatar static rendering", () => {
  const render = (size: 16 | 24 | 32 | 64, activity: AvatarActivity) =>
    renderToStaticMarkup(
      <AgentAvatar botId="bot" character="treble" name="Maya" size={size} activity={activity} />,
    );

  it.each([16, 24, 32, 64] as const)("renders the %ipx slot with a name and state", (size) => {
    const html = render(size, "approval");
    expect(html).toContain(`data-size="${size}"`);
    expect(html).toContain('aria-label="Maya · Needs approval"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-character="treble"');
    expect(html).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    if (size === 16) {
      expect(html).not.toContain('id="symbol"');
      expect(html).toContain("rakazo-agent-avatar-dot");
      expect(html).not.toContain("rakazo-agent-avatar-prop");
    } else {
      expect(html).toContain('id="symbol"');
      expect(html).not.toContain("rakazo-agent-avatar-dot");
      expect(html).toContain('id="card"');
    }
  });

  it("renders each full-size static prop and hides redundant speech", () => {
    expect(render(24, "working")).toContain('id="laptop"');
    expect(render(24, "waiting")).toContain('id="question"');
    expect(render(24, "failed")).toContain('id="xeyes"');
    expect(render(24, "idle")).toContain('data-avatar-prop="laptop" aria-hidden="true" style="opacity:0"');
    expect(render(16, "idle")).not.toContain("rakazo-agent-avatar-dot");
    const hidden = renderToStaticMarkup(
      <AgentAvatar
        botId="bot"
        character="dot"
        name="Maya"
        size={24}
        activity="working"
        ariaHidden
      />,
    );
    expect(hidden).toContain('aria-hidden="true"');
    expect(hidden).not.toContain("aria-label=");
    expect(hidden).not.toContain("tabindex=");
  });

  it("falls back from a missing character without exposing raw input as markup", () => {
    const html = renderToStaticMarkup(
      <AgentAvatar
        botId="bot"
        character={"<script>" as never}
        name="Maya"
        size={16}
        activity="idle"
      />,
    );
    expect(html).toContain('data-character="dot"');
    expect(html).not.toContain("<script>");
  });
});

import { readFileSync } from "node:fs";

describe("compact point contrast", () => {
  const tokenCss = readFileSync(
    new URL("../../../ui-tokens/src/tokens.css", import.meta.url),
    "utf8",
  );
  const avatarCss = readFileSync(new URL("./agent-avatar.css", import.meta.url), "utf8");
  const luminance = (hex: string) => {
    const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => parseInt(value, 16) / 255);
    if (channels?.length !== 3) throw new Error(`Invalid color ${hex}`);
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const ratio = (left: string, right: string) => {
    const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (values[0]! + 0.05) / (values[1]! + 0.05);
  };

  it.each(["light", "dark"] as const)("meets 3:1 against each real %s surface", (theme) => {
    const tokenBlock =
      theme === "light"
        ? tokenCss.split('[data-theme="light"] {')[1]!
        : tokenCss.split('[data-theme="dark"] {')[1]!.split('[data-theme="light"] {')[0]!;
    for (const surface of ["background", "card", "sidebar", "secondary", "chat-user"]) {
      const background = tokenBlock.match(new RegExp(`--${surface}: (#[0-9a-f]{6});`, "i"))?.[1];
      expect(background).toBeTruthy();
      for (const state of ["working", "approval", "waiting", "failed"]) {
        const selector =
          theme === "light"
            ? `[data-theme="light"] .rakazo-agent-avatar[data-state="${state}"] .rakazo-agent-avatar-dot`
            : `.rakazo-agent-avatar[data-state="${state}"] .rakazo-agent-avatar-dot`;
        const color = avatarCss
          .slice(avatarCss.indexOf(selector) + selector.length)
          .match(/^\s*\{\s*background:\s*(#[0-9a-f]{6});\s*\}/i)?.[1];
        expect(color).toBeTruthy();
        expect(ratio(color!, background!)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(avatarCss).toContain("border: 1.5px solid var(--avatar-surface)");
  });
});

describe("compact point shape coding", () => {
  const avatarCss = readFileSync(new URL("./agent-avatar.css", import.meta.url), "utf8");
  const render = (activity: AvatarActivity) =>
    renderToStaticMarkup(
      <AgentAvatar botId="bot" character="treble" name="Maya" size={16} activity={activity} />,
    );

  it.each([
    ["working", "circle"],
    ["approval", "diamond"],
    ["waiting", "ring"],
    ["failed", "alert"],
  ] as const)("marks the 16px %s point as %s", (state, shape) => {
    expect(render(state)).toContain(`data-point-shape="${shape}"`);
  });

  it("keeps the four shapes distinct and styles them only via data-point-shape", () => {
    expect(new Set(Object.values(AVATAR_POINT_SHAPES)).size).toBe(4);
    // Diamond: the frozen approval point rotated to an angular silhouette.
    expect(avatarCss).toMatch(
      /\.rakazo-agent-avatar-dot\[data-point-shape="diamond"\]\s*\{[^}]*transform: rotate\(45deg\);[^}]*\}/,
    );
    // Ring: transparent center, frozen waiting hue as the ring, separation kept
    // as an equivalent outer halo (AV-00 acceptance addendum, 2026-10-18).
    expect(avatarCss).toMatch(
      /\.rakazo-agent-avatar\[data-state="waiting"\][^{]*\.rakazo-agent-avatar-dot\[data-point-shape="ring"\]\s*\{[^}]*background: transparent;[^}]*border-color: #7cb8f2;[^}]*box-shadow: 0 0 0 1\.5px var\(--avatar-surface\);[^}]*\}/,
    );
    expect(avatarCss).toMatch(
      /\[data-theme="light"\][^{]*\.rakazo-agent-avatar\[data-state="waiting"\][^{]*\.rakazo-agent-avatar-dot\[data-point-shape="ring"\]\s*\{[^}]*border-color: #2563eb;[^}]*\}/,
    );
  });
});

it("keeps all runtime SVG bytes identical to the frozen design sources", () => {
  const names = ["dot", "treble", "wave", "bounce"] as const;
  const full = ["1-dot.svg", "2-treble.svg", "3-wave.svg", "4-bounce.svg"];
  const compact = ["1-dot-16.svg", "2-treble-16.svg", "3-wave-16.svg", "4-bounce-16.svg"];
  names.forEach((name, index) => {
    const original = readFileSync(
      new URL(`../../../../docs/avatar/source/final/${full[index]}`, import.meta.url),
    );
    const copied = readFileSync(new URL(`./assets/${name}.svg`, import.meta.url));
    expect(copied.equals(original)).toBe(true);
    const revised = readFileSync(
      new URL(`../../../../docs/avatar/source/compact-v0.7/${compact[index]}`, import.meta.url),
    );
    const copiedCompact = readFileSync(new URL(`./assets/${name}-16.svg`, import.meta.url));
    expect(copiedCompact.equals(revised)).toBe(true);
  });
  for (const prop of [
    "card",
    "laptop",
    "question",
    "question-dark",
    ...names.map((name, index) => `xeyes-${index + 1}-${name}`),
  ]) {
    const original = readFileSync(
      new URL(`../../../../docs/avatar/source/final/assets/props/${prop}.svg`, import.meta.url),
    );
    const copied = readFileSync(new URL(`./assets/props/${prop}.svg`, import.meta.url));
    expect(copied.equals(original)).toBe(true);
    expect(copied.toString()).not.toContain("<text");
  }
});
