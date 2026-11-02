import { useLingui } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";

export type ConnectionState = "connected" | "pending" | "failed";

/** Dot + wording in one static pill; colour never carries the state alone. */
export function ConnectionStatus({
  state,
  accountCount,
  className,
}: {
  state: ConnectionState;
  accountCount?: number;
  className?: string;
}) {
  const { t } = useLingui();
  const label =
    state === "connected"
      ? accountCount && accountCount > 0
        ? accountCount === 1
          ? t`Connected · 1 account`
          : t`Connected · ${accountCount} accounts`
        : t`Connected`
      : state === "pending"
        ? t`Waiting for authorization`
        : t`Connection failed`;
  return (
    <span
      data-testid="connection-status"
      data-state={state}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-[12px] font-medium",
        state === "connected"
          ? "text-success"
          : state === "pending"
            ? "text-muted-foreground"
            : "text-destructive",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          state === "connected"
            ? "bg-success"
            : state === "pending"
              ? "bg-warning"
              : "bg-destructive",
        )}
      />
      {label}
    </span>
  );
}
