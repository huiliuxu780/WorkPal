# bloub — vendored avatar engine

Vendored from [bloub](https://github.com/jeremy-prt/bloub) (`src/bot/`, commit `main` as of
2026-10-07), MIT License, Copyright (c) 2026 Jérémy Perret — see [LICENSE](./LICENSE).

bloub recreates the x.ai bot avatar as an animated SVG: one black shape morphing
through measured states, no animation library.

## What is vendored

`math.ts`, `profiles.ts`, `shape.ts`, `face.ts`, `decor.ts`, `states.ts`, `repere.ts`,
`skins.ts`, `expressions.ts`, `eyefit.ts`, `engine.ts`, `cycles.ts` — the full pure-TS
bot model: geometry, the 8 customizer shapes, the 16 expressions, eye-fitting
corrections, the frame engine (`BotEngine.sample(now)` is a pure time function), and
the measured 14-state cycle (`defaultCycle()`). These files are kept byte-identical
with upstream (plus a one-line attribution header) so they can be re-vendored cleanly.

## What is NOT vendored and why

- The Vue components, i18n, and UI (the site's customizer app around the engine).
- Pointer-following (`setLook`): avatars in a chat UI have no cursor target; the
  engine's idle liveliness (breath, blinks, gaze drift) still runs.

## Local adaptations

- `static.ts` (ours): one static `BloubStaticFrame` per (shape, expression) for
  first paint, reduced motion, and the 24 studio thumbnails — same composition as
  `BotEngine` at rest, cached and shared.
- `ticker.ts` (ours): a single shared rAF loop for every live avatar; a throwing
  frame is logged and skipped, never allowed to kill the loop.
- `../bloub-avatar.tsx` (ours): React renderer mirroring `BloubBot.vue` — mask with
  the body in white and the eyes/notch in black (real holes, like x.ai's original),
  a `var(--background)` paper underlay, ink rect through the mask, plus dots, orbit
  arcs (with their gradients), and the notification bubble driven imperatively per
  frame. `animated={false}` opts out (studio grids).

## Re-vendoring

```sh
for f in math profiles shape face decor states repere; do
  curl -s "https://raw.githubusercontent.com/jeremy-prt/bloub/main/src/bot/$f.ts" ...
done
```
Then re-run `pnpm --filter @rakazo/ui-web test -- bloub`.
