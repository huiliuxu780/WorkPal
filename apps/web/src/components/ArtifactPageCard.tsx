import { useLingui } from "@lingui/react/macro";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Download, X } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import {
  downloadArtifactBytes,
  fetchLatestArtifact,
  type LatestArtifact,
} from "../lib/artifact-open";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

type ArtifactPageCardProps = {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  superseded?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type PageState =
  | { status: "loading" }
  | { status: "ready"; artifact: LatestArtifact; html: string }
  | { status: "error"; message: string };

function PageArtifactIcon() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
      <rect
        x="1.5"
        y="1"
        width="13"
        height="14"
        rx="2"
        className="fill-card stroke-border"
        strokeWidth="1"
      />
      <path
        d="M4 4.5h8M4 7h8M4 9.5h5"
        className="stroke-muted-foreground"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.45"
      />
      <rect x="4" y="11.2" width="2.2" height="2.6" rx=".4" className="fill-success" />
      <rect x="7" y="10.2" width="2.2" height="3.6" rx=".4" className="fill-warning" />
      <rect x="10" y="9" width="2.2" height="4.8" rx=".4" className="fill-link" />
    </svg>
  );
}

export function ArtifactPageCard(props: ArtifactPageCardProps) {
  const { t } = useLingui();
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const onOpenChangeRef = useRef(props.onOpenChange);
  onOpenChangeRef.current = props.onOpenChange;

  useEffect(() => () => onOpenChangeRef.current?.(false), []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    props.onOpenChange?.(next);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="artifact-page-card"
        data-stale={props.superseded ? "true" : undefined}
        aria-label={
          props.superseded ? t`Open updated page ${props.name}` : t`Open page ${props.name}`
        }
        onClick={() => handleOpenChange(true)}
        className={cn(
          "group/page-card flex w-full items-start gap-3 rounded-[14px] border border-border bg-card px-4 py-3.5 text-left text-foreground transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
          props.superseded && "opacity-95",
        )}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <PageArtifactIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[14.5px] leading-5 font-semibold",
              props.superseded && "text-muted-foreground",
            )}
            dir="auto"
          >
            {props.name}
          </span>
          <span
            className={cn(
              "mt-1 block text-[12.5px] leading-4 text-muted-foreground",
              props.superseded && "underline underline-offset-2",
            )}
          >
            {props.superseded ? t`已在下方更新` : t`页面`}
          </span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={trigger}
          className="flex h-[calc(100dvh-40px)] w-[min(1100px,calc(100vw-40px))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 text-foreground sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
        >
          <PageDialogBody
            target={props.target}
            artifactId={props.artifactId}
            fallbackName={props.name}
            open={open}
            closeButton={closeButton}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PageDialogBody({
  target,
  artifactId,
  fallbackName,
  open,
  closeButton,
}: {
  target: ArtifactTarget;
  artifactId: string;
  fallbackName: string;
  open: boolean;
  closeButton: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "botId" in target ? undefined : target.groupId;
  const stableTarget = useMemo<ArtifactTarget>(
    () => (targetBotId ? { botId: targetBotId } : { groupId: targetGroupId! }),
    [targetBotId, targetGroupId],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    setDownloadError(null);
    void fetchLatestArtifact(stableTarget, artifactId)
      .then((artifact) => {
        if (cancelled) return;
        if (artifact.mimeType !== "text/html") {
          setState({ status: "error", message: t`This page is not available.` });
          return;
        }
        try {
          const html = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
          setState({ status: "ready", artifact, html });
        } catch {
          setState({ status: "error", message: t`This page is not valid UTF-8 text.` });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : t`Could not load this page.`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt, artifactId, stableTarget, t]);

  async function downloadLatest() {
    setDownloadError(null);
    try {
      if (state.status === "ready") {
        downloadArtifactBytes(state.artifact.name, state.artifact.mimeType, state.artifact.bytes);
        return;
      }
      const artifact = await fetchLatestArtifact(stableTarget, artifactId);
      downloadArtifactBytes(artifact.name, artifact.mimeType, artifact.bytes);
    } catch {
      setDownloadError(t`Could not download this page. Try again.`);
    }
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-5">
        <DialogTitle className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-foreground">
          {state.status === "ready" ? state.artifact.name : fallbackName}
        </DialogTitle>
        <Button
          variant="ghost"
          size="icon-lg"
          className="rounded-full text-muted-foreground"
          aria-label={t`Download page`}
          title={t`Download page`}
          onClick={() => void downloadLatest()}
        >
          <Download />
        </Button>
        <DialogClose
          ref={closeButton}
          aria-label={t`Close page`}
          render={
            <Button variant="ghost" size="icon-lg" className="rounded-full text-muted-foreground" />
          }
        >
          <X />
        </DialogClose>
      </header>
      {downloadError ? (
        <div role="alert" className="shrink-0 px-5 pt-3 text-[13px] text-destructive">
          {downloadError}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <p className="p-8 text-[14px] text-muted-foreground" aria-live="polite">
            {t`Loading page…`}
          </p>
        ) : state.status === "error" ? (
          <div
            role="alert"
            className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
          >
            <p>{state.message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t`Try again`}
            </Button>
          </div>
        ) : (
          <SandboxedHtmlViewer html={state.html} title={state.artifact.name} />
        )}
      </div>
    </>
  );
}
