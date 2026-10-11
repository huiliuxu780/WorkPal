import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { selectExecutionActivity } from "./execution-activity";

const run = (status: Run["status"]) => ({ id: "run-1", status }) as Run;
const item = (id: string, status: ActivityItem["status"], runId = "run-1") =>
  ({ id, runId, status, kind: "working", title: `Activity ${id}`, botId: "bot", threadId: "thread" }) as ActivityItem;

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("selectExecutionActivity", () => {
  it("takes current work only from same-Run running evidence", () => {
    const view = selectExecutionActivity(run("running"), [item("other", "running", "other-run"), item("done", "completed"), item("now", "running")]);
    expect(view.primary).toBe("Activity now");
    expect(view.recent.map((entry) => entry.id)).toEqual(["done"]);
  });

  it("keeps stale running rows out of terminal current and recent views", () => {
    const view = selectExecutionActivity(run("completed"), [item("old", "running"), item("done", "completed")]);
    expect(view.primary).toBeNull();
    expect(view.note).toBe("Some activity statuses have not synchronized");
    expect(view.recent.map((entry) => entry.id)).toEqual(["done"]);
  });

  it("pauses the current line during a persisted wait", () => {
    const view = selectExecutionActivity(run("waiting_input"), [item("old", "running"), item("ask", "waiting")]);
    expect(view.primary).toBe("Activity ask");
    expect(view.note).toBe("Activity paused while waiting for you");
    expect(view.recent).toEqual([]);
  });

  it("reports only the hidden count inside the projected window", () => {
    const view = selectExecutionActivity(run("completed"), Array.from({ length: 9 }, (_, index) => item(`${index}`, "completed")));
    expect(view.recent).toHaveLength(6);
    expect(view.hiddenCount).toBe(3);
  });
});
