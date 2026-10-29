// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are literal workflow text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAILY_VISUAL_RETENTION_DAYS,
  DAILY_VISUAL_SPECS,
  dailyVisualArtifactName,
  PLAYWRIGHT_EVIDENCE_PATHS,
  PLAYWRIGHT_EVIDENCE_RETENTION_DAYS,
  playwrightEvidenceArtifactName,
} from "./playwright-evidence.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("Playwright CI evidence paths", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const playwrightConfig = readFileSync(
    path.join(repoRoot, "apps/web/playwright.config.ts"),
    "utf8",
  );

  it("names failure evidence with job, sha, and attempt and uploads every diagnostic path", () => {
    expect(playwrightEvidenceArtifactName("web", "abc123", "2")).toBe("playwright-web-abc123-2");
    expect(workflow).toContain(
      "playwright-${{ github.job }}-${{ github.sha }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(`retention-days: ${PLAYWRIGHT_EVIDENCE_RETENTION_DAYS}`);
    for (const evidencePath of PLAYWRIGHT_EVIDENCE_PATHS) {
      expect(workflow).toContain(evidencePath);
    }
    for (const job of ["web", "agentscope", "worker-chain"]) {
      const block =
        workflow.match(new RegExp(`^  ${job}:[\\s\\S]*?(?=^  [a-z0-9-]+:)`, "m"))?.[0] ?? "";
      expect(block, job).toContain("failure() || cancelled()");
      expect(block, job).toContain("if-no-files-found: warn");
      expect(block, job).toContain("playwright-report/");
      expect(block, job).toContain("apps/web/test-results/");
      expect(block, job).toContain("test-report/");
    }
  });

  it("runs one daily visual entry and uploads its screenshots and report", () => {
    expect(dailyVisualArtifactName("abc123", "1")).toBe("daily-visual-abc123-1");
    expect(workflow).toContain("daily-visual-${{ github.sha }}-${{ github.run_attempt }}");
    expect(workflow).toContain(`retention-days: ${DAILY_VISUAL_RETENTION_DAYS}`);
    expect(workflow).toContain(DAILY_VISUAL_SPECS.join("|"));
    expect(workflow).toContain("mode == 'visual'");
    const options = workflow.split("options:")[1]?.split("default:")[0] ?? "";
    expect(options).toContain("visual");
  });

  it("keeps HTML, trace, screenshot, and video on the Playwright config", () => {
    expect(playwrightConfig).toContain('outputFolder: "../../playwright-report"');
    expect(playwrightConfig).toContain('outputDir: "test-results"');
    expect(playwrightConfig).toContain('trace: "retain-on-failure"');
    expect(playwrightConfig).toContain('screenshot: "only-on-failure"');
    expect(playwrightConfig).toContain('video: "retain-on-failure"');
  });
});
