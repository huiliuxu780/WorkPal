/**
 * Honest prompt-token estimation (ME-02). Exact token counts would require a
 * per-provider tokenizer this repo does not ship, so every budget decision
 * uses this estimator and is reported as "estimated tokens" — never as an
 * exact count. CJK code points cost roughly one token per character; other
 * text roughly four characters per token.
 */
const CJK_PATTERN =
  /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/;

export function estimatePromptTokens(text: string): number {
  let cjk = 0;
  for (const character of text) {
    if (CJK_PATTERN.test(character)) cjk += 1;
  }
  const other = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(other / 4);
}
