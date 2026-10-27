# RT-12 group membership approval evidence

Captured from the production Web app against the real API and PostgreSQL
(`pnpm test:e2e --runtime=scripted --spec="group-membership.spec.ts"`), not from
component fixtures.

| File | Scenario |
| --- | --- |
| `X-GROUP-APPROVE-1440.png` | `index.html?branch=X-GROUP-APPROVE`: Joy is not in the room yet; the scoped inline approval asks to add Joy and continue. No target message exists. |
| `X-GROUP-APPROVE-430.png` | Same pending state at 430px; no horizontal overflow. |
| `X-GROUP-APPROVE-terminal-1440.png` | After “Join and continue”: the card shows Joined, the target room result is back, and the source direct chat has the separate report. |
| `X-GROUP-APPROVE-terminal-430.png` | Terminal state at 430px. |
| `X-GROUP-FAIL-1440.png` | X-GROUP-FAIL only: the approval revalidation found member-management permission gone, so no join, no target message, and no approval card remain. |
| `X-GROUP-FAIL-430.png` | Failure card at 430px; no horizontal overflow. |

The failure case simulates the only way a readable standard group becomes
unmanageable in this repository: the group's owner changes after the card is
shown. Unreadable groups keep the existing “no group found” rule; RT-12 does not
widen reads to manufacture a failure card.
