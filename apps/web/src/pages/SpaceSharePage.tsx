import { useLingui } from "@lingui/react/macro";
import type { SpaceShareView } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ReadOnlyPageView } from "../components/share/ReadOnlyPageView";
import { rpc } from "../lib/rpc";

type PageState =
  | { status: "loading" }
  | { status: "ready"; view: SpaceShareView }
  | { status: "error" };

/** Login-scoped Space link: any member of the page's Space may read it. */
export function SpaceSharePage() {
  const { t } = useLingui();
  const { spaceId, familyId } = useParams<{ spaceId: string; familyId: string }>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    if (!spaceId || !familyId) {
      setState({ status: "error" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.share
      .openSpace({ spaceId, artifactFamilyId: familyId })
      .then((view) => {
        if (!cancelled) setState({ status: "ready", view });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, familyId, attempt]);

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
          <div className="mx-auto mb-3.5 grid size-11 place-items-center rounded-[14px] bg-destructive/10 text-destructive">
            <Link2 size={22} />
          </div>
          <h1 className="text-[17px] leading-6 font-medium">{t`无法打开此页`}</h1>
          <p className="mt-2 text-[13.5px] leading-5 text-muted-foreground">
            {t`请确认你已登录，并且属于此页面所在的 Space。`}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t`重试`}
            </Button>
            <a
              href="/"
              className="inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] text-link hover:underline"
            >
              {t`返回 WorkPal`}
            </a>
          </div>
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
