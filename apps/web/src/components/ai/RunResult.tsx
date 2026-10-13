import { t } from "@lingui/core/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ExecutionResult } from "@rakazo/contracts";

/**
 * The Run's committed result message inside the expanded detail. Renders the
 * server-redacted text blocks only (Ask blocks are already stripped upstream);
 * when no real text exists the section is omitted — a result is never
 * generated for the card or the detail.
 */
export function RunResult({ result }: { result?: ExecutionResult | null }) {
  const texts = (result?.blocks ?? []).filter(
    (block): block is Extract<typeof block, { kind: "text" }> =>
      block.kind === "text" && block.text.trim().length > 0,
  );
  if (!result || texts.length === 0) return null;
  return (
    <section
      data-slot="result"
      data-testid="execution-result"
      className="ms-1 my-2 min-w-0 text-[13px] text-foreground/85"
    >
      <h3 className="py-1 text-xs font-medium text-muted-foreground">{t`Result`}</h3>
      <div dir="auto" className="min-w-0 leading-5">
        {texts.map((block, index) => (
          <ChatMarkdown key={`${result.messageId}-${index}`}>{block.text}</ChatMarkdown>
        ))}
      </div>
      {result.truncated ? (
        <p className="pt-1 text-xs leading-5 text-muted-foreground">{t`Result preview truncated`}</p>
      ) : null}
    </section>
  );
}
