import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  AvatarCharacter,
  AvatarMode,
  Bot,
  BotAvatarChangeView,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { ModelTreePicker } from "../../components/ModelTreePicker";
import {
  modelOptionKey,
  parseModelOptionKey,
  useConnectedModelOptions,
} from "../../lib/model-options";
import { rpc } from "../../lib/rpc";
import { type AvatarSelection, AvatarStudioPopover } from "./avatar-studio-popover";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
);

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";

function ComputerModePicker({
  value,
  onChange,
  teamTestId,
  privateTestId,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
  teamTestId?: string;
  privateTestId?: string;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Computer</Trans>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            pressed={value === mode}
            data-testid={mode === "team" ? teamTestId : privateTestId}
            onPressedChange={(pressed) => {
              if (pressed) onChange(mode);
            }}
            className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

export function CreateBotForm({
  onCreate,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
    color?: string;
    avatarMode?: AvatarMode;
    avatarCharacter?: AvatarCharacter;
    avatarBodyColor?: import("@rakazo/contracts").AvatarBodyColor;
    modelProvider?: string;
    modelId?: string;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [avatarSelection, setAvatarSelection] = useState<AvatarSelection>({
    avatarMode: "character",
    avatarCharacter: "dot",
  });
  const [avatarChosen, setAvatarChosen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [modelKey, setModelKey] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { catalog } = useConnectedModelOptions();
  const spaceDefaultLabel = me?.defaultModel
    ? (catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel)
    : undefined;

  useEffect(() => {
    void rpc
      .me()
      .then(setMe)
      .catch(() => undefined);
  }, []);

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const model = modelKey ? parseModelOptionKey(modelKey) : null;
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
        ...(avatarChosen ? avatarSelection : {}),
        ...(model ? { modelProvider: model.provider, modelId: model.modelId } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="create-bot-form">
      {error ? (
        <p
          role="alert"
          data-testid="create-bot-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex justify-center pb-1 pt-1">
        <AvatarStudioPopover
          selection={avatarSelection}
          identity={`new-bot-${ids}`}
          name={name || t`Bot`}
          onChange={(next) => {
            setAvatarSelection(next);
            setAvatarChosen(true);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label htmlFor={`${ids}-name`} className="block text-[14px] text-muted-foreground">
          <Trans>Name</Trans>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(e) => setName(e.target.value)}
            placeholder={t`Name this bot`}
            className="mt-2"
          />
        </label>
        <label htmlFor={`${ids}-title`} className="block text-[14px] text-muted-foreground">
          <Trans>Title</Trans>
          <Input
            id={`${ids}-title`}
            value={title}
            maxLength={BOT_TITLE_MAX_LENGTH}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t`Describe what this bot does`}
            className="mt-2"
          />
        </label>
      </div>
      <label
        htmlFor={`${ids}-description`}
        className="mt-3 block text-[14px] text-muted-foreground"
      >
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={3}
          className="mt-2 min-h-16 resize-none"
        />
      </label>
      <div className="mt-3 grid grid-cols-2 items-start gap-3">
        <div className="text-[14px] text-muted-foreground">
          <Trans>Model</Trans>
          <div className="mt-2">
            <ModelTreePicker
              value={modelKey ? parseModelOptionKey(modelKey) : null}
              spaceDefaultLabel={spaceDefaultLabel}
              onChange={(next) => {
                setModelKey(next ? modelOptionKey(next.provider, next.modelId) : "");
              }}
            />
          </div>
        </div>
        <div data-testid="create-bot-computer">
          <ComputerModePicker
            value={computerMode}
            onChange={setComputerMode}
            teamTestId="create-bot-team"
            privateTestId="create-bot-private"
          />
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <Button disabled={!name.trim() || submitting} onClick={() => void handleSubmit()}>
          {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
        </Button>
      </div>
    </div>
  );
}

export function BotSettings({
  bot,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
  onAvatarChanged,
}: {
  bot: Bot;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    avatarMode?: AvatarMode;
    avatarCharacter?: AvatarCharacter;
    avatarBodyColor?: import("@rakazo/contracts").AvatarBodyColor;
    notifyOnFinish?: boolean;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
  onAvatarChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [avatarSelection, setAvatarSelection] = useState<AvatarSelection>(() =>
    bot.avatarMode === "upload" && bot.color.startsWith("data:image/")
      ? { avatarMode: "upload", color: bot.color }
      : { avatarMode: "character", avatarCharacter: bot.avatarCharacter ?? "dot", avatarBodyColor: bot.avatarBodyColor ?? "ink" },
  );
  useEffect(() => {
    setAvatarSelection(
      bot.avatarMode === "upload" && bot.color.startsWith("data:image/")
        ? { avatarMode: "upload", color: bot.color }
        : { avatarMode: "character", avatarCharacter: bot.avatarCharacter ?? "dot", avatarBodyColor: bot.avatarBodyColor ?? "ink" },
    );
  }, [bot.id, bot.color, bot.avatarMode, bot.avatarCharacter, bot.avatarBodyColor]);
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [me, setMe] = useState<Me | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatarUndo, setAvatarUndo] = useState<{ changeId: string } | null>(null);
  const [avatarHistory, setAvatarHistory] = useState<BotAvatarChangeView[]>([]);
  useEffect(() => {
    let active = true;
    void rpc.bots
      .avatarChanges({ botId: bot.id })
      .then((changes) => {
        if (active) setAvatarHistory(changes);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bot.id, bot.avatarMode, bot.avatarCharacter, bot.avatarBodyColor, bot.color]);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  useEffect(() => {
    if (!avatarUndo) return;
    const timer = window.setTimeout(() => setAvatarUndo(null), 5000);
    return () => window.clearTimeout(timer);
  }, [avatarUndo]);
  const executeSaveRef = useRef<
    (patchOverrides?: {
      name?: string;
      title?: string;
      description?: string;
      notifyOnFinish?: boolean;
    }) => Promise<boolean>
  >(async () => true);
  const { credentials, catalog, ready: modelMetaReady } = useConnectedModelOptions();
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
    void rpc
      .me()
      .then(setMe)
      .catch(() => undefined);
  }, []);
  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = credentials.find(
    (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
  );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = effectiveCredential?.thinkingLevel ?? "medium";

  async function executeSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    notifyOnFinish?: boolean;
  }): Promise<boolean> {
    const selected = modelKey ? parseModelOptionKey(modelKey) : null;
    const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
    const nextTitle = (patchOverrides?.title !== undefined ? patchOverrides.title : title).trim();
    const nextDescription = (
      patchOverrides?.description !== undefined ? patchOverrides.description : description
    ).trim();
    const nextNotify =
      patchOverrides?.notifyOnFinish !== undefined ? patchOverrides.notifyOnFinish : notifyOnFinish;

    if (nextName) setName(nextName);
    setTitle(nextTitle);
    setDescription(nextDescription);

    try {
      setSaving(true);
      setError(null);
      await onSave({
        name: nextName || bot.name,
        title: nextTitle,
        description: nextDescription,
        instructions: nextDescription,
        notifyOnFinish: nextNotify,
        computerMode,
        memoryScope,
        autoSpeak,
        voiceId: voiceId || null,
        modelProvider: selected?.provider ?? null,
        modelId: selected?.modelId ?? null,
        ...(modelMetaReady
          ? {
              thinkingLevel: thinkingOptions.length
                ? ((thinkingLevel || null) as ThinkingLevel | null)
                : null,
            }
          : {}),
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
      return false;
    } finally {
      setSaving(false);
    }
  }
  executeSaveRef.current = executeSave;

  function enqueueSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    notifyOnFinish?: boolean;
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    saveQueueRef.current = saveQueueRef.current
      .catch(() => false)
      .then(() => executeSaveRef.current(patchOverrides));
    return saveQueueRef.current;
  }

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center py-4">
        <AvatarStudioPopover
          selection={avatarSelection}
          identity={bot.id}
          name={bot.name}
          onChange={async (next) => {
            const prior = avatarSelection;
            setAvatarSelection(next);
            try {
              const change = await rpc.bots.changeAvatar({ botId: bot.id, choice: next });
              if (change) setAvatarUndo({ changeId: change.id });
              void rpc.bots
                .avatarChanges({ botId: bot.id })
                .then(setAvatarHistory)
                .catch(() => undefined);
              window.dispatchEvent(new Event("workpal:avatar-refresh"));
              await onAvatarChanged().catch(() => undefined);
            } catch (cause) {
              setAvatarSelection(prior);
              throw cause;
            }
          }}
        />
      </div>
      {avatarUndo ? (
        <div
          role="status"
          className="mx-3 mb-2 flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-sm"
        >
          <Trans>Avatar updated</Trans>
          <button
            type="button"
            className="font-medium text-primary"
            onClick={() => {
              const target = avatarUndo;
              void rpc.bots
                .undoAvatarChange({ changeId: target.changeId })
                .then(async () => {
                  const restored = await rpc.bots.get({ botId: bot.id });
                  setAvatarSelection(
                    restored.avatarMode === "upload" && restored.color.startsWith("data:image/")
                      ? { avatarMode: "upload", color: restored.color }
                      : {
                          avatarMode: "character",
                          avatarCharacter: restored.avatarCharacter ?? "dot", avatarBodyColor: restored.avatarBodyColor ?? "ink",
                        },
                  );
                  setAvatarUndo(null);
                  void rpc.bots
                    .avatarChanges({ botId: bot.id })
                    .then(setAvatarHistory)
                    .catch(() => undefined);
                  window.dispatchEvent(new Event("workpal:avatar-refresh"));
                  await onAvatarChanged();
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : t`Could not undo avatar change`,
                  ),
                );
            }}
          >
            <Trans>Undo</Trans>
          </button>
        </div>
      ) : null}
      {avatarHistory.length ? (
        <details className="mx-3 mt-1 text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">
            <Trans>Avatar history</Trans>
          </summary>
          <ol className="mt-2 space-y-1.5">
            {avatarHistory.slice(0, 5).map((change) => (
              <li key={change.id}>
                {change.source === "bot" ? <Trans>Bot</Trans> : <Trans>You</Trans>}
                {" · "}
                {change.afterCharacter ?? t`Uploaded image`}
                {change.undoneAt ? ` · ${t`Undone`}` : ""}
                {" · "}
                {new Date(change.createdAt).toLocaleString()}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <label htmlFor={`${ids}-name`} className="mt-4 block text-[13.5px] text-muted-foreground/80">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void enqueueSave()}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void enqueueSave()}
          placeholder={t`e.g. Hivenet Agent, Presales, Timesheets bot`}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void enqueueSave()}
          rows={3}
          className="mt-1.5"
        />
      </label>
      <div className="mt-6 flex items-center justify-between pt-4 border-t border-border/20">
        <div className="space-y-0.5 pe-4">
          <div
            id={`${ids}-notify-finish-label`}
            className="text-[13.5px] font-medium text-foreground"
          >
            <Trans>Notifications</Trans>
          </div>
          <div id={`${ids}-notify-finish-desc`} className="text-[12px] text-muted-foreground/70">
            <Trans>Get notified when this Bot finishes or needs input</Trans>
          </div>
        </div>
        <Switch
          id={`${ids}-notify-finish`}
          checked={notifyOnFinish}
          aria-labelledby={`${ids}-notify-finish-label`}
          aria-describedby={`${ids}-notify-finish-desc`}
          onCheckedChange={(checked) => {
            setNotifyOnFinish(checked);
            void enqueueSave({ notifyOnFinish: checked });
          }}
        />
      </div>
      <details
        data-testid="bot-settings-advanced"
        className="group mt-5"
        onToggle={(event) => {
          if (event.currentTarget.open) setAdvancedOpened(true);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <span className="text-muted-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
          {advancedOpened ? (
            <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
          ) : null}
        </Suspense>
        <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
          <Trans>Model</Trans>
          <div className="mt-2">
            <ModelTreePicker
              value={modelKey ? parseModelOptionKey(modelKey) : null}
              spaceDefaultLabel={
                me?.defaultModel
                  ? (catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel)
                  : undefined
              }
              onChange={(next) => {
                setModelKey(next ? modelOptionKey(next.provider, next.modelId) : "");
                setThinkingLevel("");
              }}
            />
          </div>
        </label>
        {thinkingOptions.length ? (
          <label htmlFor={`${ids}-thinking`} className={fieldLabelClass}>
            <Trans>Thinking</Trans>
            <NativeSelect
              id={`${ids}-thinking`}
              className="mt-2 w-full"
              value={thinkingLevel}
              onChange={(event) => setThinkingLevel(event.target.value)}
            >
              <NativeSelectOption value="">
                {t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`}
              </NativeSelectOption>
              {thinkingOptions.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-muted-foreground">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
                ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
              ).map((option) => (
                <Toggle
                  key={option.label}
                  variant="outline"
                  size="sm"
                  pressed={memoryScope === option.value}
                  onPressedChange={(pressed) => {
                    if (pressed) setMemoryScope(option.value);
                  }}
                  className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
        ) : null}
        <label
          htmlFor={`${ids}-auto-speak`}
          className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-foreground/75"
        >
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label htmlFor={`${ids}-voice`} className={fieldLabelClass}>
            <Trans>Voice</Trans>
            <NativeSelect
              id={`${ids}-voice`}
              className="mt-2 w-full"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            void enqueueSave({
              name,
              title,
              description,
              notifyOnFinish,
            });
          }}
        >
          <Trans>Save</Trans>
        </Button>
        <Button variant="ghost" size="sm" className="-ms-2.5" onClick={() => void onExport()}>
          <Trans>Export</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 text-destructive hover:text-destructive"
          onClick={onClear}
        >
          <Trans>Clear conversation</Trans>
        </Button>
      </div>
    </div>
  );
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") return t`Extra high`;
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  if (level === "minimal") return t`Minimal`;
  if (level === "max") return t`Max`;
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}
