import { describe, expect, it } from "vitest";
import { filterToolsForPlanPhase, PLAN_SERVICE_TOOL_NAMES } from "./executor.js";

type Tool = { name: string; readOnly?: boolean };

const surface: Tool[] = [
  { name: "read_file", readOnly: true },
  { name: "web_search", readOnly: true },
  { name: "task_catalog", readOnly: true },
  { name: "plan_enter" },
  { name: "plan_write" },
  { name: "plan_exit" },
  { name: "publish_run_plan" },
  { name: "publish_run_step" },
  { name: "publish_run_todo" },
  { name: "ask_user" },
  { name: "runtime_current_time" },
  { name: "shell" },
  { name: "write_file" },
  { name: "send_email" },
  { name: "gmail_send_email", readOnly: false },
];

/**
 * UX-02 / U-A14: the per-request surface expresses the plan phase. While the
 * run is in the read-only PLAN phase, mutating tools disappear from the next
 * model call's schema list; reads, plan records and user interaction stay.
 * Outside the planning phase the surface is untouched (AG-05 revocation and
 * TurnPolicy gating remain the only other filters).
 */
describe("filterToolsForPlanPhase", () => {
  it("drops mutating tools while the PLAN phase is active", () => {
    const names = filterToolsForPlanPhase(surface, "planning").map((tool) => tool.name);
    expect(names).not.toContain("shell");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("gmail_send_email");
    // Reads, plan records and interaction survive the phase filter.
    for (const kept of [
      "read_file",
      "web_search",
      "task_catalog",
      ...PLAN_SERVICE_TOOL_NAMES,
      "publish_run_step",
      "publish_run_todo",
      "ask_user",
      "runtime_current_time",
    ]) {
      expect(names).toContain(kept);
    }
  });

  it("keeps declared read-only connector tools in the PLAN phase", () => {
    const withConnector: Tool[] = [
      ...surface,
      { name: "crm_list_records", readOnly: true },
      { name: "crm_write_record", readOnly: false },
    ];
    const names = filterToolsForPlanPhase(withConnector, "planning").map((tool) => tool.name);
    expect(names).toContain("crm_list_records");
    expect(names).not.toContain("crm_write_record");
  });

  it("is a no-op outside the planning phase", () => {
    expect(filterToolsForPlanPhase(surface, "build")).toEqual(surface);
    expect(filterToolsForPlanPhase(surface, null)).toEqual(surface);
    expect(filterToolsForPlanPhase(surface, undefined)).toEqual(surface);
  });
});
