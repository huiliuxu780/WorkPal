import {
  type CollaborationOrigin,
  parseCollaborationOrigin,
  parseThreadId,
  RoundtableContractError,
  type ThreadId,
} from "./roundtable-contracts.js";
import {
  assertRoundtableFeatureEnabled,
  type RoundtableFeatureGates,
} from "./roundtable-feature-gates.js";

const CONTRACT = "InterventionThreads";

/**
 * Where an Intervention executes, and where the user answers it.
 *
 * `executionThreadId` is the bound Run's own Thread: it holds the ask Message,
 * and a decision resumes that Run and no other. `presentationThreadId` is the
 * Thread whose snapshot projects the card and whose RPC accepts the submission.
 * The two are equal for every Run a user started directly. They differ only for
 * a collaboration Run executing in a Thread the user must not write to — a fixed
 * Agent pair — where the decision still has to be reachable from the visible
 * Thread that originated the work.
 */
export type InterventionThreads = Readonly<{
  executionThreadId: ThreadId;
  presentationThreadId: ThreadId;
  crossThread: boolean;
  /**
   * The parsed origin of a cross-Thread binding, so the caller can verify the
   * source Run against the database instead of trusting the anchor it was handed.
   * Null for an ordinary same-Thread wait and at submission time.
   */
  origin: CollaborationOrigin | null;
}>;

/**
 * Bind a new Intervention to the Thread the user answers from.
 *
 * `origin` is the CollaborationOrigin of the Run that executes away from the
 * user. It is required exactly when the two Threads differ, and its
 * `sourceThreadId` must be the presentation Thread: the anchor is what makes the
 * foreign wait publishable there instead of into an arbitrary Thread. Answering
 * away from the executing Thread stays behind the pair gate, so a deployment
 * that has not enabled it fails instead of silently exposing another Thread's
 * wait.
 */
export function resolveInterventionThreads(input: {
  gates: RoundtableFeatureGates;
  executionThreadId: unknown;
  presentationThreadId?: unknown;
  origin?: unknown;
}): InterventionThreads {
  const executionThreadId = parseThreadId(input.executionThreadId);
  const presentationThreadId =
    input.presentationThreadId === undefined || input.presentationThreadId === null
      ? executionThreadId
      : parseThreadId(input.presentationThreadId);
  const origin = input.origin === undefined ? null : parseCollaborationOrigin(input.origin);
  if (origin !== null && origin.sourceThreadId !== presentationThreadId) {
    throw new RoundtableContractError(
      CONTRACT,
      "origin.sourceThreadId",
      "must be the Thread the user answers from",
    );
  }
  if (presentationThreadId === executionThreadId) {
    return { executionThreadId, presentationThreadId, crossThread: false, origin };
  }
  assertRoundtableFeatureEnabled(input.gates, "private_pair");
  if (origin === null) {
    throw new RoundtableContractError(
      CONTRACT,
      "origin",
      "a cross-Thread Intervention requires its CollaborationOrigin",
    );
  }
  return { executionThreadId, presentationThreadId, crossThread: true, origin };
}

/**
 * Authorize a submission that arrives on an already-bound presentation Thread.
 *
 * The origin was validated when the Intervention was created and the row's own
 * `threadId` is the persisted anchor, so only the gate is re-checked here: a
 * deployment that disables the pair feature must stop accepting cross-Thread
 * decisions rather than keep honouring bindings it can no longer create.
 */
export function authorizeInterventionPresentation(input: {
  gates: RoundtableFeatureGates;
  executionThreadId: unknown;
  presentationThreadId: unknown;
}): InterventionThreads {
  const executionThreadId = parseThreadId(input.executionThreadId);
  const presentationThreadId = parseThreadId(input.presentationThreadId);
  if (presentationThreadId !== executionThreadId) {
    assertRoundtableFeatureEnabled(input.gates, "private_pair");
  }
  return {
    executionThreadId,
    presentationThreadId,
    crossThread: presentationThreadId !== executionThreadId,
    origin: null,
  };
}
