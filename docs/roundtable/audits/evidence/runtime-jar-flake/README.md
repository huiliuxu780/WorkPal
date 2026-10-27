# `runtime-jar` Java flake record (2026-10-27)

Record only. No Java code was changed for RT-12 (#146) or CARD-01D (#147), and
none was changed to make this job pass: the same SHA went red five times and
green on the sixth attempt.

## What failed

Job: `runtime-jar` → step `Run mvn -B -f services/agent-runtime/pom.xml package`.

RT-12 pull-request head `9df2257` (run
[40515059768](https://github.com/huiliuxu780/WorkPal/actions/runs/40515059768),
job `122227256696`) — every other job in that run was green:

```
[ERROR] Tests run: 7, Failures: 1, Errors: 0, Skipped: 0 -- in com.workpal.runtime.AgentScopeBackgroundProbeTest
[ERROR] com.workpal.runtime.AgentScopeBackgroundProbeTest.registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession <<< FAILURE!
org.opentest4j.AssertionFailedError: the delivered task must be marked delivered in the native repository ==> expected: not <null>
	at com.workpal.runtime.AgentScopeBackgroundProbeTest.registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession(AgentScopeBackgroundProbeTest.java:253)
```

Full excerpt: [`job-122227256696-excerpt.txt`](./job-122227256696-excerpt.txt).

## Rerun record at one SHA

Main run
[40519593634](https://github.com/huiliuxu780/WorkPal/actions/runs/40519593634),
merge commit `a409140` (PR #146). Six attempts, identical code:

| Attempt | `runtime-jar` job | Failing Java test | Error | Conclusion |
| --- | --- | --- | --- | --- |
| 1 | 122242847441 | `CompactionBoundaryIntegrationTest.nativeSummaryIsDistinctFromApplicationCompactionCursor` | `JUnit Failed to close extension context` | failure |
| 2 | 122247075301 | `AgentScopeBackgroundProbeTest.registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession` | `deliveredAt` expected not null | failure |
| 3 | 122248805386 | same as attempt 2 | same | failure |
| 4 | 122250916508 | same as attempt 2 | same | failure |
| 5 | 122252720455 | `RuntimeIntegrationTest.externalToolUsesTheAuthorizedBridgeAndReturnsToHarness` | `JUnit Failed to close extension context` | failure |
| 6 | 122258821959 | — | — | success |

Different tests failing on different attempts of the same SHA, then all passing,
is the flake signature; no attempt changed any input.

The same Java suite was green on the RT-12 heads before and after `9df2257`
(`490761b`, run
[40516729214](https://github.com/huiliuxu780/WorkPal/actions/runs/40516729214))
with no Java diff between them.

## Why this is not attributed to RT-12 or CARD-01D

`git diff --stat 91c92e3 a409140 -- services/agent-runtime` is empty: the RT-12
merge changed no Java runtime file. CARD-01D changes no Java file either.

## Audit note (tooling)

`gh run view --job <id> --log-failed` returned the *successful* attempt-6 mvn
output for attempt 1–5 job ids, which reads as "step failed but maven
succeeded". The authoritative per-attempt log is
`gh api repos/huiliuxu780/WorkPal/actions/jobs/<job-id>/logs --allow-escape-sequences`.
Every row above was taken from that endpoint.
