import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  BLOUB_COLORS,
  BLOUB_DEFAULT_COLOR,
  BLOUB_DEFAULT_EXPRESSION,
  BLOUB_DEFAULT_SHAPE,
  BLOUB_EXPRESSION_IDS,
  BLOUB_SHAPE_IDS,
  BloubAvatar,
  BotAvatar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  parseBotAvatar,
} from "@rakazo/ui-web";
import { Check, Pencil, Upload, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";

const BLOUB_INK = BLOUB_COLORS.find((c) => c.id === BLOUB_DEFAULT_COLOR)?.hex ?? "#0a0a0c";

function studioCellClass(selected: boolean): string {
  return (
    "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover " +
    (selected
      ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
      : "hover:bg-white/5")
  );
}

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  size?: number;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  size = 72,
  onChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bloub" | "upload">("bloub");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsed = parseBotAvatar(value, identity);
  const currentColor = parsed.color || BLOUB_INK;
  const currentShape = parsed.bloubShape ?? BLOUB_DEFAULT_SHAPE;
  const currentExpression = parsed.bloubExpression ?? BLOUB_DEFAULT_EXPRESSION;
  const currentBloub = parsed.bloub === true;

  function bloubValue(color: string, shape: string, expression: string) {
    return `${color}::bloub::${shape}::${expression}`;
  }

  function selectBloubShape(shape: string) {
    onChange(bloubValue(currentColor, shape, currentExpression));
  }

  function selectBloubExpression(expression: string) {
    onChange(bloubValue(currentColor, currentShape, expression));
  }

  function selectColor(color: string) {
    onChange(currentBloub ? bloubValue(color, currentShape, currentExpression) : `${color}::bloub`);
  }

  function resetAvatar() {
    onChange(bloubValue(BLOUB_INK, BLOUB_DEFAULT_SHAPE, BLOUB_DEFAULT_EXPRESSION));
  }

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const targetSize = 256;
        canvas.width = targetSize;
        canvas.height = targetSize;
        if (!ctx) return;

        ctx.beginPath();
        ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
        ctx.clip();

        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);

        onChange(canvas.toDataURL("image/webp", 0.9));
        setOpen(false);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLButtonElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        processImageFile(file);
        break;
      }
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group relative cursor-pointer rounded-2xl outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <BotAvatar color={value} identity={identity} size={size} status={status} />
        <div className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-foreground shadow-md transition-transform group-hover:scale-110">
          <Pencil size={12} strokeWidth={2.2} />
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100vw-32px)] max-w-[660px] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[660px]"
          data-testid="avatar-studio"
        >
          <DialogHeader className="sr-only space-y-0">
            <DialogTitle>
              <Trans>Avatar Studio</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Pick the bloub shape, expression, and colour</Trans>
            </DialogDescription>
          </DialogHeader>

          <div className="flex">
            {/* 左：大预览——头像在这里是主角 */}
            <div className="flex w-[248px] shrink-0 flex-col items-center justify-center gap-4 border-e border-border bg-muted/40 p-6">
              <div className="grid size-[184px] place-items-center overflow-hidden rounded-3xl border border-border bg-background">
                <BotAvatar color={value} identity={identity} size={148} status={status} />
              </div>
              <button
                type="button"
                onClick={resetAvatar}
                className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Trans>Reset</Trans>
              </button>
            </div>

            {/* 右：形状 / 表情 / 颜色 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border px-5 py-3">
                <div className="flex items-center rounded-full bg-muted p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setActiveTab("bloub")}
                    aria-pressed={activeTab === "bloub"}
                    className={`rounded-full px-3 py-1 font-medium transition-colors ${
                      activeTab === "bloub"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Trans>Bloub</Trans>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("upload")}
                    aria-pressed={activeTab === "upload"}
                    className={`rounded-full px-3 py-1 font-medium transition-colors ${
                      activeTab === "upload"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Trans>Upload</Trans>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t`Close`}
                >
                  <X size={16} />
                </button>
              </div>

              <div
                className="rk-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
                data-testid={activeTab === "bloub" ? "avatar-studio-bot-tab" : undefined}
              >
                {activeTab === "bloub" ? (
                  <>
                    <div>
                      <div className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                        <Trans>Shape</Trans>
                      </div>
                      <div className="grid grid-cols-4 place-items-center gap-2">
                        {BLOUB_SHAPE_IDS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => selectBloubShape(s)}
                            aria-label={s}
                            aria-pressed={currentBloub && s === currentShape}
                            data-testid={`avatar-bloub-shape-${s}`}
                            className={studioCellClass(currentBloub && s === currentShape)}
                          >
                            <BloubAvatar
                              color={currentColor}
                              shape={s}
                              expression={currentExpression}
                              size={36}
                              animated={false}
                            />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                        <Trans>Expression</Trans>
                      </div>
                      <div className="grid grid-cols-4 place-items-center gap-2">
                        {BLOUB_EXPRESSION_IDS.map((e) => (
                          <button
                            key={e}
                            type="button"
                            onClick={() => selectBloubExpression(e)}
                            aria-label={e}
                            aria-pressed={currentBloub && e === currentExpression}
                            data-testid={`avatar-bloub-expression-${e}`}
                            className={studioCellClass(currentBloub && e === currentExpression)}
                          >
                            <BloubAvatar
                              color={currentColor}
                              shape={currentShape}
                              expression={e}
                              size={36}
                              animated={false}
                            />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="border-t border-border pt-3">
                      <div className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                        <Trans>Colour</Trans>
                      </div>
                      <div className="grid grid-cols-6 place-items-center gap-2">
                        {BLOUB_COLORS.map((c) => {
                          const selected =
                            currentColor.toLowerCase() === c.hex.toLowerCase() && !parsed.isImage;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => selectColor(c.hex)}
                              aria-label={c.id}
                              aria-pressed={selected}
                              data-testid={`avatar-bloub-color-${c.id}`}
                              className={`size-6 rounded-full border transition-transform hover:scale-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring ${
                                selected
                                  ? "scale-105 border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                                  : "border-border"
                              }`}
                              style={{ backgroundColor: c.hex }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    aria-label={t`Image upload area`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onPaste={handlePaste}
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex w-full flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition-colors ${
                      dragOver
                        ? "border-primary bg-primary/10"
                        : "border-border bg-muted hover:border-foreground/30"
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) processImageFile(file);
                      }}
                    />
                    <div className="mb-2 grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
                      <Upload size={18} strokeWidth={1.8} />
                    </div>
                    <p className="text-[12.5px] font-medium text-muted-foreground">
                      <Trans>Drag, drop, or paste an image</Trans>
                    </p>
                    <span className="mt-3 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-foreground">
                      <Trans>Choose file</Trans>
                    </span>
                  </button>
                )}
              </div>

              {/* Plain footer bar: DialogFooter's -mx-4 -mb-4 assumes p-4 content,
                  but this dialog is p-0 — the negative margin would overflow the edge. */}
              <div className="flex items-center justify-end border-t border-border px-5 py-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-1.5 rounded-xl bg-secondary px-4 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Check size={14} />
                  <Trans>Done</Trans>
                </button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
