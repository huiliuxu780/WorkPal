import "@rakazo/ui-tokens/css";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentAvatar } from "../../../../packages/ui-web/src/agent-avatar/agent-avatar";
import { createAvatarDomRenderer } from "../../../../packages/ui-web/src/agent-avatar/dom-motion";
import { sample } from "../../../../packages/ui-web/src/agent-avatar/motion";

const p = new URLSearchParams(location.search),
  dark = p.has("dark"),
  t = Number(p.get("t") ?? 1500);
document.documentElement.dataset.theme = dark ? "dark" : "light";
document.head.insertAdjacentHTML(
  "beforeend",
  `<style>body{margin:0;padding:32px;background:${dark ? "#1a1a1a" : "white"};color:${dark ? "white" : "#222"};font:14px system-ui}section{display:grid;grid-template-columns:repeat(5,140px);gap:24px;margin-bottom:32px}.cell{height:132px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px}h1{font-size:20px}</style>`,
);
const chars = ["dot", "treble", "wave", "bounce"] as const,
  states = ["idle", "working", "approval", "waiting", "failed"] as const;
const colors = ["orange", "blue", "purple", "brown", "pink", "ink"] as const;
document.querySelector("#app")!.innerHTML = [64, 24]
  .map(
    (size) =>
      `<h1>v0.7 · ${size}px · ${dark ? "dark" : "light"} · t=${t}</h1><section>` +
      chars
        .map((character, i) =>
          states
            .map(
              (activity) =>
                `<div class="cell">${renderToStaticMarkup(<AgentAvatar botId={`${character}-${activity}`} character={character} bodyColor={colors[i]} name={character} size={size as 64 | 24} activity={activity} />)}<span>${character} / ${activity}</span></div>`,
            )
            .join(""),
        )
        .join("") +
      "</section>",
  )
  .join("");
for (const root of document.querySelectorAll<HTMLElement>(".rakazo-agent-avatar")) {
  const state = root.dataset.state as (typeof states)[number],
    character = root.dataset.character as (typeof chars)[number];
  createAvatarDomRenderer(root)({
    frame: sample(state, t, 0.37, {
      character,
      size: Number(root.dataset.size),
      static: p.has("rm"),
    }),
    state,
    outgoingState: null,
    outgoingScale: 0,
    moving: false,
  });
}
(window as any).avatarReady = true;
