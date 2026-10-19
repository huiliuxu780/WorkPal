# Avatar v0.7 FINAL integration

Status: implementation and local verification complete; not deployed. Supplied v0.7 FINAL specs and assets supersede the old monochrome visual inputs. The historical compact hook set is retained under `compact-16px-hook/`.

## Delivered behavior

- Persisted `avatarBodyColor`: orange/blue/purple/brown/pink/ink. Existing Bots and history receive ink. Defaults choose the least-used color among the user's character Bots across Spaces, including archived Bots, under the existing user transaction lock. Tie-break uses the Bot ID hash. Explicit Studio choices and cloning preserve color.
- Studio character/color selection, cross-tab refresh, change history and one-step Undo preserve the complete identity. Direct Bot requests support an explicit color plus character (for example “change your avatar to blue wave”); original-human authorization remains in place.
- 96 colored character SVGs in four tiers, 63 props and 96 static poses copied byte-for-byte. Generated React nodes keep the SVG whitelist; geometry and palette are compiled from the supplied JSON. No parser, fetch or user SVG at runtime.
- Frames 16/18/24/32/35/58/64; 18px clusters stay still; frame ×1.25 centered drawing canvas with visible overflow. Sidebar suppresses props and uses a badge. Upload cropping remains separate.
- Failed 1240ms sequence: surprise, cross-eyes, −6/+4.5/−2.5/+1/0 shake, 40ms eye and 70ms symbol lag, deflate, stop. Geometry pivots come from anchors; bounce retains frozen +2.75° tilt. Shadows remain on the ground and appear only around airborne segments. Loop/one-shot limits and 58px sy cap are separate.
- Light/dark semantic status colors share tokens with badges; same-hue combinations receive thicker separation rings. Existing non-color compact cues remain. Global three-instance director, reduced motion, visibility and cleanup remain active; badge breathing follows allocated moving instances.

## Verification

- Contracts/DB/adapters/API/Web/ui-web type checks passed; production Web build passed.
- UI/avatar/parser/contracts plus shared token run: 9 files, 85 tests passed. Motion tests assert failed keyframes, lag, stopped final frame, static shadow absence and director allocation. Asset test compares all 255 source/runtime SVG bytes.
- PostgreSQL: assignment + history/Undo + migration suites, 13 tests passed. First six colors distinct across Spaces including archived Bots; existing image preserved; color history/Undo exact. Full migration set applied to a fresh E2E DB. Populated pre-v0.7 columns reconstructed and migration applied twice; existing rows become ink and later pink survives replay.
- Initial Avatar E2E: 5 tests passed in one 41.8s run, covering Studio color persistence and cross-tab Undo, invalid upload/crop, Bot-requested avatar change, 18px group cluster, reduced motion. Disposable test DB only.
- Frozen-frame review: [light matrix](./review/v0.7/matrix-light.png), [dark matrix](./review/v0.7/matrix-dark.png), [reference light](./review/v0.7/reference-light.png). Matrices cover 4 characters ×5 states ×64/24px at t=1500. Reproduce via `/e2e/fixtures/avatar-v07-matrix.html?t=1500` and `&dark=1`; compare the vendored source demo with the same query. Demo easing is illustrative; normative failure curves are sampled as specified.

## Limits and decisions

- New semantic contrast tests use the frozen white/#1a1a1a reference canvases. The previous tests required every tinted product surface; that is a different claim from the v0.7 spec. Background-colored separation rings are retained on actual surfaces; no claim that each new fill alone reaches 3:1 on every tinted surface.
- Supplied 16px SVGs are used unchanged; the former hook revision is historical. Names and accessible labels remain available.
- Source static poses are retained and validated; director static poses use the same live layers so identity/state transitions keep their existing cleanup behavior.
- No working illustration was added. No deployment or production database access occurred.

## Integration follow-up

- CI's 651-path selector output exceeded Linux's per-environment-value limit, preventing the docs shell from starting. The full selection now travels as an Actions artifact; the aggregator receives only its bounded mode/selected/flags JSON. A 3000-long-path regression and artifact reader are tested (49 CI tests passed).
- CI also exercised the old login-card persistence expectation. On unchanged `08e9d45`, the exact same test fails at line 92: UX-01 intentionally returns a settled plain Run receipt to its message bubble, outside the attention region. The plain login fixture stays unchanged. Its post-reload assertions now locate the one Saved, input-free receipt in the message bubble and require no attention region, matching UX-01; error/retry, required fields, single-card and every no-echo assertion remain. Product behavior is unchanged.
- Repeated failed entry holds cross-eyes throughout the replay; first entry retains its surprise eyes. Compact 16/18px views keep their regular static pupils. Dark outline uses the specified 1.5px.
- Additional local scope: all Web source tests plus API Bot-update/executor suites, 87 files / 756 tests passed before the final repeated-entry regression. Shared token-generation checks also passed. [Reference dark](./review/v0.7/reference-dark.png) accompanies the two matrix snapshots.

Final local closure: six Avatar E2E plus login-card passed together (7/7, 41.3s). Compact working points and uploaded-avatar badges now allocate their breathing through the same page-wide three-slot director; their SVG/image stays still. The additional browser case verifies compact-body stability and reduced-motion stopping of the point.

Review closure: 18px avatars resample their static state on activity changes and retain the failed X expression. The XS overlay reuses the frozen S X paths with the supplied XS fit and dark palette; no path is redrawn and the 255 copied SVG bytes remain unchanged. A mounted failed→working regression verifies pupils/overlay and XS blue. Standalone body-color patches are explicitly rejected by the input contract; Studio sends a complete character/color choice. Settings history and Bot change cards display both before/after colors; the Studio browser test verifies that visible record and Undo.
