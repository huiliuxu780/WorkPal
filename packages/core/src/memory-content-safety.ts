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
 * Deterministic explicit-refusal detection (review P1-1): when the trusted
 * source message itself declines memory storage, a model-initiated remember
 * call must never activate — it is demoted to a candidate at most. The
 * patterns are deliberately narrow (explicit "do not save/remember" phrasing
 * in English and Chinese); a false positive only costs a confirmation step,
 * while a miss would store memory against the user's stated will.
 */
const MEMORY_REFUSAL_PATTERNS: RegExp[] = [
  /\bdo\s?n[o']t\s+(?:remember|save|store|keep|memorize|note|record)\b/i,
  /\bdon[o']t\s+want\s+to\s+(?:save|store|remember|keep|record|memorize)\b/i,
  /\bnever\s+(?:remember|save|store|keep|memorize|record)\b/i,
  /\bwithout\s+(?:saving|storing|remembering|keeping|recording)\b/i,
  /\bstop\s+(?:remembering|saving|storing|recording)\b/i,
  /\bdon[o']t\s+(?:remember|save|store|keep|memorize|note|record)\b/i,
  /不要(?:记住|保存|记录|存储|记下|存下|收录)/,
  /不想(?:保存|记录|记|存)/,
  /别(?:记住|保存|记录|存下|存)/,
  // Bare "别记…" (e.g. 别记这个) except the affirmative "特别记…".
  /(?:^|[^特])别记/,
  /不用(?:记住|保存|记录|存)/,
  /请勿(?:记住|保存|记录|存储)/,
  /不需要(?:记住|保存|记录|存)/,
  /(?:禁止|不准)(?:记住|保存|记录)/,
];

export function containsMemoryRefusal(text: string): boolean {
  return MEMORY_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Review rounds R2+R3: a verbatim span check alone cannot prove
 * authorization, and neither can a bare storage imperative. The quoted span
 * must ITSELF be an explicit request to store something in LONG-TERM MEMORY:
 *
 * - Verbs inherently about memory (remember, memorize, don't forget, note
 *   this down, make/take a note, keep in mind, the CJK 记-family) authorize
 *   on their own.
 * - Ambiguous storage verbs (save/store/record/keep/保存/存/收录…) authorize
 *   ONLY when the span names a memory target (memory/mind/记忆/备忘/心里…).
 *   "Save this invoice as a PDF in Downloads" is a file operation and must
 *   never authorize a durable memory (review R3): an already-activated
 *   record never passes through candidate confirmation, so after-the-fact
 *   deletion is not a substitute for authorization — ambiguous targets
 *   demote to a candidate instead.
 *
 * Detection stays deterministic (curated patterns), never semantic: a false
 * negative costs one confirmation click, a false activation would create an
 * unauthorized durable memory. Refusals inside the span veto everything.
 */
const MEMORY_AUTHORIZATION_PATTERNS: RegExp[] = [
  // Inherently-memory directives at the start of the quote or of a sentence
  // inside it (optional politeness prefix). A bare mid-clause "remember
  // that …" stays unmatched so reminiscing ("I remember that day") never
  // authorizes.
  /(?:^|[.!?;。！？；]\s*)(?:please\s+|pls\s+|kindly\s+)?(?:remember|memorize|memorise)\b/i,
  // Note-taking and mind-keeping idioms are memory directives.
  /\bnote\s+(?:this|that|it)\s+down\b/i,
  /\b(?:make|take)\s+(?:a\s+)?notes?\b/i,
  /\bkeep\s+(?:this|that|it)\s+(?:in\s+mind|noted)\b/i,
  /\bdon'?t\s+forget\b/i,
  // Ambiguous storage verbs require an explicit memory target in the span.
  /\b(?:save|store|record|commit|add|keep|put|write)\b[^.!?]{0,60}\b(?:memory|memories|mind)\b/i,
  // Chinese: the 记-family is inherently about memory. 记得 ("I recall")
  // deliberately matches none of these.
  /记住|记下|记一下|记下来|记入|记到|帮我记|请记|劳驾记/,
  /别忘了|别忘记|勿忘/,
  // Ambiguous Chinese storage verbs require an explicit memory target too:
  // "保存到下载目录" is a file operation, "保存到记忆里" is a memory request.
  /(?:保存|存|放|收录|加|写)(?:到|至|进|入|在|成)?[^。！？]{0,12}(?:记忆|备忘|脑子|心里)/,
  /(?:记忆|备忘)(?:里|中|内)/,
];

export function isMemoryAuthorizationQuote(quote: string): boolean {
  const normalized = quote.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (containsMemoryRefusal(normalized)) return false;
  return MEMORY_AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(normalized));
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
