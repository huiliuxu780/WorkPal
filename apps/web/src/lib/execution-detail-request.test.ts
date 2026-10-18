import { describe, expect, it } from "vitest";
import {
  beginDetailRequest,
  clearDetailRequest,
  detailRequestStatus,
  failDetailRequest,
  settleDetailRequest,
} from "./execution-detail-request";

/**
 * UX-01C acceptance 14: per-Run detail request state, kept OUTSIDE the
 * rev-versioned ExecutionDetailCache — an error is a request fact, never a
 * snapshot version.
 */
describe("execution detail request state", () => {
  it("defaults to idle and tracks per-Run transitions", () => {
    let map = {};
    expect(detailRequestStatus(map, "run-1")).toBe("idle");
    map = beginDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("loading");
    expect(detailRequestStatus(map, "run-2")).toBe("idle");
    map = failDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("error");
    map = beginDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("loading");
    map = settleDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("idle");
  });

  it("clears a previous error on success", () => {
    let map = failDetailRequest({}, "run-1");
    map = beginDetailRequest(map, "run-1");
    map = settleDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("idle");
  });

  it("keeps other Runs untouched", () => {
    let map = failDetailRequest({}, "run-1");
    map = beginDetailRequest(map, "run-2");
    expect(detailRequestStatus(map, "run-1")).toBe("error");
    expect(detailRequestStatus(map, "run-2")).toBe("loading");
  });

  it("drops a single Run's state without touching the rest", () => {
    let map = failDetailRequest({}, "run-1");
    map = failDetailRequest(map, "run-2");
    map = clearDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1")).toBe("idle");
    expect(detailRequestStatus(map, "run-2")).toBe("error");
  });

  it("is immutable per transition (callers can rely on identity checks)", () => {
    const map = {};
    expect(beginDetailRequest(map, "run-1")).not.toBe(map);
    const loading = beginDetailRequest(map, "run-1");
    expect(settleDetailRequest(loading, "run-2")).toBe(loading);
  });
});
