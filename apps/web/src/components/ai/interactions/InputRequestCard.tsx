import { t } from "@lingui/core/macro";
import type { Icon } from "@phosphor-icons/react";
import { CreditCard, Key, ListChecks, Question, Rows } from "@phosphor-icons/react";
import type { InputRequestView } from "@rakazo/contracts";
import { Input, Label, Textarea } from "@rakazo/ui-web";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { availableAskDraftStorage, readAskDraft, writeAskDraft } from "../../../lib/ask-draft";
import { rpc } from "../../../lib/rpc";
import {
  InteractionAction,
  InteractionCardShell,
  InteractionNote,
  InteractionSourceLine,
  interactionStatusLabel,
  interactionTone,
} from "./InteractionCardShell";

const ICONS: Record<InputRequestView["input"]["mode"], Icon> = {
  question: Question,
  choice: ListChecks,
  form: Rows,
  secret: Key,
  saved_item: CreditCard,
};

function secretFieldLabel(purpose: "otp" | "password" | "api_key" | null): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

export function InputRequestCard({
  view,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: InputRequestView;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const input = view.input;
  const terminal = view.status !== "pending";
  const draftEnabled = input.mode === "question" && !terminal;
  const draftStorage = useRef(availableAskDraftStorage());
  const initialDraft = useRef(
    draftEnabled ? readAskDraft(draftStorage.current, view.interactionId, false) : "",
  );
  const submissionId = useRef(crypto.randomUUID());
  const [text, setText] = useState(initialDraft.current);
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Free-text questions keep an unsent answer across conversation switches,
  // keyed like the legacy AskCard. Secret values never touch storage.
  useEffect(() => {
    if (input.mode !== "question") return;
    writeAskDraft(
      draftStorage.current,
      view.interactionId,
      draftEnabled && !submitted ? text : "",
      false,
    );
  }, [draftEnabled, input.mode, submitted, text, view.interactionId]);

  const submit = async (answer: string, usernameValue?: string) => {
    if (busy || terminal) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.threads.resolveIntervention({
        ...target,
        interventionId: view.interactionId,
        clientSubmissionId: submissionId.current,
        answer,
        ...(usernameValue ? { username: usernameValue } : {}),
      });
      setSubmitted(true);
      if (input.mode === "question") setText("");
      setSecret("");
      setUsername("");
      if (result.outcome === "already_handled") setError(t`This request was already handled.`);
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not submit this answer`);
    } finally {
      setBusy(false);
    }
  };

  const submitForm = () => {
    if (input.mode !== "form") return;
    const errors: Record<string, string> = {};
    for (const field of input.fields) {
      const value = formValues[field.id]?.trim() ?? "";
      if (field.required && !value) errors[field.id] = t`Fill in this field`;
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void submit(JSON.stringify(formValues));
  };

  const secretMode = input.mode === "secret";
  const loginMode = secretMode && input.credential?.authType === "login";
  const title =
    input.mode === "secret" && input.credential
      ? t`Connect ${input.credential.name}`
      : input.prompt.trim() || t`A request is waiting for you`;

  return (
    <InteractionCardShell
      kind="input_request"
      icon={ICONS[input.mode]}
      title={title}
      status={interactionStatusLabel(view)}
      tone={interactionTone(view)}
      subtitle={
        secretMode
          ? input.credential
            ? t`${input.credential.origin} · ${secretFieldLabel(input.purpose)}`
            : secretFieldLabel(input.purpose)
          : undefined
      }
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
        />
      }
      actions={
        terminal ? undefined : input.mode === "question" ? (
          <InteractionAction
            kind="primary"
            disabled={!text.trim()}
            loading={busy}
            onClick={() => void submit(text.trim())}
            testId="input-card-submit"
          >
            {t`Submit answer`}
          </InteractionAction>
        ) : input.mode === "form" ? (
          <InteractionAction
            kind="primary"
            loading={busy}
            onClick={submitForm}
            testId="input-card-submit"
          >
            {t`Submit`}
          </InteractionAction>
        ) : input.mode === "choice" ? (
          <InteractionAction
            kind="primary"
            disabled={!choice}
            loading={busy}
            onClick={() => choice && void submit(choice)}
            testId="input-card-submit"
          >
            {t`Submit choice`}
          </InteractionAction>
        ) : input.mode === "saved_item" ? (
          <InteractionAction
            kind="primary"
            disabled={!choice}
            loading={busy}
            onClick={() => choice && void submit(choice)}
            testId="input-card-submit"
          >
            {t`Confirm selection`}
          </InteractionAction>
        ) : (
          <InteractionAction
            kind="primary"
            disabled={!secret || (loginMode && !username.trim())}
            loading={busy}
            onClick={() => void submit(secret, loginMode ? username.trim() : undefined)}
            testId="input-card-submit"
          >
            {t`Save securely`}
          </InteractionAction>
        )
      }
    >
      {input.mode !== "secret" && view.presentation.detail ? (
        <pre
          dir="auto"
          data-testid="input-card-detail"
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground"
        >
          {view.presentation.detail}
        </pre>
      ) : null}
      {secretMode && (view.status === "answered" || submitted) ? (
        <div
          data-testid="secret-masked"
          aria-hidden="true"
          className="font-mono text-[15px] tracking-[0.35em] text-muted-foreground"
        >
          ••••
        </div>
      ) : null}
      {terminal || submitted ? (
        <InteractionNote>
          {submitted ? t`Submitted. Syncing the current state…` : interactionStatusLabel(view)}
        </InteractionNote>
      ) : input.mode === "question" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(text.trim());
          }}
        >
          <Textarea
            aria-label={t`Your answer`}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            placeholder={input.placeholder ?? t`Type your answer`}
            rows={3}
            className="max-h-48"
          />
          {initialDraft.current && !submitted ? (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-testid="input-card-draft-restored"
            >
              {t`Restored your unsent answer`}
            </p>
          ) : null}
        </form>
      ) : input.mode === "choice" ? (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={input.prompt}>
          {input.options.map((option) => (
            <label
              key={option.id}
              className={`flex min-h-8 items-center gap-2 rounded-xl bg-background px-2.5 py-2 text-[13px] shadow-[inset_0_0_0_1px_var(--border)] ${
                choice === option.id ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : ""
              }`}
            >
              <input
                type="radio"
                name={`input-choice-${view.interactionId}`}
                value={option.id}
                checked={choice === option.id}
                disabled={busy}
                onChange={() => setChoice(option.id)}
                className="accent-foreground"
              />
              <span className="min-w-0 wrap-anywhere" dir="auto">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      ) : input.mode === "form" ? (
        <div className="flex flex-col gap-2">
          {input.fields.map((field) => {
            const id = `input-field-${view.interactionId}-${field.id}`;
            return (
              <div key={field.id} className="flex flex-col gap-1">
                <Label htmlFor={id} className="text-[12px] font-normal text-muted-foreground">
                  {field.label}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </Label>
                <Input
                  id={id}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={Boolean(formErrors[field.id])}
                  value={formValues[field.id] ?? ""}
                  onChange={(event) => {
                    setFormValues((current) => ({ ...current, [field.id]: event.target.value }));
                    setFormErrors((current) => {
                      if (!current[field.id]) return current;
                      const next = { ...current };
                      delete next[field.id];
                      return next;
                    });
                  }}
                />
                {formErrors[field.id] ? (
                  <p role="alert" className="text-[12px] text-destructive">
                    {formErrors[field.id]}
                  </p>
                ) : null}
              </div>
            );
          })}
          <InteractionNote>{t`Sensitive payment details and credentials never belong in a form.`}</InteractionNote>
        </div>
      ) : input.mode === "secret" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void submit(secret, loginMode ? username.trim() : undefined);
          }}
        >
          {loginMode ? (
            <Input
              aria-label={t`Username`}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t`Username`}
            />
          ) : null}
          <Input
            aria-label={secretFieldLabel(input.purpose)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={secretFieldLabel(input.purpose)}
          />
          <InteractionNote>{t`The value stays out of messages and logs.`}</InteractionNote>
        </form>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={input.prompt}>
          <div className="flex flex-col gap-1.5">
            {input.items.map((item) => (
              <label
                key={item.id}
                className={`flex min-h-8 items-center gap-2 rounded-xl bg-background px-2.5 py-2 text-[13px] shadow-[inset_0_0_0_1px_var(--border)] ${
                  choice === item.id ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : ""
                }`}
              >
                <input
                  type="radio"
                  name={`saved-item-${view.interactionId}`}
                  value={item.id}
                  checked={choice === item.id}
                  disabled={busy}
                  onChange={() => setChoice(item.id)}
                  className="accent-foreground"
                />
                <span className="min-w-0 flex-1 wrap-anywhere" dir="auto">
                  {item.label}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">{item.display}</span>
              </label>
            ))}
          </div>
          <InteractionNote>{t`Selecting a saved item does not charge anything.`}</InteractionNote>
        </div>
      )}
      {error ? (
        <p role="alert" data-testid="input-card-error" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}
