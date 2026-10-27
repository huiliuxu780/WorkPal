<!--
One delivery unit per PR. Rules: AGENTS.md and docs/development-workflow.md.
Review judges the FINAL head SHA: a green run on an older commit does not
substitute, and a required check that never ran is not a pass.
-->

## Delivery unit

- Task card / issue:
- Branch and PR scope (what behavior this unit changes and how to roll it back):
- Depends on (merged `main` capability, or "none"):

## What changed and why

<!-- Behavior first. Link the code, do not paste it. -->

## Verification actually run

<!-- Command, environment, head SHA, result, exit code. List what you ran, not
     what could be run. Required checks that did not run belong in "Not run". -->

| Command | Head SHA | Environment | Result |
| --- | --- | --- | --- |
|  |  |  |  |

- Final head SHA of this delivery:
- CI run for that exact SHA (URL), with the jobs that actually executed:

## Real runtime evidence

<!-- Indexed paths only. API: sanitized request/response. Execution chain:
     Run/Attempt, Worker and Java facts, database rows. UI: the operations you
     performed plus screenshots at the required viewports and themes. Say which
     runs used the real SDK, a deterministic model fixture, or `scripted`. -->

- Evidence directory:
- Scenario → evidence mapping:

## Bug fixes: red before green

<!-- Same regression case both times. Record the baseline SHA where it failed
     for the target defect and the fix SHA where it passes. No skips, no
     `it.fails`, no weakened assertions, no added test retries, and an
     environment error is not a red. -->

- Regression case:
- `red.log` (baseline SHA, command, exit code):
- `green.log` (fix SHA, command, exit code):
- Not a bug fix — delete this section.

## Not run and known gaps

<!-- Every applicable check you did not run, and why. Missing CI, evidence, or
     red/green means this PR goes back to the same branch, not to a separate
     "finish the acceptance" task. -->

## Risk

- Blast radius (auth, startup config, TS/Java protocol, tool bridge, session admission, recovery):
- Concurrency, idempotency, and timeout behavior touched:
- Feature gates added or changed, with their default and removal condition:
- Rollback:

## Documentation writeback

- Task card / roadmap status updated (`ready-to-merge` only after acceptance, `done` only after merge):
- Docs, commands, and evidence indexes that had to change with this PR:

## UI

<!-- Pick exactly one. A page change without a confirmed prototype must not be
     dispatched or implemented; finish the prototype first. -->

- [ ] No UI change.
- [ ] UI change inside an already confirmed prototype:
  - Prototype file and scene:
  - Visual constraints respected (tokens, density, existing components):
  - Viewports and themes captured (1280 / 390, light / dark, plus any narrow-screen regression):
  - What is explicitly unchanged:
