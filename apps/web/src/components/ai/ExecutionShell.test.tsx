import { i18n } from "@lingui/core";
import type { Run } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ExecutionShell } from "./ExecutionShell";

const run = (status: Run["status"], waitKind: Run["waitKind"] = null) =>
  ({ id: "run-1", status, waitKind, error: null }) as Run;

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("ExecutionShell", () => {
  it("keeps waiting details visible and exposes the true status", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("waiting_input", "approval")} activity={[]}>
        <button type="button">批准请求</button>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="approval"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("批准请求");
    expect(html).not.toContain(" inert=");
  });

  it("starts completed execution compact without claiming a result summary", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("completed")} activity={[]}>
        <div>真实步骤</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="done"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden");
  });
});
