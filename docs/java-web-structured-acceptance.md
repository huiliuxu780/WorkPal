# Java → Web structured execution acceptance

The AgentScope browser suite now includes an emulator-driven, production-path trace. The Java runtime calls `publish_run_plan` and `publish_run_step`, revises both, then sends the final answer. The browser test confirms that the database-backed thread snapshot contains Plan revision 2 and a completed Step with the same Run ID, that the Run is terminal in `recentRuns`, and that Web renders exactly one Execution Shell whose Plan and Step disclosures become visible when opened.

On 2026-10-12 the full `agentscope-product.spec.ts` suite passed locally: four Chromium tests, including this structured trace. It used Java 21, the actual API and Web servers, a local disposable PostgreSQL database with all 100 migrations, and the model emulator. The database was dropped after the run. The harness also retains its container-backed default for CI; an explicit local `workpal_e2e_` database URL allows this acceptance run on hosts without a container runtime.

This verifies the structured Plan/Step path, not background outbox delivery, USD budget enforcement, Todo publication, full intervention flow or the Task 14/16 acceptance matrix. Plan and Step completion in this fixture are model-reported and do not independently prove an external side effect.
