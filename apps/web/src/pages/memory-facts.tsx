import { Trans, useLingui } from "@lingui/react/macro";
import type {
  MemoryFactDto,
  MemoryFactEvidenceDto,
  MemoryFactMutationResult,
} from "@rakazo/contracts";
import { Button, Skeleton, Textarea } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

/**
 * ME-01/ME-02 first-party memory facts in the existing Knowledge surfaces.
 * Remembered / pending-confirmation / expired sections with source, scope and
 * per-item correction, confirmation, rejection, deletion and sharing. The
 * "Remembered" receipt only appears after the transaction actually succeeded;
 * version conflicts reload and say so instead of silently overwriting.
 */

const rowClass = (open: boolean) =>
  `h-auto w-full justify-start whitespace-normal px-2.5 py-2.5 text-start ${open ? "bg-muted" : ""}`;

type Translate = ReturnType<typeof useLingui>["t"];

function scopeLabel(scopeKind: MemoryFactDto["scopeKind"], t: Translate): string {
  return scopeKind === "bot" ? t`this bot` : scopeKind === "space" ? t`space` : t`you`;
}

function originLabel(origin: MemoryFactDto["origin"], t: Translate): string {
  switch (origin) {
    case "user_direct":
      return t`you said`;
    case "user_confirmed":
      return t`you confirmed`;
    case "model_candidate":
      return t`auto-discovered`;
    case "legacy_import":
      return t`imported`;
  }
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso;
}

export function MemoryFactList({ botId, testId }: { botId?: string; testId: string }) {
  const { t } = useLingui();
  const [loading, setLoading] = useState(true);
  const [facts, setFacts] = useState<MemoryFactDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingShareId, setConfirmingShareId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<MemoryFactEvidenceDto[] | null>(null);
  const [newMemory, setNewMemory] = useState("");
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await rpc.memory.facts.list({
        ...(botId ? { botId } : {}),
        states: ["active", "candidate", "superseded"],
        includeExpired: true,
      });
      if (current !== generation.current) return;
      setFacts(result.facts);
      setLoading(false);
    } catch {
      if (current !== generation.current) return;
      setFacts([]);
      setLoading(false);
      setError(t`Could not load`);
    }
  }, [botId, t]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  async function mutate(
    action: () => Promise<MemoryFactMutationResult>,
    successNotice?: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result.status === "conflict") {
        // Two pages open: never overwrite; show the current version.
        setNotice(t`This memory changed elsewhere; showing the latest version.`);
        setOpenId(null);
        await reload();
        return false;
      }
      if (result.status === "invalid_state") {
        setNotice(t`This memory can no longer be changed that way.`);
        await reload();
        return false;
      }
      if (successNotice) setNotice(successNotice);
      setConfirmingDeleteId(null);
      setConfirmingShareId(null);
      setEvidence(null);
      await reload();
      return true;
    } catch {
      setError(t`Could not save`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addMemory() {
    const text = newMemory.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.memory.facts.create({
        scopeKind: botId ? "bot" : "user",
        ...(botId ? { botId } : {}),
        text,
      });
      // "Remembered" is only shown after the transaction really succeeded.
      if (result.status === "updated" || result.status === "replayed") {
        setNewMemory("");
        setNotice(t`Remembered`);
      } else if (result.status === "conflict") {
        setNotice(t`This memory changed elsewhere; showing the latest version.`);
      } else {
        setNotice(t`This memory can no longer be changed that way.`);
      }
      await reload();
    } catch {
      setError(t`Could not save`);
    } finally {
      setBusy(false);
    }
  }

  async function loadEvidence(factId: string) {
    if (busy) return;
    setBusy(true);
    try {
      setEvidence(await rpc.memory.factEvidence.list({ factId }));
    } catch {
      setEvidence([]);
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
  }

  const remembered = facts.filter((fact) => fact.state === "active" && !fact.expired);
  const pending = facts.filter((fact) => fact.state === "candidate");
  const expired = facts.filter(
    (fact) => (fact.state === "active" && fact.expired) || fact.state === "superseded",
  );

  const renderFact = (fact: MemoryFactDto) => (
    <div key={fact.id} data-testid={`${testId}-fact`}>
      <Button
        variant="ghost"
        type="button"
        disabled={busy}
        onClick={() => {
          if (openId === fact.id) {
            setOpenId(null);
            setEvidence(null);
            setConfirmingDeleteId(null);
            setConfirmingShareId(null);
          } else {
            setOpenId(fact.id);
            setDraft(fact.text);
            setEvidence(null);
            setConfirmingDeleteId(null);
            setConfirmingShareId(null);
            setError(null);
          }
        }}
        className={rowClass(openId === fact.id)}
      >
        <span className="flex w-full flex-col gap-0.5">
          <span className="min-w-0 text-[14px] text-foreground" dir="auto">
            {fact.text}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
            <span>{originLabel(fact.origin, t)}</span>
            <span aria-hidden>·</span>
            <span>
              <Trans>scope: {scopeLabel(fact.scopeKind, t)}</Trans>
            </span>
            <span aria-hidden>·</span>
            <span>{formatWhen(fact.updatedAt)}</span>
            {fact.state === "candidate" ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  <Trans>from {fact.evidenceThreadCount} conversations</Trans>
                </span>
              </>
            ) : null}
            {fact.expired && fact.state === "active" ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-destructive">
                  <Trans>expired</Trans>
                </span>
              </>
            ) : null}
            {fact.indexCleanupPending ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  <Trans>Cleaning up indexes…</Trans>
                </span>
              </>
            ) : null}
          </span>
        </span>
      </Button>
      {openId === fact.id ? (
        <div className="px-2.5 pb-2" data-testid={`${testId}-fact-editor`}>
          <Textarea
            aria-label={t`Memory text`}
            disabled={busy || fact.state === "superseded"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
            className="mt-2 w-full text-[13px] leading-relaxed"
            dir="auto"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {fact.state !== "superseded" ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || draft.trim() === fact.text || !draft.trim()}
                onClick={() =>
                  void mutate(
                    () =>
                      rpc.memory.facts.correct({
                        factId: fact.id,
                        expectedRevision: fact.revision,
                        text: draft.trim(),
                      }),
                    t`Correction saved`,
                  )
                }
                className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
              >
                <Trans>Save correction</Trans>
              </Button>
            ) : null}
            {fact.state === "candidate" ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () =>
                        rpc.memory.facts.confirm({
                          factId: fact.id,
                          expectedRevision: fact.revision,
                        }),
                      t`Remembered`,
                    )
                  }
                  className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground"
                >
                  <Trans>Confirm</Trans>
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      rpc.memory.facts.reject({
                        factId: fact.id,
                        expectedRevision: fact.revision,
                      }),
                    )
                  }
                  className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
                >
                  <Trans>Reject</Trans>
                </Button>
              </>
            ) : null}
            {fact.state === "active" && fact.scopeKind !== "space" ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirmingShareId !== fact.id) {
                    setConfirmingShareId(fact.id);
                    return;
                  }
                  void mutate(
                    () =>
                      rpc.memory.facts.promote({
                        factId: fact.id,
                        expectedRevision: fact.revision,
                      }),
                    t`Shared with the space`,
                  );
                }}
                className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
              >
                {confirmingShareId === fact.id ? <Trans>Confirm share</Trans> : <Trans>Share with space</Trans>}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => void loadEvidence(fact.id)}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              <Trans>Sources</Trans>
            </Button>
            {fact.state !== "superseded" ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirmingDeleteId !== fact.id) {
                    setConfirmingDeleteId(fact.id);
                    return;
                  }
                  void mutate(() =>
                    rpc.memory.facts.delete({
                      factId: fact.id,
                      expectedRevision: fact.revision,
                    }),
                  );
                }}
                className={`ms-auto rounded-lg px-3 py-1.5 text-[13px] ${
                  confirmingDeleteId === fact.id
                    ? "bg-destructive/10 text-destructive"
                    : "text-destructive"
                }`}
              >
                {confirmingDeleteId === fact.id ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
              </Button>
            ) : null}
          </div>
          {evidence !== null && openId === fact.id ? (
            <div className="mt-2 rounded-lg bg-muted/50 px-3 py-2" data-testid={`${testId}-evidence`}>
              {evidence.length === 0 ? (
                <div className="text-[12.5px] text-muted-foreground">
                  <Trans>No sources recorded</Trans>
                </div>
              ) : (
                evidence.map((item) => (
                  <div key={item.id} className="text-[12.5px] text-muted-foreground">
                    {/* Catalog values are data, not translatable copy. */}
                    {item.evidenceType}
                    {" · "}
                    {item.originKind}
                    {" · "}
                    {formatWhen(item.capturedAt)}
                    {item.accessible ? null : (
                      <>
                        {" · "}
                        <Trans>source no longer accessible</Trans>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const section = (title: React.ReactNode, entries: MemoryFactDto[], key: string) =>
    entries.length > 0 ? (
      <div className="mb-3" data-testid={`${testId}-${key}`}>
        <div className="mb-1 px-2.5 text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </div>
        {entries.map(renderFact)}
      </div>
    ) : null;

  return (
    <div data-testid={testId}>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {notice ? (
        <div className="px-2.5 pb-2 text-[13px] text-muted-foreground" role="status">
          {notice}
        </div>
      ) : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && facts.length === 0 && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground">
          <Trans>Nothing remembered yet</Trans>
        </div>
      ) : null}
      {!loading ? (
        <>
          {section(<Trans>Remembered</Trans>, remembered, "remembered")}
          {section(<Trans>Pending confirmation</Trans>, pending, "pending")}
          {section(<Trans>Expired</Trans>, expired, "expired")}
        </>
      ) : null}
      {!loading ? (
        <div className="px-2.5 pb-1 pt-1">
          <Textarea
            aria-label={t`Add a memory`}
            disabled={busy}
            value={newMemory}
            onChange={(event) => setNewMemory(event.target.value)}
            rows={2}
            placeholder={t`Something worth remembering…`}
            className="w-full text-[13px] leading-relaxed"
            dir="auto"
          />
          <Button
            variant="ghost"
            type="button"
            disabled={busy || !newMemory.trim()}
            onClick={() => void addMemory()}
            className="mt-1.5 rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
          >
            <Trans>Remember</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
