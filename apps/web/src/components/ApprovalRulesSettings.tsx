import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ActionApprovalRule } from "@rakazo/contracts";
import { Button, Input, Label, Switch } from "@rakazo/ui-web";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

type RuleEffect = ActionApprovalRule["effect"];

/**
 * User-facing action review settings over the existing authoritative stores
 * (`autoReview.*` + `approvalRules.*`). Rules are natural-language phrases;
 * the stored matchKind is "category" so legacy structured rules keep their
 * original matching scope and a phrase only ever narrows through the existing
 * action-review judge prompt — never a new matcher, never extra grants.
 */
function rulePhrase(rule: ActionApprovalRule): string {
  if (rule.matchKind === "category") {
    if (rule.matchValue === "email") return t`Sending email`;
    if (rule.matchValue === "purchase") return t`Making purchases`;
  }
  if (rule.matchKind === "connector") return t`Using ${rule.matchValue}`;
  return rule.matchValue;
}

function effectLabel(effect: RuleEffect): string {
  return effect === "require_approval" ? t`Ask me first` : t`Always allow`;
}

interface EditorState {
  mode: "add" | "edit";
  ruleId: string | null;
  phrase: string;
  effect: RuleEffect;
  error: string | null;
}

export function ApprovalRulesSettings() {
  const toggleId = useId();
  const [rules, setRules] = useState<ActionApprovalRule[]>([]);
  const [autoReview, setAutoReview] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextAutoReview] = await Promise.all([
        rpc.approvalRules.list(),
        rpc.autoReview.get(),
      ]);
      setRules(nextRules);
      setAutoReview(nextAutoReview.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not load action rules`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function toggleAutoReview(enabled: boolean) {
    if (loading || savingToggle) return;
    setSavingToggle(true);
    setError(null);
    try {
      const saved = await rpc.autoReview.set({ enabled });
      setAutoReview(saved.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save action review`);
    } finally {
      setSavingToggle(false);
    }
  }

  async function saveEditor() {
    if (!editor || savingRule) return;
    const phrase = editor.phrase.trim();
    if (!phrase) {
      setEditor({ ...editor, error: t`Describe the action in your own words` });
      return;
    }
    setSavingRule(true);
    setError(null);
    try {
      // Same phrase under the other effect is replaced, not duplicated.
      const conflicting = rules.find(
        (rule) =>
          rule.id !== editor.ruleId &&
          rule.matchKind === "category" &&
          rule.matchValue.toLowerCase() === phrase.toLowerCase(),
      );
      const saved = await rpc.approvalRules.set({
        effect: editor.effect,
        matchKind: "category",
        matchValue: phrase,
      });
      // The server set is a keyed upsert: an edit that changed the phrase or
      // the effect created a NEW row, so the edited rule — and any
      // opposite-effect twin of the phrase — must be removed server-side too,
      // or a refresh would resurrect them. Removes run only after a
      // successful set, so a failed save never destroys an existing rule.
      const stale = [editor.ruleId, conflicting?.id].filter(
        (id): id is string => Boolean(id) && id !== saved.id,
      );
      for (const id of stale) {
        await rpc.approvalRules.remove({ id });
      }
      const edited = editor.ruleId;
      setRules((current) => {
        const without = current.filter(
          (rule) => rule.id !== saved.id && rule.id !== edited && rule.id !== conflicting?.id,
        );
        return [...without, saved];
      });
      setEditor(null);
    } catch (err) {
      // Keep everything the user typed; the editor stays open.
      setEditor({
        ...editor,
        error: err instanceof Error ? err.message : t`Could not save this rule`,
      });
    } finally {
      setSavingRule(false);
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ id });
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not remove this rule`);
    }
  }

  return (
    <div data-testid="action-review-settings">
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Action review</Trans>
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        <Trans>Applies to all your Bots in this Space.</Trans>
      </p>
      <div className="mt-4 flex items-start gap-3">
        <Switch
          id={toggleId}
          data-testid="auto-review-toggle"
          className="mt-0.5"
          checked={autoReview ?? false}
          disabled={loading || savingToggle || autoReview === null}
          onCheckedChange={(checked) => void toggleAutoReview(checked)}
        />
        <Label htmlFor={toggleId} className="text-[14px] font-normal text-foreground/75">
          <Trans>Check actions against my rules before they run</Trans>
        </Label>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-muted-foreground">
          <Trans>Your rules</Trans>
        </span>
        {editor ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() =>
              setEditor({
                mode: "add",
                ruleId: null,
                phrase: "",
                effect: "require_approval",
                error: null,
              })
            }
          >
            <Plus size={14} />
            <Trans>Add rule</Trans>
          </Button>
        )}
      </div>

      {loading ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          <Trans>Loading rules…</Trans>
        </p>
      ) : rules.length === 0 && !editor ? (
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          <Trans>
            No rules yet. Actions follow each Bot&apos;s own approvals; add a rule to always
            be asked — or to always allow — something specific.
          </Trans>
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground/75" dir="auto">
                {rulePhrase(rule)}
              </span>
              <span
                className={`flex-none text-[12px] font-medium ${
                  rule.effect === "require_approval" ? "text-warning" : "text-success"
                }`}
              >
                {effectLabel(rule.effect)}
              </span>
              <span className="flex flex-none gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t`Edit`} · ${rulePhrase(rule)}`}
                  onClick={() =>
                    setEditor({
                      mode: "edit",
                      ruleId: rule.id,
                      phrase: rulePhrase(rule),
                      effect: rule.effect,
                      error: null,
                    })
                  }
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t`Delete`} · ${rulePhrase(rule)}`}
                  onClick={() => void removeRule(rule.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {editor ? (
        <div className="mt-3 rounded-lg border border-border bg-card p-3.5">
          <Label htmlFor={`${toggleId}-phrase`} className="text-[13px] text-muted-foreground">
            <Trans>What action?</Trans>
            <Input
              id={`${toggleId}-phrase`}
              className="mt-1.5"
              value={editor.phrase}
              placeholder={t`e.g. emailing someone outside the Space`}
              dir="auto"
              onChange={(event) =>
                setEditor({ ...editor, phrase: event.target.value, error: null })
              }
            />
          </Label>
          <div className="mt-3 flex gap-2" role="radiogroup" aria-label={t`What should happen?`}>
            {(["require_approval", "always_allow"] as const).map((effect) => (
              <Button
                key={effect}
                variant={editor.effect === effect ? "secondary" : "outline"}
                size="sm"
                role="radio"
                aria-checked={editor.effect === effect}
                onClick={() => setEditor({ ...editor, effect })}
              >
                {effectLabel(effect)}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            <Trans>
              Rules guide action review only — they never connect apps, widen resource
              access, or skip server-side protections.
            </Trans>
          </p>
          {editor.error ? (
            <p role="alert" className="mt-2 text-[12.5px] text-destructive">
              {editor.error}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditor(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" disabled={savingRule} onClick={() => void saveEditor()}>
              <Trans>Save rule</Trans>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
