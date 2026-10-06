import { describe, expect, it } from "vitest";
import { bloubStaticFrame, BLOUB_EXPRESSION_IDS, BLOUB_SHAPE_IDS } from "./static.js";

describe("bloub static frame", () => {
  it("composes a body path and two masked eyes without NaN", () => {
    const frame = bloubStaticFrame("cercle", "neutre");
    expect(frame.bodyPath).toMatch(/^M[-\d. ]+(C[-\d. ]+)+Z$/);
    expect(frame.bodyPath).not.toContain("NaN");
    expect(frame.eyes).toHaveLength(2);
    for (const eye of frame.eyes) {
      expect(eye.d).toContain("M");
      expect(eye.d).not.toContain("NaN");
      expect(eye.matrix).toMatch(/^matrix\(/);
      expect(eye.alpha).toBeGreaterThan(0);
      expect(eye.alpha).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to the site defaults for unknown ids", () => {
    expect(bloubStaticFrame("nope", "nope2")).toEqual(bloubStaticFrame("cercle", "neutre"));
  });

  it("exposes the site's eight shapes and sixteen expressions", () => {
    expect(BLOUB_SHAPE_IDS).toHaveLength(8);
    expect(BLOUB_EXPRESSION_IDS).toHaveLength(16);
  });

  it("caches frames per (shape, expression)", () => {
    expect(bloubStaticFrame("galet", "colere")).toBe(bloubStaticFrame("galet", "colere"));
  });

  it("renders every shape and expression combination cleanly", () => {
    for (const shape of BLOUB_SHAPE_IDS) {
      for (const expression of BLOUB_EXPRESSION_IDS) {
        const frame = bloubStaticFrame(shape, expression);
        expect(frame.bodyPath).not.toContain("NaN");
        expect(frame.eyes.length).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
