import { i18n } from "@lingui/core";
import type { Run } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExecutionShell } from "./ExecutionShell";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

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

  it("keeps a failed execution open while its child sections can fold", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("failed")} activity={[]}>
        <div>失败详情</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain(" inert=");
  });

  it("follows server-driven expansion for a restored terminal Run", () => {
    const collapsed = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain("hidden");
    const opened = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).not.toContain('hidden=""');
  });

  it("shows the durable status and id for a Run restored without a legacy row", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={{ id: "run-history", status: "completed", waitKind: null }}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-run-id="run-history"');
    expect(html).toContain('data-status="done"');
    expect(html).not.toContain("Status unknown");
  });

  it("keeps the intervention slot visible while a controlled detail stays collapsed", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        interventions={<div data-testid="intervention-region">需要你处理</div>}
      >
        <div>detail</div>
      </ExecutionShell>,
    );
    expect(html).toContain("execution-interventions");
    expect(html).toContain("需要你处理");
    expect(html).toContain("hidden");
  });
});
