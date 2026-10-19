/**
 * Deterministic content-safety gates for the memory pipelines (ME-01/ME-02).
 * These are conservative server-side checks applied BEFORE anything is
 * committed or published; they complement — never replace — the rule that
 * secrets are handled only through the existing credential mechanisms.
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/, // OpenAI-style keys
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /AKIA[0-9A-Z]{16}/, // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWTs
];

/** True when the text contains credential-shaped content. */
export function containsSecretLikeContent(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * One-time codes and OTP-shaped values must never become memories.
 * CJK keywords cannot use \b word boundaries (CJK characters are non-word
 * characters in JS regex), so they are matched bare; the latin keywords keep
 * their boundaries to avoid false hits like "zipcode 12345".
 */
export function containsOneTimeCode(text: string): boolean {
  return /(?:\b(?:code|otp)\b|验证码|认证码|校验码|一次性密码)[^0-9]{0,12}\d{4,8}(?!\d)/i.test(
    text,
  );
}

/**
 * Verbatim-copy guard: fact text must be the service's own summarized
 * wording. A shared run of >= minRun characters between the candidate and a
 * source message means the model transcribed user words instead of
 * summarizing them.
 */
export function sharesVerbatimRun(candidate: string, sources: string[], minRun = 60): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  if (normalizedCandidate.length < minRun) return false;
  for (const source of sources) {
    const normalizedSource = normalizeForComparison(source);
    if (normalizedSource.length < minRun) continue;
    for (let start = 0; start + minRun <= normalizedCandidate.length; start += 1) {
      if (normalizedSource.includes(normalizedCandidate.slice(start, start + minRun))) {
        return true;
      }
    }
  }
  return false;
}

function normalizeForComparison(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}
