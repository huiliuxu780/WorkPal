/** Directories a Playwright CI job uploads after failure or cancellation. */
export const PLAYWRIGHT_EVIDENCE_PATHS = [
  "playwright-report/",
  "apps/web/test-results/",
  "test-report/",
] as const;

/** Failure evidence retention. Daily visual screenshots use a separate period. */
export const PLAYWRIGHT_EVIDENCE_RETENTION_DAYS = 7;
export const DAILY_VISUAL_RETENTION_DAYS = 14;

/** Scripted specs the single daily visual entry runs. Not the full E2E suite. */
export const DAILY_VISUAL_SPECS = ["ui-appearance.spec.ts", "settings-shell.spec.ts"] as const;

export function playwrightEvidenceArtifactName(job: string, sha: string, attempt: string) {
  if (!job || !sha || !attempt) {
    throw new Error("Playwright evidence artifact name needs job, sha, and attempt");
  }
  return `playwright-${job}-${sha}-${attempt}`;
}

export function dailyVisualArtifactName(sha: string, attempt: string) {
  if (!sha || !attempt) {
    throw new Error("Daily visual artifact name needs sha and attempt");
  }
  return `daily-visual-${sha}-${attempt}`;
}
