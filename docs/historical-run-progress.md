# Task 13: historical Run status linkage

The thread snapshot now carries the 50 most recently updated terminal Runs, scoped to the authorized thread (and bot for a direct conversation). The existing Execution Shell can use those real Run statuses for older structured Plan, Step and Activity rows. A live terminal event adds its Run to the bounded list, so the row keeps its status before the next full refresh. This does not create a second status projector or alter the transcript.

This is only a status linkage. HISTORY-001 still needs a revisioned execution snapshot, summary, timeline window and pagination. Runs older than the bounded list do not receive a guessed status; the Shell remains in its unknown display state when there is no Run fact.
