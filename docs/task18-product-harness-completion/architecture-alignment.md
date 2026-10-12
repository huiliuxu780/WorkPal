# Architecture alignment

The backend retains identity, permissions, long-lived Threads and full transcript, Tasks/Runs, files, effects and audit. AgentScope Java is the only production Agent executor. Product Events are PostgreSQL facts ordered by per-Thread `seq`; clients consume them through the existing snapshot and live reducer. A new event does not grant a model a tool or resource.

Task 18 adds control-plane facts and constraints to existing processes. Its short Bot/Thread/Run/Routine diagram does not replace the existing Task→Run relationship defined by Task 17 or the `Run.taskId` foreign key. A Routine wake continues to create a Task and Run. The UI may hide Task for simple answers while keeping its audit record.

Task 18.1 adds only envelope fields and wait reasons. New event types introduced here have no display behavior until their owning feature is implemented. `approval.requested` and `approval.resolved` record the existing approval path and never create another approval card.
