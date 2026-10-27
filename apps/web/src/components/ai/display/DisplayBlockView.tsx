import { t } from "@lingui/core/macro";
import { ChatMarkdown, type ExtractedTable, TableCard } from "@rakazo/chat-ui/web";
import type { DisplayBlock } from "@rakazo/contracts";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type ArtifactTarget, fetchArtifactBytes } from "../../../lib/artifact-open";
import { ArtifactImage, ChartBlockView } from "../../../pages/shell/message-cards";
import { ArtifactFileCard } from "../../ArtifactFileCard";
import { SandboxedHtmlViewer } from "../../SandboxedHtmlViewer";

function DisplayCard({
  kind,
  children,
  className,
}: {
  kind: DisplayBlock["kind"];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="display-block"
      data-kind={kind}
      className={cn(
        "w-full max-w-[360px] rounded-2xl border border-border bg-card p-3 text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function DisplayNote({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[12px] leading-4 text-muted-foreground">{children}</p>;
}

function MarkdownDisplay({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const report = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    report();
    // Viewport changes reflow the text without changing it, so the fold
    // decision must follow the rendered box, not just the text content.
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return (
    <DisplayCard kind="markdown">
      <div
        ref={body}
        data-testid="display-markdown"
        className="max-h-40 overflow-hidden text-[13px] leading-[18px]"
      >
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
      {overflowing ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-8 px-0 text-[12px]"
          onClick={() => setOpen(true)}
        >
          {t`Read full text`}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[88vh] w-[min(760px,94vw)] overflow-auto sm:max-w-[760px]"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-[15px]">{t`Full text`}</DialogTitle>
            <DialogClose
              aria-label={t`Close full text`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <div className="mt-3 text-[13px] leading-[18px]">
            <ChatMarkdown>{text}</ChatMarkdown>
          </div>
        </DialogContent>
      </Dialog>
    </DisplayCard>
  );
}

function tableModel(block: Extract<DisplayBlock, { kind: "table" }>): ExtractedTable {
  const columns = block.columns.map((column) => column.label);
  const rows = block.rows.map((row) => columns.map((_, index) => row[index] ?? ""));
  const numericColumns = new Set<number>();
  columns.forEach((_, index) => {
    if (
      rows.length > 0 &&
      rows.every((row) => row[index] !== "" && Number.isFinite(Number(row[index])))
    ) {
      numericColumns.add(index);
    }
  });
  return {
    columns,
    aligns: columns.map(() => null),
    rows,
    schemaKey: columns.join("\u0000"),
    dataSignature: JSON.stringify(rows),
    numericColumns,
    minWidths: Object.fromEntries(
      columns.map((column, index) => [
        index,
        `${Math.min(24, Math.max(6, column.length + 2, ...rows.map((row) => (row[index]?.length ?? 0) + 2)))}rem`,
      ]),
    ),
    rowKeys: new Map(rows.map((row) => [row, row.join("\u0000")])),
  };
}

function TableDisplay({ block }: { block: Extract<DisplayBlock, { kind: "table" }> }) {
  return (
    <div data-testid="display-block" data-kind="table" className="w-full max-w-[min(100%,560px)]">
      <TableCard table={tableModel(block)} />
    </div>
  );
}

function ChartDisplay({
  block,
  table,
}: {
  block: Extract<DisplayBlock, { kind: "chart" }>;
  table?: Extract<DisplayBlock, { kind: "table" }>;
}) {
  const spec =
    block.spec && typeof block.spec === "object" && !Array.isArray(block.spec)
      ? (block.spec as Record<string, unknown>)
      : null;
  if (!spec) {
    return (
      <DisplayCard kind="chart">
        <div className="text-[13px] font-medium">{block.name || t`Chart`}</div>
        <DisplayNote>{t`This chart data cannot be displayed.`}</DisplayNote>
      </DisplayCard>
    );
  }
  return (
    <div data-testid="display-block" data-kind="chart">
      <ChartBlockView
        name={block.name}
        spec={spec}
        data={block.data}
        dataTable={table ? <TableDisplay block={table} /> : undefined}
      />
    </div>
  );
}

function CollectionDisplay({ block }: { block: Extract<DisplayBlock, { kind: "collection" }> }) {
  return (
    <DisplayCard kind="collection">
      {block.title ? (
        <div className="text-[13px] font-medium" dir="auto">
          {block.title}
        </div>
      ) : null}
      <dl className="mt-1 divide-y divide-border">
        {block.items.map((item) => (
          <div key={item.id} className="flex min-w-0 items-start justify-between gap-3 py-1.5">
            <dt className="min-w-0 text-[12px] text-muted-foreground" dir="auto">
              {item.label}
            </dt>
            <dd className="min-w-0 text-end text-[13px] text-foreground" dir="auto">
              <span className="wrap-anywhere">{item.value}</span>
              {item.detail ? (
                <span className="block text-[12px] text-muted-foreground">{item.detail}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </DisplayCard>
  );
}

function MediaDisplay({
  block,
  target,
}: {
  block: Extract<DisplayBlock, { kind: "media" }>;
  target: ArtifactTarget;
}) {
  return (
    <div data-testid="display-block" data-kind="media">
      {block.mediaKind === "image" ? (
        <ArtifactImage target={target} artifactId={block.artifactId} name={block.name} />
      ) : (
        <ArtifactFileCard
          target={target}
          artifactId={block.artifactId}
          name={block.name}
          mimeType={block.mimeType}
          size={block.size ?? 0}
        />
      )}
    </div>
  );
}

function HtmlDisplay({
  block,
  target,
}: {
  block: Extract<DisplayBlock, { kind: "html" }>;
  target: ArtifactTarget;
}) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || html !== null) return;
    let cancelled = false;
    void fetchArtifactBytes(target, block.artifactId)
      .then((bytes) => {
        if (cancelled) return;
        setHtml(new TextDecoder().decode(bytes));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [block.artifactId, html, open, target]);
  return (
    <>
      <DisplayCard kind="html">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium" dir="auto">
              {block.title || t`Report`}
            </div>
            <DisplayNote>{t`Read-only report · isolated preview`}</DisplayNote>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t`Open report`}
          </Button>
        </div>
      </DisplayCard>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(88vh,900px)] w-[min(980px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <DialogTitle className="text-[15px]">{block.title || t`Report`}</DialogTitle>
            <DialogClose
              aria-label={t`Close report`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1">
            {html ? (
              <SandboxedHtmlViewer html={html} title={block.title || t`Report`} />
            ) : (
              <p className="p-6 text-[13px] text-muted-foreground">
                {error ? t`Could not load this report.` : t`Loading report…`}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskStatusDisplay({
  block,
  onOpenRun,
}: {
  block: Extract<DisplayBlock, { kind: "task_status" }>;
  onOpenRun?: (runId: string) => void;
}) {
  const label =
    block.status === "completed"
      ? t`Completed`
      : block.status === "failed"
        ? t`Failed`
        : block.status === "cancelled"
          ? t`Cancelled`
          : block.status === "running"
            ? t`Running`
            : t`Unknown`;
  return (
    <DisplayCard kind="task_status">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" dir="auto">
            {block.title}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">{label}</div>
        </div>
        {block.source.runId && onOpenRun ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenRun(block.source.runId!)}
          >
            {t`View run details`}
          </Button>
        ) : null}
      </div>
      {block.summary ? (
        <p className="mt-2 line-clamp-3 text-[12.5px] text-muted-foreground" dir="auto">
          {block.summary}
        </p>
      ) : null}
    </DisplayCard>
  );
}

function PageDisplay({ block }: { block: Extract<DisplayBlock, { kind: "page" }> }) {
  return (
    <DisplayCard kind="page">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" dir="auto">
            {block.title}
          </div>
          <DisplayNote>
            {block.available ? t`Document page` : t`This page is unavailable.`}
          </DisplayNote>
        </div>
        {block.available ? (
          <a
            href={`/app/artifacts/${encodeURIComponent(block.pageId)}`}
            className="inline-flex min-h-8 items-center rounded-full px-3 text-[12px] font-medium text-link hover:underline"
          >
            {t`Open page`}
          </a>
        ) : null}
      </div>
    </DisplayCard>
  );
}

function VoiceDisplay({
  block,
  target,
}: {
  block: Extract<DisplayBlock, { kind: "voice" }>;
  target: ArtifactTarget;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState(false);
  useEffect(() => {
    if (!block.artifactId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void fetchArtifactBytes(target, block.artifactId)
      .then((bytes) => {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setAudioUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setAudioError(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.artifactId, target]);
  const duration = `${Math.floor(block.durationMs / 60_000)}:${String(
    Math.floor((block.durationMs % 60_000) / 1_000),
  ).padStart(2, "0")}`;
  return (
    <DisplayCard kind="voice">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium">{t`Voice chat`}</div>
        <span className="font-mono text-[12px] text-muted-foreground">{duration}</span>
      </div>
      {audioUrl ? (
        <audio controls src={audioUrl} className="mt-2 w-full">
          <track kind="captions" />
        </audio>
      ) : (
        <DisplayNote>
          {audioError ? t`Could not load the recording.` : t`Audio is not recorded for this call.`}
        </DisplayNote>
      )}
      {block.transcript ? (
        <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[12.5px] leading-[18px] text-muted-foreground">
          {block.transcript}
        </p>
      ) : (
        <DisplayNote>{t`No transcript is available.`}</DisplayNote>
      )}
    </DisplayCard>
  );
}

export function DisplayBlockView({
  block,
  target,
  table,
  onOpenRun,
}: {
  block: DisplayBlock;
  target: ArtifactTarget;
  /** A chart's real data-table companion from the same message. */
  table?: Extract<DisplayBlock, { kind: "table" }>;
  onOpenRun?: (runId: string) => void;
}) {
  switch (block.kind) {
    case "markdown":
      return <MarkdownDisplay text={block.text} />;
    case "table":
      return <TableDisplay block={block} />;
    case "chart":
      return <ChartDisplay block={block} table={table} />;
    case "collection":
      return <CollectionDisplay block={block} />;
    case "media":
      return <MediaDisplay block={block} target={target} />;
    case "html":
      return <HtmlDisplay block={block} target={target} />;
    case "task_status":
      return <TaskStatusDisplay block={block} onOpenRun={onOpenRun} />;
    case "page":
      return <PageDisplay block={block} />;
    case "voice":
      return <VoiceDisplay block={block} target={target} />;
  }
}

export function DisplayBlockList({
  blocks,
  target,
  onOpenRun,
}: {
  blocks: readonly DisplayBlock[];
  target: ArtifactTarget;
  onOpenRun?: (runId: string) => void;
}) {
  const companions = new Map<string, Extract<DisplayBlock, { kind: "table" }>>();
  for (const block of blocks) {
    if (block.kind === "table" && block.blockId.endsWith(":table")) {
      companions.set(block.blockId.slice(0, -":table".length), block);
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="display-block-list">
      {blocks
        .filter((block) => !(block.kind === "table" && block.blockId.endsWith(":table")))
        .map((block) => (
          <DisplayBlockView
            key={block.blockId}
            block={block}
            target={target}
            table={block.kind === "chart" ? companions.get(block.blockId) : undefined}
            onOpenRun={onOpenRun}
          />
        ))}
    </div>
  );
}

/** Index of the source MessageBlock, or null for a group-level voice block. */
export function displayBlockMessageIndex(blockId: string, messageId: string): number | null {
  if (!blockId.startsWith(`${messageId}:`)) return null;
  const index = Number(blockId.slice(messageId.length + 1).split(":")[0]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** Group a server page's display blocks by their source message id. */
export function groupDisplayBlocksByMessage(
  blocks: readonly DisplayBlock[],
): Map<string, DisplayBlock[]> {
  const grouped = new Map<string, DisplayBlock[]>();
  for (const block of blocks) {
    const separator = block.blockId.indexOf(":");
    const messageId = separator === -1 ? block.blockId : block.blockId.slice(0, separator);
    const list = grouped.get(messageId) ?? [];
    list.push(block);
    grouped.set(messageId, list);
  }
  return grouped;
}
