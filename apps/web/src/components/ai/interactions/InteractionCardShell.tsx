import { t } from "@lingui/core/macro";
import type { Icon } from "@phosphor-icons/react";
import type { InteractionView } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export type InteractionTone = "wait" | "ok" | "fail" | "neutral" | "expired";

const toneClasses: Record<InteractionTone, string> = {
  wait: "bg-link/10 text-link",
  ok: "bg-success/10 text-success",
  fail: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
  expired: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
};

const toneMarks: Record<InteractionTone, string> = {
  wait: "●",
  ok: "✓",
  fail: "!",
  neutral: "•",
  expired: "○",
};

export function InteractionStatusBadge({ label, tone }: { label: string; tone: InteractionTone }) {
  return (
    <span
      data-testid="interaction-status"
      data-tone={tone}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] leading-4",
        toneClasses[tone],
      )}
    >
      <span aria-hidden="true" className="text-[9px]">
        {toneMarks[tone]}
      </span>
      <span className="whitespace-normal">{label}</span>
    </span>
  );
}

export function interactionTone(view: InteractionView): InteractionTone {
  if (view.status === "pending") return "wait";
  if (view.status === "answered") {
    if (view.kind === "action_approval" && view.decision === "denied") return "fail";
    return "ok";
  }
  if (view.status === "cancelled") return "fail";
  if (view.status === "expired" || view.status === "superseded") return "expired";
  return "neutral";
}

export function interactionStatusLabel(view: InteractionView): string {
  if (view.status === "superseded") return t`已在下方更新`;
  if (view.status === "expired") return t`Expired`;
  if (view.status === "cancelled") return t`Ended`;
  if (view.status === "answered") {
    if (view.kind === "action_approval") {
      if (view.decision === "denied") return t`Denied`;
      if (view.approval.kind === "payment") return t`Payment approved`;
      if (view.approval.kind === "outbound") return t`Send approved`;
      if (view.approval.kind === "install") return t`Installed`;
      if (view.approval.kind === "skill_save") return t`Saved`;
      if (view.approval.kind === "connect.app_authorization") return t`Authorized`;
      if (view.approval.kind === "connect.mcp_assignment") return t`Allowed`;
      if (view.approval.kind === "group_membership") return t`Joined`;
      if (view.approval.kind === "routine") return t`Updated`;
      return t`Allowed`;
    }
    if (view.kind === "plan_review") return t`Plan approved`;
    if (view.kind === "input_request") {
      if (view.input.mode === "secret") return t`Saved`;
      if (view.input.mode === "saved_item") return t`Selected`;
      if (view.input.mode === "choice") return t`Selected`;
      if (view.input.mode === "form") return t`Submitted`;
      return t`Answered`;
    }
    return t`Answered`;
  }
  if (view.kind === "action_approval") {
    if (view.approval.kind === "payment") return t`Waiting for your payment decision`;
    if (view.approval.kind === "outbound") return t`Ready to send`;
    if (view.approval.kind === "install") return t`Waiting for your install decision`;
    if (view.approval.kind === "skill_save") return t`Waiting for your decision`;
    if (view.approval.kind === "connect.app_authorization")
      return t`Waiting for your authorization`;
    if (view.approval.kind === "connect.mcp_assignment") return t`Waiting for your decision`;
    if (view.approval.kind === "group_membership") return t`Waiting for your decision`;
    if (view.approval.kind === "routine") return t`Waiting for your decision`;
    return t`Waiting for your decision`;
  }
  if (view.kind === "plan_review") return t`Waiting for your review`;
  if (view.kind === "input_request") {
    if (view.input.mode === "secret") return t`Waiting for you`;
    if (view.input.mode === "saved_item") return t`Waiting for your choice`;
    if (view.input.mode === "choice") return t`Waiting for your choice`;
    if (view.input.mode === "form") return t`Waiting for you`;
    return t`Waiting for your answer`;
  }
  return t`Waiting for you`;
}

export function InteractionSourceLine({
  botName,
  conversationName,
  replyTarget,
  createdAt,
}: {
  botName?: string;
  conversationName?: string;
  replyTarget?: string | null;
  createdAt: string;
}) {
  const parts: string[] = [];
  if (botName) parts.push(t`Bot: ${botName}`);
  if (conversationName && conversationName !== botName) parts.push(conversationName);
  if (replyTarget) parts.push(replyTarget);
  const time = new Date(createdAt);
  if (!Number.isNaN(time.getTime())) {
    parts.push(
      time.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  }
  if (parts.length === 0) return null;
  return (
    <p
      data-testid="interaction-source"
      className="border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground"
      dir="auto"
    >
      {parts.join(" · ")}
    </p>
  );
}

export type InteractionActionKind = "primary" | "secondary" | "text" | "danger";

export function InteractionAction({
  children,
  kind = "secondary",
  disabled,
  loading,
  onClick,
  testId,
}: {
  children: ReactNode;
  kind?: InteractionActionKind;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  if (kind === "text") {
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        className="min-h-8 shrink-0 px-1 text-[13px] font-medium text-link underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(max-width:640px)]:min-h-11"
      >
        {children}
      </button>
    );
  }
  return (
    <Button
      type="button"
      data-testid={testId}
      variant={kind === "primary" ? "default" : kind === "danger" ? "destructive" : "outline"}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        "h-8 min-h-8 rounded-full px-3.5 text-[13px] font-medium [@media(max-width:640px)]:h-11 [@media(max-width:640px)]:min-h-11",
        kind === "secondary" && "bg-background",
      )}
    >
      {loading ? t`Sending…` : children}
    </Button>
  );
}

export function InteractionCardShell({
  kind,
  icon,
  title,
  status,
  tone,
  subtitle,
  children,
  source,
  actions,
  testId,
}: {
  kind: InteractionView["kind"];
  icon: Icon;
  title: ReactNode;
  status: string;
  tone: InteractionTone;
  subtitle?: ReactNode;
  children?: ReactNode;
  source?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  const terminal = tone !== "wait";
  const IconComponent = icon;
  return (
    <article
      data-testid={testId ?? "interaction-card"}
      data-kind={kind}
      data-tone={tone}
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 rounded-2xl p-3 text-foreground",
        terminal ? "bg-transparent shadow-[inset_0_0_0_1px_var(--border)]" : "bg-muted/70",
      )}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <header className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          className="grid size-[22px] shrink-0 place-items-center text-muted-foreground"
        >
          <IconComponent size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 text-[15px] font-medium leading-[22px]" dir="auto">
            {title}
          </h3>
          {subtitle ? (
            <div className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground" dir="auto">
              {subtitle}
            </div>
          ) : null}
        </div>
        <InteractionStatusBadge label={status} tone={tone} />
      </header>
      {children ? <div className="flex min-w-0 flex-col gap-2.5">{children}</div> : null}
      {source}
      {actions ? (
        <div
          data-testid="interaction-actions"
          className="flex flex-wrap items-center justify-end gap-2"
        >
          {actions}
        </div>
      ) : null}
    </article>
  );
}

export function InteractionKeyValue({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-[18px]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd
            className={cn("m-0 min-w-0 wrap-anywhere", row.mono && "font-mono text-[12px]")}
            dir="auto"
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function InteractionNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] leading-[17px] text-muted-foreground" dir="auto">
      {children}
    </p>
  );
}
