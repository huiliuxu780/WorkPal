# AG-04 pre-move final-request baseline

Golden captures of the REAL final model requests (TS adapter → Java runtime jar →
local OpenAI-compatible fixture) taken **before any prompt text was moved**, per
the AG-04 task card (§基线与真实组装顺序 #1). One JSON file per shape; the suite
`packages/testkit/src/prompt-files-baseline.integration.test.ts` rebuilds every
request from the production composers and compares byte-for-byte.

- Coverage: all 12 production RunTrigger shapes (`reaction`/`resume` are
  declared-only and create no request — see the AG-03 registry), the four
  auxiliary scopes, all three collaboration roles plus both outcome-resumption
  variants, approval-continuation resume, a two-request tool-execution round,
  and the memory/compaction/recall typed injections.
- Fixed inputs: test identities, a fixed clock (`2026-10-19T00:00:00Z` in the
  composed current-time line) and scripted model responses.
- Masking (enumerated unstable metadata ONLY, documented in the suite header):
  the current-time timestamp; AgentScope-library internal environment lines
  (today's date, OS name, temp/workspace/project paths — third-party text, not
  WorkPal prompt bodies); recursive key-order canonicalization of captured tool
  schemas (library map-serialization nondeterminism; JSON key order carries no
  semantics). All WorkPal-composed prompt text, message structure and schema
  content are compared byte-exact.
- Regenerate ONLY with `AG04_WRITE_BASELINE=1 pnpm vitest run
  packages/testkit/src/prompt-files-baseline.integration.test.ts`; a
  regeneration diff outside an intentional, reviewed prompt change is a
  contract breach. These goldens are the independent pre-move record — never
  regenerate them from the moved sources to "make green".
