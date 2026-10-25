import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AVATAR_BODY_COLORS, type AvatarBodyColor, type AvatarCharacter } from "@rakazo/contracts";
import {
  AgentAvatar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { Check, Pencil, Upload, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";

export type AvatarSelection =
  | { avatarMode: "character"; avatarCharacter: AvatarCharacter; avatarBodyColor?: AvatarBodyColor }
  | { avatarMode: "upload"; color: string };

const characters: readonly AvatarCharacter[] = ["dot", "treble", "wave", "bounce"];
const allowedImages = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxImageBytes = 5 * 1024 * 1024;

function Preview({
  selection,
  identity,
  name,
  size,
}: {
  selection: AvatarSelection;
  identity: string;
  name: string;
  size: 16 | 24 | 32 | 64;
}) {
  if (selection.avatarMode === "character") {
    return (
      <AgentAvatar
        botId={identity}
        character={selection.avatarCharacter}
        bodyColor={selection.avatarBodyColor ?? "ink"}
        name={name}
        size={size}
        activity="idle"
        ariaHidden
      />
    );
  }
  return (
    <img
      src={selection.color}
      width={size}
      height={size}
      alt=""
      className="rounded-full object-cover"
    />
  );
}

export function AvatarStudioPopover({
  selection,
  identity = "preview",
  name = "Bot",
  onChange,
  disabled = false,
}: {
  selection: AvatarSelection;
  identity?: string;
  name?: string;
  onChange: (selection: AvatarSelection) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AvatarSelection>(selection);
  const [tab, setTab] = useState<"character" | "upload">(selection.avatarMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function setDialogOpen(next: boolean) {
    if (next) {
      setDraft(selection);
      setTab(selection.avatarMode);
      setError(null);
    }
    setOpen(next);
  }

  function processImage(file: File | undefined) {
    if (!file) return;
    if (!allowedImages.has(file.type)) {
      setError(t`Choose a PNG, JPEG, or WebP image`);
      return;
    }
    if (file.size > maxImageBytes) {
      setError(t`Image must be smaller than 5 MB`);
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (
        !image.naturalWidth ||
        !image.naturalHeight ||
        image.naturalWidth > 8192 ||
        image.naturalHeight > 8192
      ) {
        setError(t`Image dimensions are not supported`);
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        const edge = Math.min(image.naturalWidth, image.naturalHeight);
        context.drawImage(
          image,
          (image.naturalWidth - edge) / 2,
          (image.naturalHeight - edge) / 2,
          edge,
          edge,
          0,
          0,
          256,
          256,
        );
        const color = canvas.toDataURL("image/webp", 0.9);
        if (!color.startsWith("data:image/webp;")) throw new Error("WebP export unavailable");
        setDraft({ avatarMode: "upload", color });
        setTab("upload");
        setError(null);
      } catch {
        setError(t`Could not prepare this image`);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError(t`Could not open this image`);
    };
    image.src = url;
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    processImage(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    processImage(event.dataTransfer.files?.[0]);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(draft);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t`Could not save avatar`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setDialogOpen(true)}
        className="group relative rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <Preview selection={selection} identity={identity} name={name} size={64} />
        <span className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-foreground shadow-md">
          <Pencil size={12} strokeWidth={2.2} />
        </span>
      </button>
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent
          className="w-[calc(100vw-32px)] max-w-[660px] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[660px]"
          data-testid="avatar-studio"
        >
          <DialogHeader className="sr-only space-y-0">
            <DialogTitle>
              <Trans>Avatar Studio</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Choose a character or upload an image for this bot</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col sm:flex-row">
            <div className="flex w-full shrink-0 items-center justify-center border-b border-border bg-muted/40 p-6 sm:w-[248px] sm:border-b-0 sm:border-e">
              <div className="grid size-[184px] place-items-center rounded-3xl border border-border bg-background">
                <Preview selection={draft} identity={identity} name={name} size={64} />
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div
                className="flex gap-2 border-b border-border px-5 py-3"
                role="tablist"
                aria-label={t`Avatar source`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "character"}
                  onClick={() => setTab("character")}
                  className="rounded-lg px-3 py-2 text-sm aria-selected:bg-muted"
                >
                  <Trans>Characters</Trans>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "upload"}
                  onClick={() => setTab("upload")}
                  className="rounded-lg px-3 py-2 text-sm aria-selected:bg-muted"
                >
                  <Trans>Upload</Trans>
                </button>
              </div>
              <div className="rk-scroll min-h-[210px] flex-1 space-y-4 overflow-y-auto p-5">
                {tab === "character" ? (
                  <div role="tabpanel" className="space-y-4">
                    <fieldset className="flex min-w-0 gap-2" aria-label={t`Body color`}>
                      {AVATAR_BODY_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          aria-label={color}
                          aria-pressed={
                            draft.avatarMode === "character" &&
                            (draft.avatarBodyColor ?? "ink") === color
                          }
                          onClick={() =>
                            setDraft({
                              avatarMode: "character",
                              avatarCharacter:
                                draft.avatarMode === "character" ? draft.avatarCharacter : "dot",
                              avatarBodyColor: color,
                            })
                          }
                          className="h-7 w-7 rounded-full border-2 border-transparent aria-pressed:border-primary"
                          style={{ backgroundColor: `var(--wp-avatar-${color})` }}
                        />
                      ))}
                    </fieldset>
                    <div className="grid grid-cols-4 gap-2">
                      {characters.map((character) => (
                        <button
                          key={character}
                          type="button"
                          aria-label={character}
                          aria-pressed={
                            draft.avatarMode === "character" && draft.avatarCharacter === character
                          }
                          onClick={() =>
                            setDraft({
                              avatarMode: "character",
                              avatarCharacter: character,
                              avatarBodyColor:
                                draft.avatarMode === "character"
                                  ? (draft.avatarBodyColor ?? "ink")
                                  : "ink",
                            })
                          }
                          className="relative flex h-20 items-center justify-center rounded-xl border border-border bg-background focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary"
                        >
                          <AgentAvatar
                            botId={`${identity}-${character}`}
                            character={character}
                            bodyColor={
                              draft.avatarMode === "character" ? draft.avatarBodyColor : "ink"
                            }
                            name={character}
                            size={64}
                            activity="idle"
                            ariaHidden
                          />
                          {draft.avatarMode === "character" &&
                          draft.avatarCharacter === character ? (
                            <Check className="absolute right-1 top-1" size={14} />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div role="tabpanel" className="space-y-3">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleFile}
                      className="sr-only"
                      aria-label={t`Choose avatar image`}
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={handleDrop}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Upload size={16} />
                      <Trans>Choose or drop a PNG, JPEG, or WebP image (5 MB max)</Trans>
                    </button>
                  </div>
                )}
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
                >
                  <X size={14} className="inline" /> <Trans>Cancel</Trans>
                </button>
                <button
                  type="button"
                  disabled={busy || (tab === "upload" && draft.avatarMode !== "upload")}
                  onClick={() => void save()}
                  className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  <Trans>Save</Trans>
                </button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
