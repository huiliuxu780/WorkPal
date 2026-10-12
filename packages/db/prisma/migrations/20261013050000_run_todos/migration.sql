CREATE TABLE "run_todos" (
    "runId" TEXT NOT NULL,
    "todoId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "current" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "run_todos_pkey" PRIMARY KEY ("runId","todoId")
);
CREATE INDEX "run_todos_runId_sortOrder_idx" ON "run_todos"("runId","sortOrder");
ALTER TABLE "run_todos" ADD CONSTRAINT "run_todos_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_todo_mutations" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "todoId" TEXT NOT NULL,
    "toolExecutionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "run_todo_mutations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "run_todo_mutations_runId_toolExecutionId_key" ON "run_todo_mutations"("runId","toolExecutionId");
CREATE UNIQUE INDEX "run_todo_mutations_runId_todoId_revision_key" ON "run_todo_mutations"("runId","todoId","revision");
ALTER TABLE "run_todo_mutations" ADD CONSTRAINT "run_todo_mutations_runId_todoId_fkey" FOREIGN KEY ("runId","todoId") REFERENCES "run_todos"("runId","todoId") ON DELETE CASCADE ON UPDATE CASCADE;
