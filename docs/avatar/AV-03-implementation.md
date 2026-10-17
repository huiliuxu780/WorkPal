# AV-03: SVG motion engine

AV-03 adds motion to the AV-02 `AgentAvatar` component without changing any frozen SVG path. The four 16px compact avatars remain static under the AV-00 size contract. Full avatars at 24/32/64px use one page-wide `requestAnimationFrame` clock with at most three moving instances.

## Behavior

- `motion.ts` samples deterministic 100×100 viewBox poses for five states and four characters. `geometry.ts` applies one proportional pupil clamp from the frozen eye bounds, preserving a 1px margin at 64px. Feet are never transformed.
- `director.ts` allocates three animation slots in approval → waiting → working → failed → idle order. The current conversation breaks ties within a state. Failed animation releases its slot after 1300ms. Hidden tabs and reduced-motion display static poses and stop the clock. Approval reminders start at 3s, repeat no sooner than 30s, cap at three, and stagger by at least 2s across instances. Working progress pulses are dropped inside a 2s throttle and reset the 30s slower cadence.
- `dom-motion.ts` applies transforms to existing SVG groups and scales the copied prop assets. It does not edit paths, colors or feet. A mounted component reuses its SVG across state changes; no runtime HTML parser or asset fetch is introduced.
- The frozen demo and `compare.gif` were inspected beside the deterministic 4×5 frame sheet [av03-motion-matrix.png](./review/av03-motion-matrix.png). The renderer follows the later v0.6 timing, laptop and pupil-clamp rules where the demo differs.

## Verification

- Focused Vitest: 21/21. Tests sample the five timelines across four characters, assert numeric bounds, check the three-slot clock and fake-time reminders/pulse/visibility, and verify SVG group transforms leave path data and feet untouched.
- `pnpm --filter @rakazo/ui-web check` and targeted Biome check: green.
- Chromium rendered the frame sheet from actual `AgentAvatar` server markup and `sample()`/`createAvatarDomRenderer()`, not from redrawn assets.

AV-04 will wire the component to live Bot surfaces and the durable avatar-state read model. AV-05 will handle editing, uploads, and explicit Bot avatar changes.
