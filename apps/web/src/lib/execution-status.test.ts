import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveExecutionStatus } from "./execution-status";

const run = (status: Run["status"], waitKind: Run["waitKind"] = null) =>
  ({ id: "root", status, waitKind, error: null }) as Run;
const activity = (kind: ActivityItem["kind"], status: ActivityItem["status"] = "running") =>
  [{ id: kind, runId: "root", kind, status, title: "检查配置" }] as ActivityItem[];

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("execution display status", () => {
  it("gives the root Run terminal state priority over stale activity", () => {
    expect(deriveExecutionStatus(run("completed"), activity("approval", "waiting")).status).toBe("done");
    expect(deriveExecutionStatus(run("failed"), activity("planning")).status).toBe("failed");
    expect(deriveExecutionStatus(run("cancelled"), activity("planning")).status).toBe("cancelled");
  });

  it("distinguishes approval, input, and takeover using persisted wait kind", () => {
    expect(deriveExecutionStatus(run("waiting_input", "approval"), []).status).toBe("approval");
    expect(deriveExecutionStatus(run("waiting_input", "input"), []).status).toBe("need_input");
    expect(deriveExecutionStatus(run("waiting_takeover", "takeover"), []).status).toBe("blocked");
  });

  it("does not turn a child background activity into root background mode", () => {
    expect(deriveExecutionStatus(run("running"), activity("background")).status).toBe("working");
    expect(deriveExecutionStatus(run("queued"), activity("background")).label).toBe("Waiting to start");
    expect(deriveExecutionStatus(run("running"), activity("planning")).status).toBe("planning");
    expect(deriveExecutionStatus(run("queued"), [], { confirmedRootBackground: true }).status).toBe("background");
  });

  it("shows unknown when no root Run can be verified", () => {
    expect(deriveExecutionStatus(null, activity("planning")).status).toBe("unknown");
  });
});
