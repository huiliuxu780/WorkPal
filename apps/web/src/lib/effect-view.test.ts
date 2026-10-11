import { i18n } from "@lingui/core";
import { EffectStatus } from "@rakazo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { effectView } from "./effect-view";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("external effect status", () => {
  it("recognizes statuses written by the executor and legacy rows", () => {
    for (const status of ["intended", "approved", "denied", "executing", "completed", "uncertain", "failed", "ambiguous", "reconciled"]) {
      expect(EffectStatus.parse(status)).toBe(status);
    }
  });

  it("keeps uncertain and claimed effects distinct from confirmed success", () => {
    expect(effectView("uncertain")).toMatchObject({ label: "Result unconfirmed", tone: "warning" });
    expect(effectView("uncertain").note).toContain("Cannot confirm whether");
    expect(effectView("executing")).toMatchObject({ label: "Execution claimed; outcome unconfirmed", tone: "warning" });
    expect(effectView("completed").label).toBe("Call recorded as completed");
  });
});
