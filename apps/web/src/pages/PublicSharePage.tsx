import { useLingui } from "@lingui/react/macro";
import type { PublicShareView } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Clock, Link2, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { SandboxedHtmlViewer } from "../components/SandboxedHtmlViewer";
import { rpc } from "../lib/rpc";

type PageState =
  | { status: "loading" }
  | { status: "ready"; view: PublicShareView }
  | { status: "error" };

function DesensitizedCard({ name, state }: { name: string; state: "revoked" | "expired" }) {
  const { t } = useLingui();
  return (
    <div
      className="mt-1 w-full rounded-xl bg-muted p-3 text-left"
      data-testid="public-share-dead-card"
    >
      <div className="truncate text-[13.5px] leading-[18px] font-medium" dir="auto">
        {name}
      </div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">
        {state === "revoked" ? t`页面 · 只读 · 已撤销` : t`页面 · 只读 · 已过期`}
      </div>
    </div>
  );
}

export function PublicSharePage() {
  const { t } = useLingui();
  const { token } = useParams<{ token: string }>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ status: "ready", view: { state: "invalid" } });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.share
      .resolvePublic({ token })
      .then((view) => {
        if (!cancelled) setState({ status: "ready", view });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  if (state.status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6 text-[13.5px] text-muted-foreground">
        {t`正在打开页面…`}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6">
        <div className="w-full max-w-[400px] rounded-[18px] bg-card p-7 text-center text-foreground ring-1 ring-border">
          <h1 className="text-[17px] leading-6 font-medium">{t`无法打开此链接`}</h1>
          <p className="mt-2 text-[13.5px] leading-5 text-muted-foreground">
            {t`请检查网络后重试。`}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t`重试`}
          </Button>
        </div>
      </div>
    );
  }

  const view = state.view;

  if (view.state === "invalid") {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6">
        <div
          className="w-full max-w-[400px] rounded-[18px] bg-card p-7 text-center text-foreground ring-1 ring-border"
          data-testid="public-share-view"
          data-state="invalid"
        >
          <div className="mx-auto mb-3.5 grid size-11 place-items-center rounded-[14px] bg-destructive/10 text-destructive">
            <Link2 size={22} />
          </div>
          <h1 className="text-[17px] leading-6 font-medium">{t`链接已失效`}</h1>
          <p className="mt-2 text-[13.5px] leading-5 text-muted-foreground">
            {t`此分享链接无效或已被撤销，页面不可再访问。`}
          </p>
          <a
            href="/"
            className="mt-5 inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] text-link hover:underline"
          >
            {t`返回 WorkPal`}
          </a>
        </div>
      </div>
    );
  }

  if (view.state === "revoked" || view.state === "expired") {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6">
        <div
          className="w-full max-w-[400px] rounded-[18px] bg-card p-7 text-center text-foreground ring-1 ring-border"
          data-testid="public-share-view"
          data-state={view.state}
        >
          <div className="mx-auto mb-3.5 grid size-11 place-items-center rounded-[14px] bg-destructive/10 text-destructive">
            {view.state === "revoked" ? <Lock size={22} /> : <Clock size={22} />}
          </div>
          <h1 className="text-[17px] leading-6 font-medium">
            {view.state === "revoked" ? t`链接已失效` : t`链接已过期`}
          </h1>
          <p className="mt-2 text-[13.5px] leading-5 text-muted-foreground">
            {view.state === "revoked"
              ? t`所有者已撤销此公开分享。页面不可再访问。`
              : t`此公开链接已超过设定有效期，不可再访问。`}
          </p>
          <DesensitizedCard name={view.name} state={view.state} />
          <a
            href="/"
            className="mt-5 inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] text-link hover:underline"
          >
            {t`返回 WorkPal`}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-dvh flex-col bg-background text-foreground"
      data-testid="public-share-view"
      data-state="ok"
    >
      <header className="flex flex-none items-center gap-2 border-b border-border px-5 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Link2 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] leading-5 font-semibold" dir="auto">
            {view.name}
          </h1>
          <p className="text-[11.5px] leading-4 text-muted-foreground">
            {t`只读 · 有效期至`} {new Date(view.expiresAt).toLocaleDateString()}
          </p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {t`只读`}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden bg-white">
        <SandboxedHtmlViewer html={view.html} title={view.name} />
      </div>
    </div>
  );
}
