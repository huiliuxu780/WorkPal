import { useLingui } from "@lingui/react/macro";
import type { SpaceShareView } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import { TriangleAlert, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { ReadOnlyPageView } from "../components/share/ReadOnlyPageView";
import { rpc } from "../lib/rpc";

type PageState =
  | { status: "loading" }
  | { status: "ready"; view: SpaceShareView }
  | { status: "denied" }
  | { status: "error" };

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

/** Formal Space-link failure surfaces (F1 login, F2 wrong Space). */
function SpaceFailPage({ kind, nextPath }: { kind: "login" | "space"; nextPath: string }) {
  const { t } = useLingui();
  const login = kind === "login";
  const primaryHref = login ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/app";
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-6">
      <div
        className="w-full max-w-[400px] rounded-[18px] bg-card p-7 text-center text-foreground ring-1 ring-border"
        data-testid="space-share-fail"
        data-state={kind}
      >
        <div
          className={cn(
            "mx-auto mb-3.5 grid size-11 place-items-center rounded-[14px]",
            login ? "bg-link/10 text-link" : "bg-warning/10 text-warning",
          )}
        >
          {login ? <UserRound size={22} /> : <TriangleAlert size={22} />}
        </div>
        <h1 className="text-[17px] leading-6 font-medium">{login ? t`需要登录` : t`无法打开`}</h1>
        <p className="mt-2 text-[13.5px] leading-5 text-muted-foreground">
          {login
            ? t`此链接仅本 Space 成员可打开。请登录后再试。`
            : t`你不属于该 Space，无法打开此页面。请联系所有者将你加入后再试。`}
        </p>
        <div
          className="mt-4 rounded-xl bg-muted p-3 text-left text-[12px] text-muted-foreground"
          data-testid="space-share-fail-card"
        >
          {t`页面 · Space 内 · 无法打开`}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <a
            href={primaryHref}
            className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/80"
          >
            {login ? t`去登录` : t`返回`}
          </a>
          {login ? (
            <a
              href="/"
              className="inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-[13px] text-link hover:underline"
            >
              {t`返回`}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Login-scoped Space link: any member of the page's Space may read it. */
export function SpaceSharePage({ signedIn }: { signedIn: boolean }) {
  const { t } = useLingui();
  const location = useLocation();
  const { spaceId, familyId } = useParams<{ spaceId: string; familyId: string }>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PageState>({ status: "loading" });
  const nextPath = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (!signedIn) return;
    if (!spaceId || !familyId) {
      setState({ status: "denied" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.share
      .openSpace({ spaceId, artifactFamilyId: familyId })
      .then((view) => {
        if (!cancelled) setState({ status: "ready", view });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const code = errorCode(error);
        setState({ status: code === "NOT_FOUND" || code === "BAD_REQUEST" ? "denied" : "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, spaceId, familyId, attempt]);

  if (!signedIn) return <SpaceFailPage kind="login" nextPath={nextPath} />;

  if (state.status === "denied") {
    return <SpaceFailPage kind="space" nextPath={nextPath} />;
  }

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
            {t`网络异常，请检查后重试。`}
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

  return (
    <ReadOnlyPageView
      testId="space-share-view"
      name={state.view.name}
      meta={t`只读 · 仅本 Space`}
      html={state.view.html}
    />
  );
}
