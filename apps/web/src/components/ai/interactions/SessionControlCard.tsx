import { t } from "@lingui/core/macro";
import { Desktop } from "@phosphor-icons/react";
import type { SessionControlView } from "@rakazo/contracts";
import { useState } from "react";
import { rpc } from "../../../lib/rpc";
import {
  InteractionAction,
  InteractionCardShell,
  InteractionNote,
  InteractionSourceLine,
  interactionStatusLabel,
  interactionTone,
} from "./InteractionCardShell";

export function SessionControlCard({
  view,
  botName,
  conversationName,
  onOpenComputer,
  onRefresh,
}: {
  view: SessionControlView;
  botName?: string;
  conversationName?: string;
  onOpenComputer?: (botId: string) => void;
  onRefresh?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeover = view.action === "takeover";

  const returnControl = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.computer.release({ botId: view.botId, reason: "done" });
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not return control`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <InteractionCardShell
      kind="session_control"
      icon={Desktop}
      title={view.presentation.text || (takeover ? t`打开桌面` : t`交还桌面`)}
      status={takeover ? t`Waiting for takeover` : t`Waiting to hand back`}
      tone={interactionTone(view)}
      subtitle={
        takeover
          ? t`Open the desktop and complete this step. The Bot does not collect passwords or verification codes.`
          : t`Hand control back to the Bot when you are done. Closing this card does not hand control back.`
      }
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
        />
      }
      actions={
        takeover ? (
          <InteractionAction
            kind="primary"
            disabled={!onOpenComputer}
            onClick={() => onOpenComputer?.(view.botId)}
            testId="session-control-takeover"
          >
            {t`打开桌面`}
          </InteractionAction>
        ) : (
          <InteractionAction
            kind="primary"
            disabled={busy}
            loading={busy}
            onClick={() => void returnControl()}
            testId="session-control-return"
          >
            {t`交还桌面`}
          </InteractionAction>
        )
      }
    >
      {takeover ? (
        <InteractionNote>
          {t`Only this current Bot pauses. The desktop stays available for you until you hand it back.`}
        </InteractionNote>
      ) : (
        <InteractionNote>
          {interactionStatusLabel(view)}
          {view.controlLeaseExpiresAt
            ? t` · control ends ${new Date(view.controlLeaseExpiresAt).toLocaleTimeString()}`
            : ""}
        </InteractionNote>
      )}
      {!takeover ? null : (
        <InteractionNote>{t`Closing the desktop does not abandon or cancel the work.`}</InteractionNote>
      )}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}
