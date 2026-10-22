import { describe, expect, it } from "vitest";
import { ROUNDTABLE_CONTRACT_INVALID, RoundtableContractError } from "./roundtable-contracts.js";
import {
  ROUNDTABLE_FEATURE_DISABLED,
  RoundtableFeatureDisabledError,
  resolveRoundtableFeatureGates,
} from "./roundtable-feature-gates.js";
import {
  authorizeInterventionPresentation,
  resolveInterventionThreads,
} from "./roundtable-intervention.js";

const disabled = resolveRoundtableFeatureGates({});
const pairEnabled = resolveRoundtableFeatureGates({ ROUNDTABLE_PRIVATE_PAIR_ENABLED: "true" });

const EXECUTION = "thread_pair_joy_blue";
const PRESENTATION = "thread_joy_user";
const ORIGIN = { sourceThreadId: PRESENTATION, sourceRunId: "run_joy_source" };

function contractError(fn: () => unknown): RoundtableContractError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RoundtableContractError);
    return error as RoundtableContractError;
  }
  throw new Error("expected a RoundtableContractError");
}

describe("resolveInterventionThreads", () => {
  it("keeps a directly started Run on its own Thread without any gate", () => {
    expect(resolveInterventionThreads({ gates: disabled, executionThreadId: EXECUTION })).toEqual({
      executionThreadId: EXECUTION,
      presentationThreadId: EXECUTION,
      crossThread: false,
      origin: null,
    });
  });

  it("treats an explicit same-Thread presentation as the ordinary case", () => {
    const threads = resolveInterventionThreads({
      gates: disabled,
      executionThreadId: EXECUTION,
      presentationThreadId: EXECUTION,
    });
    expect(threads.crossThread).toBe(false);
    expect(threads.presentationThreadId).toBe(EXECUTION);
  });

  it("binds a collaboration Run to the originating visible Thread", () => {
    expect(
      resolveInterventionThreads({
        gates: pairEnabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
        origin: ORIGIN,
      }),
    ).toEqual({
      executionThreadId: EXECUTION,
      presentationThreadId: PRESENTATION,
      crossThread: true,
      origin: ORIGIN,
    });
  });

  it("refuses a cross-Thread binding while the pair capability is disabled", () => {
    try {
      resolveInterventionThreads({
        gates: disabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
        origin: ORIGIN,
      });
      throw new Error("expected the disabled capability to reject the binding");
    } catch (error) {
      expect(error).toBeInstanceOf(RoundtableFeatureDisabledError);
      expect(error).toMatchObject({
        code: ROUNDTABLE_FEATURE_DISABLED,
        feature: "private_pair",
        retryable: false,
      });
    }
  });

  it("fails on the gate before it ever inspects a missing origin", () => {
    // A deployment without the capability must not learn anything about the
    // request: the feature refusal wins over the contract refusal.
    const error = contractError(() =>
      resolveInterventionThreads({
        gates: pairEnabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
      }),
    );
    expect(error).toMatchObject({ code: ROUNDTABLE_CONTRACT_INVALID, path: "origin" });
    expect(
      resolveInterventionThreads.bind(null, {
        gates: disabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
      }),
    ).toThrow(RoundtableFeatureDisabledError);
  });

  it("rejects an origin anchored in a different Thread than the presentation", () => {
    const error = contractError(() =>
      resolveInterventionThreads({
        gates: pairEnabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
        origin: { sourceThreadId: "thread_someone_else", sourceRunId: "run_joy_source" },
      }),
    );
    expect(error).toMatchObject({
      code: ROUNDTABLE_CONTRACT_INVALID,
      contract: "InterventionThreads",
      path: "origin.sourceThreadId",
    });
  });

  it("rejects an origin that is not a CollaborationOrigin", () => {
    const error = contractError(() =>
      resolveInterventionThreads({
        gates: pairEnabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
        origin: { sourceThreadId: PRESENTATION },
      }),
    );
    expect(error).toMatchObject({ contract: "CollaborationOrigin", path: "sourceRunId" });
  });

  it("does not silently ignore an origin supplied for a same-Thread Intervention", () => {
    const error = contractError(() =>
      resolveInterventionThreads({
        gates: disabled,
        executionThreadId: EXECUTION,
        origin: { sourceThreadId: PRESENTATION, sourceRunId: "run_joy_source" },
      }),
    );
    expect(error.path).toBe("origin.sourceThreadId");
  });

  it("accepts an origin anchored in the executing Thread itself", () => {
    const threads = resolveInterventionThreads({
      gates: disabled,
      executionThreadId: EXECUTION,
      origin: { sourceThreadId: EXECUTION, sourceRunId: "run_same_thread" },
    });
    expect(threads.crossThread).toBe(false);
  });

  it("rejects Thread identifiers that are not non-empty strings", () => {
    // Both identifiers go through the frozen ThreadId parser, so the failure
    // names the contract rather than the field.
    expect(
      contractError(() => resolveInterventionThreads({ gates: disabled, executionThreadId: "" }))
        .message,
    ).toBe("ThreadId: expected a non-empty string");
    expect(
      contractError(() =>
        resolveInterventionThreads({
          gates: pairEnabled,
          executionThreadId: EXECUTION,
          presentationThreadId: 42,
          origin: ORIGIN,
        }),
      ).message,
    ).toBe("ThreadId: expected a string");
  });
});

describe("authorizeInterventionPresentation", () => {
  it("accepts an ordinary same-Thread submission with every capability disabled", () => {
    expect(
      authorizeInterventionPresentation({
        gates: disabled,
        executionThreadId: EXECUTION,
        presentationThreadId: EXECUTION,
      }),
    ).toEqual({
      executionThreadId: EXECUTION,
      presentationThreadId: EXECUTION,
      crossThread: false,
      origin: null,
    });
  });

  it("accepts a submission from the bound presentation Thread once the pair capability is on", () => {
    expect(
      authorizeInterventionPresentation({
        gates: pairEnabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
      }).crossThread,
    ).toBe(true);
  });

  it("stops honouring a cross-Thread binding when the capability is turned back off", () => {
    try {
      authorizeInterventionPresentation({
        gates: disabled,
        executionThreadId: EXECUTION,
        presentationThreadId: PRESENTATION,
      });
      throw new Error("expected the disabled capability to reject the submission");
    } catch (error) {
      expect(error).toBeInstanceOf(RoundtableFeatureDisabledError);
      expect(error).toMatchObject({ feature: "private_pair", retryable: false });
    }
  });

  it("rejects identifiers that are not non-empty strings", () => {
    expect(
      contractError(() =>
        authorizeInterventionPresentation({
          gates: pairEnabled,
          executionThreadId: EXECUTION,
          presentationThreadId: "",
        }),
      ).message,
    ).toBe("ThreadId: expected a non-empty string");
  });
});
