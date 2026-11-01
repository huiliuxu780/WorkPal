import { useLingui } from "@lingui/react/macro";
import { Link2 } from "lucide-react";
import { SandboxedHtmlViewer } from "../SandboxedHtmlViewer";

/** Shared read-only page shell for the (login-scoped) Space link and the public link. */
export function ReadOnlyPageView({
  testId,
  name,
  meta,
  html,
  banner,
}: {
  testId: string;
  name: string;
  meta: string;
  html: string;
  banner?: string;
}) {
  const { t } = useLingui();
  return (
    <div
      className="flex min-h-dvh flex-col bg-background text-foreground"
      data-testid={testId}
      data-state="ok"
    >
      <header className="flex flex-none items-center gap-2 border-b border-border px-5 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Link2 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] leading-5 font-semibold" dir="auto">
            {name}
          </h1>
          <p className="text-[11.5px] leading-4 text-muted-foreground">{meta}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {t`只读`}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden bg-white">
        <SandboxedHtmlViewer html={html} title={name} />
      </div>
      {banner ? (
        <div
          className="flex flex-none items-center justify-center border-t border-border px-4 py-2 text-center text-[11.5px] text-muted-foreground"
          data-testid="readonly-banner"
        >
          {banner}
        </div>
      ) : null}
    </div>
  );
}
