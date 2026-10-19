This run is a manual retry of a previous attempt of the same task. The user asked to finish the original task, not to start a new one.

Original task:
{{originalTask}}

{{operationSection}}

Continue the original task. Do not treat this message as a new user request. When continuing a listed operation, pass retryOperationId in the tool arguments with that exact id; the server strips this field before sending. Omit retryOperationId only to start a new independent operation. Do not invent ids from other tasks. Do not repeat an external send for a completed operation.
