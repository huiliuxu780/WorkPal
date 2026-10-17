# Compact avatar v0.7 — 16px design acceptance

Accepted on 2026-10-17 by Codex, acting on the user's explicit delegation to revise the 16px design using oil-ui-pro. This freezes only the four compact SVGs in [compact-v0.7/](../source/compact-v0.7/). The original `source/final/` SVGs and MOTION-SPEC v0.6 remain unchanged.

## Design change

- `2-treble-16.svg` adds one black, upper-left body-silhouette hook (`compact-silhouette`). It joins the existing body shape and stays inside the transparent viewBox. The hook echoes the left-side motion of the full treble symbol without drawing that symbol at 16px.
- `1-dot-16.svg`, `3-wave-16.svg`, and `4-bounce-16.svg` are exact copies of the supplied compact files. Dot keeps a smooth crown; wave retains its centered peak; bounce retains its tilted body and asymmetric feet. No color, background plate, prop, or animation is embedded in any compact SVG.
- The 6px state point and its 1.5px background-colored separation ring belong to the future AV-02 component, not to these SVGs. The v0.7 hook is upper-left and stays visible when that point is placed lower-right.

| File | SHA-256 | Change from supplied compact SVG |
| --- | --- | --- |
| `1-dot-16.svg` | `41e198bc824c00df2033a2c129d9ff058926186b18c7402aea4c5519e8c4976b` | none |
| `2-treble-16.svg` | `2553c40c3a895c21a9272a6bde7193ab4b2f8f4820c74eb28a49d9594ec1fdfc` | one body-silhouette hook |
| `3-wave-16.svg` | `0eb59cf3fdc650a8d2fa0e9d59b05468573b0febc60bd2b2980114eae8885eb4` | none |
| `4-bounce-16.svg` | `8c736c2a1ef90c232cb393d2bea3c5fecbdbb85b33dd42f73b39458288147a2e` | none |

## Render review

The [review sheet](./compact-v0.7.png) was captured in headless Chrome at device scale 1 from [the reproducible HTML](./compact-v0.7.html). Every SVG is displayed at exactly 16 CSS px on white, warm light, and two dark comparison surfaces. Rows show idle plus working, approval, waiting, and failed points. The [2× crop](./compact-v0.7-2x.png) and [pixel-detail crop](./compact-v0.7-detail.png) enlarge pixels from that actual 16px render; they do not re-render larger vectors.

Visual inspection of the unlabeled silhouettes found four distinct cues on both light and dark: round dot, left hook treble, central crest wave, and leaning/unequal-foot bounce. Dot and treble were previously byte-identical. In this fixed Chrome render, a 24×24 crop around those two avatars has 9 visibly different pixels on light and 17 on dark (RGB channel delta ≥40), both idle and with lower-right status points. This pixel count confirms the render differs; it is not a substitute for human recognition testing. The state point does not erase the left hook.

## Implementation boundary

AV-02 uses these four v0.7 files for 16px. The original full SVGs remain the approved files for 24/32/64px. The light-theme point colors follow the [AV-00 contrast decision](../AV-00-decision.md); dark-theme colors follow MOTION-SPEC v0.6. This review does not certify the final mounted component, other backgrounds, model behavior, or recognition by every user. The 16px static state code still relies mainly on point color; accessible state text and names remain required, and AV-02 must recheck contrast and point placement in its real surfaces. *(The "relies mainly on point color" sentence is superseded by the addendum below.)*

## Addendum (2026-10-18): non-color state cues at 16px

Codex review on PR #50 found that on 16px surfaces without adjacent state text (example cited: the `Artifacts.tsx` bot chips), the working, approval and waiting points are the same 6px circle differing only by hue — inaccessible to a sighted color-blind user and contradicting the acceptance condition that color must not be the only signal. This addendum closes that finding; the frozen compact SVG bytes and all frozen point colors are untouched.

The 6px state point gains a per-state **shape** alongside its color:

| State | Shape | Silhouette |
| --- | --- | --- |
| working | filled circle | round, solid |
| approval | filled diamond (square rotated 45°) | angular, solid |
| waiting | hollow ring (state-colored border, transparent center) | round, hollow |
| failed | circle with the existing “!” glyph | round, solid + glyph |

The four shapes are distinguishable without hue (round/angular × filled/hollow, plus the failed glyph). Constraints kept unchanged: every point color token (dark set and light-theme contrast set), and the 1.5px background-colored separation — the waiting ring moves that separation to an equivalent 1.5px outer halo so the gap is preserved.

Implementation contract: the component marks the dot with `data-point-shape="circle|diamond|ring|alert"`, and the shape CSS keys only off that attribute, so the mapping is pinned by DOM-level unit tests (jsdom cannot evaluate the stylesheet). Both 16px point surfaces — the compact character avatar (AV-02) and the uploaded-image badge (AV-04) — carry the attribute. Accessible state text and names remain required where the design provides them; this note still does not certify recognition by every user.
