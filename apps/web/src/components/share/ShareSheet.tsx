import { useLingui } from "@lingui/react/macro";
import type { ShareExpiry, ShareLink } from "@rakazo/contracts";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Check, Copy, ExternalLink, Globe, Link2, Lock, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";

type Step = "space" | "confirm" | "expiry" | "done";
type Preset = ShareExpiry["preset"];

const CUSTOM_DAYS_MIN = 1;
const CUSTOM_DAYS_MAX = 90;

const URL_BOX_CLASS =
  "flex h-[34px] min-w-0 flex-1 items-center overflow-hidden rounded-[10px] bg-muted px-[11px] text-[12.5px] whitespace-nowrap text-muted-foreground ring-1 ring-border ring-inset";
const NOTE_CLASS = "text-[12px] leading-[18px] text-muted-foreground";
const SECTION_TITLE_CLASS =
  "flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground";

function customDaysFromInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isInteger(days) && days >= CUSTOM_DAYS_MIN && days <= CUSTOM_DAYS_MAX ? days : null;
}

export function ShareSheet({
  target,
  artifactId,
  name,
  open,
  onOpenChange,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<Step>("space");
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [existing, setExisting] = useState<ShareLink | null>(null);
  const [generated, setGenerated] = useState<ShareLink | null>(null);
  const [preset, setPreset] = useState<Preset>("7d");
  const [customDaysInput, setCustomDaysInput] = useState("14");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"space" | "public" | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep("space");
    setFamilyId(null);
    setExisting(null);
    setGenerated(null);
    setPreset("7d");
    setCustomDaysInput("14");
    setError(null);
    setNotice(null);
    setCopied(null);
    setLoading(true);
    void rpc.share
      .get({ ...target, artifactId })
      .then((overview) => {
        if (cancelled) return;
        setFamilyId(overview.familyId);
        setExisting(overview.publicLink);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t`无法加载此页面的分享信息，请重试。`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, artifactId, t]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const customDays = customDaysFromInput(customDaysInput);
  const customInvalid = preset === "custom" && customDays === null;
  const spaceUrl = familyId
    ? `${window.location.origin}/app/artifacts/${encodeURIComponent(familyId)}`
    : null;
  const shownLink = generated ?? existing;
  const shownPublicUrl = shownLink
    ? `${window.location.origin}/p/${encodeURIComponent(shownLink.token)}`
    : null;

  async function copy(text: string, which: "space" | "public") {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1_800);
    } catch {
      setError(t`复制失败，请重试。`);
    }
  }

  async function generate() {
    if (busy || loading) return;
    if (preset === "custom" && customDays === null) return;
    setBusy(true);
    setError(null);
    try {
      const link = await rpc.share.createPublic({
        ...target,
        artifactId,
        expiry: preset === "custom" ? { preset, customDays: customDays! } : { preset },
      });
      setGenerated(link);
      setExisting(link);
      setStep("done");
    } catch {
      setError(t`公开链接生成失败，请重试。`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.share.revoke({ ...target, artifactId });
      setGenerated(null);
      setExisting(null);
      setNotice(t`公开链接已撤销。`);
      setStep("space");
    } catch {
      setError(t`撤销失败，请重试。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        initialFocus={closeButton}
        className="flex max-h-[min(86vh,720px)] w-[min(440px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden rounded-[18px] p-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[88vh] max-sm:w-screen max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-[18px]"
        data-testid="share-sheet"
      >
        <header className="flex flex-none items-center gap-2 px-4 pt-3.5 pb-2.5">
          <DialogTitle className="min-w-0 flex-1 text-[15px] leading-5 font-medium">
            {step === "confirm"
              ? t`确认公开分享`
              : step === "expiry"
                ? t`选择过期时间`
                : step === "done"
                  ? t`公开链接已生成`
                  : t`分享页面`}
          </DialogTitle>
          <DialogClose
            ref={closeButton}
            aria-label={t`Close share`}
            render={
              <Button variant="ghost" size="icon-sm" className="rounded-lg text-muted-foreground" />
            }
          >
            <X size={14} />
          </DialogClose>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <div className="flex items-center gap-2.5 rounded-xl bg-muted p-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-muted-foreground ring-1 ring-border">
              <Link2 size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] leading-[18px] font-medium" dir="auto">
                {name}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {t`页面交付物 · 只读 · 不含审批/付款`}
              </div>
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-[12px] leading-[18px] text-destructive">
              {error}
            </p>
          ) : null}

          {step === "space" ? (
            <>
              {notice ? (
                <p role="status" className="text-[12px] leading-[18px] text-success">
                  {notice}
                </p>
              ) : null}
              <section className="flex flex-col gap-2">
                <div className={SECTION_TITLE_CLASS}>
                  <Lock size={13} />
                  <span>{t`Space 内链接`}</span>
                  <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                    {t`须登录 · 属本 Space`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className={URL_BOX_CLASS}
                    data-testid="share-space-link"
                    title={spaceUrl ?? undefined}
                  >
                    {spaceUrl ?? t`Loading…`}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!spaceUrl}
                    data-testid="share-copy-space"
                    onClick={() => spaceUrl && void copy(spaceUrl, "space")}
                  >
                    {copied === "space" ? <Check size={14} /> : <Copy size={14} />}
                    {copied === "space" ? t`已复制` : t`复制`}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!spaceUrl}
                    onClick={() => {
                      if (spaceUrl) window.open(spaceUrl, "_blank", "noopener,noreferrer");
                    }}
                  >
                    <ExternalLink size={14} />
                    {t`打开`}
                  </Button>
                </div>
                <p className={NOTE_CLASS}>{t`对方须已登录且属于本 Space，才能打开。`}</p>
              </section>

              <div className="h-px bg-border" />

              <button
                type="button"
                data-testid="share-public-entry"
                disabled={loading}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setStep("confirm");
                }}
                className="flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left ring-1 ring-border transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13.5px] leading-[18px] font-medium">
                    <Globe size={14} />
                    {t`公开分享`}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {t`生成可匿名打开的只读链接 · 须设过期 · 可随时撤销`}
                  </span>
                </span>
                <span aria-hidden="true" className="flex-none text-muted-foreground">
                  ›
                </span>
              </button>

              {existing ? (
                <p className={NOTE_CLASS} data-testid="share-existing">
                  {t`已有公开链 · 到期`} {new Date(existing.expiresAt).toLocaleDateString()} ·{" "}
                  <button
                    type="button"
                    data-testid="share-manage"
                    className="text-link underline-offset-2 hover:underline"
                    onClick={() => {
                      setGenerated(existing);
                      setError(null);
                      setNotice(null);
                      setStep("done");
                    }}
                  >
                    {t`管理`}
                  </button>
                </p>
              ) : (
                <p className={NOTE_CLASS}>{t`公开分享默认关闭。不会顺手勾选打开。`}</p>
              )}
            </>
          ) : null}

          {step === "confirm" ? (
            <>
              <div className="flex flex-col gap-2.5 rounded-[14px] bg-muted p-3.5">
                <p className="text-[14px] leading-5 font-medium">
                  {t`将生成任何人可打开的只读链接`}
                </p>
                <ul className="list-disc space-y-1 pl-[18px] text-[12.5px] leading-5 text-muted-foreground">
                  <li>{t`只读已发布页面内容，不含审批、付款或写权限`}</li>
                  <li>{t`必须设定过期时间（最长 90 天），禁止永不过期`}</li>
                  <li>{t`你可以随时撤销；撤销后旧链立即失效`}</li>
                  <li>{t`分享卡/通知只显示标题与类型，不带正文全文、金额、卡号、地址、验证码或密码`}</li>
                </ul>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="share-confirm-cancel"
                  onClick={() => setStep("space")}
                >
                  {t`取消`}
                </Button>
                <Button size="sm" data-testid="share-confirm" onClick={() => setStep("expiry")}>
                  {t`我确认公开`}
                </Button>
              </div>
              <p className={NOTE_CLASS}>{t`此步为独立确认，不是默认勾选。`}</p>
            </>
          ) : null}

          {step === "expiry" ? (
            <>
              <section className="flex flex-col gap-2">
                <div className={SECTION_TITLE_CLASS}>
                  <span>{t`公开链过期档位`}</span>
                  <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                    {t`必选`}
                  </span>
                </div>
                <fieldset
                  data-testid="share-expiry-chips"
                  className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
                >
                  <legend className="sr-only">{t`过期档位`}</legend>
                  {(
                    [
                      ["24h", t`24 小时`],
                      ["7d", t`7 天`],
                      ["30d", t`30 天`],
                      ["custom", t`自定义`],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={preset === value}
                      onClick={() => setPreset(value)}
                      className={cn(
                        "h-[30px] rounded-full px-3 text-[12.5px] font-medium transition-colors",
                        preset === value
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </fieldset>
                {preset === "custom" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min={CUSTOM_DAYS_MIN}
                      max={CUSTOM_DAYS_MAX}
                      value={customDaysInput}
                      data-testid="share-custom-days"
                      aria-label={t`自定义天数`}
                      onChange={(event) => setCustomDaysInput(event.target.value)}
                      className="h-8 w-[72px] rounded-[10px] bg-muted px-2.5 text-[13px] text-foreground ring-1 ring-border ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <span className="text-[12.5px] text-muted-foreground">{t`天（1–90）`}</span>
                  </div>
                ) : null}
                <p
                  className={cn(NOTE_CLASS, customInvalid && "text-destructive")}
                  data-testid="share-expiry-note"
                >
                  {customInvalid
                    ? t`自定义上限为 90 天。请改到 1–90。`
                    : preset === "custom"
                      ? t`自定义不得超过 90 天。无「永不过期」选项。`
                      : t`必须设过期。UI 不提供「永不过期」。`}
                </p>
              </section>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep("confirm")}
                  disabled={busy}
                >
                  {t`上一步`}
                </Button>
                <Button
                  size="sm"
                  data-testid="share-generate"
                  disabled={busy || loading || customInvalid}
                  onClick={() => void generate()}
                >
                  {t`生成公开链接`}
                </Button>
              </div>
            </>
          ) : null}

          {step === "done" && shownLink ? (
            <>
              <section className="flex flex-col gap-2">
                <div className={SECTION_TITLE_CLASS}>
                  <span>{t`公开只读链接`}</span>
                  <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                    {new Date(shownLink.expiresAt).toLocaleDateString()} {t`后失效`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className={URL_BOX_CLASS}
                    data-testid="share-public-link"
                    title={shownPublicUrl ?? undefined}
                  >
                    {shownPublicUrl}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="share-copy-public"
                    onClick={() => shownPublicUrl && void copy(shownPublicUrl, "public")}
                  >
                    {copied === "public" ? <Check size={14} /> : <Copy size={14} />}
                    {copied === "public" ? t`已复制` : t`复制`}
                  </Button>
                </div>
                <p className={NOTE_CLASS}>{t`已脱敏：分享提示仅含标题与「页面 · 只读」。`}</p>
              </section>
              <div className="h-px bg-border" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  data-testid="share-revoke"
                  disabled={busy}
                  onClick={() => void revoke()}
                >
                  {t`撤销链接`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setGenerated(null);
                    setStep("space");
                  }}
                >
                  {t`完成`}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Standalone trigger button used by page surfaces; keeps sheet state local. */
export function ShareSheetButton({
  target,
  artifactId,
  name,
  className,
  label,
  children,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        data-testid="page-share-trigger"
        className={className}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <ShareSheet
        target={target}
        artifactId={artifactId}
        name={name}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
