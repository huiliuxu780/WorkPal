import { t } from "@lingui/core/macro";
import { cn } from "@rakazo/ui-web";
import { Check, ChevronDown, ChevronRight, Search, Sparkle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectedModelOptions } from "../lib/model-options";
import { ProviderIcon } from "./provider-icons";

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export interface ModelTreePickerProps {
  value: ModelSelection | null;
  onChange: (next: ModelSelection | null) => void;
  /** Label shown after "Space default" on the default row and trigger. */
  spaceDefaultLabel?: string;
  id?: string;
  className?: string;
  /** Popover alignment for edge placements (top bar uses "end"). */
  align?: "start" | "end";
}

interface PickerGroup {
  provider: string;
  name: string;
  models: Array<{ modelId: string; label: string; modelLabel: string }>;
}

/**
 * Tree-style model picker: level one is the connected provider (with its brand
 * mark), level two the models it exposes. Search filters models and auto-expands
 * matching groups. Shared by the create-bot dialog and bot settings.
 */
export function ModelTreePicker({
  value,
  onChange,
  spaceDefaultLabel,
  id,
  className,
  align = "start",
}: ModelTreePickerProps) {
  const { options, credentials } = useConnectedModelOptions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const groups = useMemo<PickerGroup[]>(() => {
    const byProvider = new Map<string, PickerGroup>();
    for (const credential of credentials) {
      const models = options
        .filter((option) => option.provider === credential.provider)
        .map((option) => ({
          modelId: option.modelId,
          label: option.label,
          modelLabel: option.modelLabel,
        }));
      const existing = byProvider.get(credential.provider);
      if (existing) {
        for (const model of models) {
          if (!existing.models.some((m) => m.modelId === model.modelId)) existing.models.push(model);
        }
      } else {
        byProvider.set(credential.provider, {
          provider: credential.provider,
          name: credential.label,
          models,
        });
      }
    }
    return [...byProvider.values()];
  }, [credentials, options]);

  const selectedLabel = value
    ? options.find((option) => option.provider === value.provider && option.modelId === value.modelId)
        ?.modelLabel ?? value.modelId
    : spaceDefaultLabel
      ? `${t`Space default`} (${spaceDefaultLabel})`
      : t`Space default`;

  const q = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      models: q
        ? group.models.filter(
            (model) =>
              model.modelLabel.toLowerCase().includes(q) ||
              model.label.toLowerCase().includes(q) ||
              group.name.toLowerCase().includes(q),
          )
        : group.models,
    }))
    .filter((group) => !q || group.models.length > 0 || group.name.toLowerCase().includes(q));

  function toggleGroup(provider: string) {
    setExpanded((current) =>
      current.includes(provider)
        ? current.filter((item) => item !== provider)
        : [...current, provider],
    );
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((next) => !next)}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-start text-sm text-foreground transition-colors outline-none hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {value ? (
          <ProviderIcon provider={value.provider} />
        ) : (
          <Sparkle size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        <ChevronDown
          size={14}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className={cn(
            "rk-scroll absolute top-[calc(100%+6px)] z-50 max-h-80 w-[300px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-1 flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Search size={13} className="shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search providers & models`}
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex w-full min-h-[30px] items-center gap-2 rounded-lg px-2 text-start text-[13px] hover:bg-accent"
          >
            <Sparkle size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {spaceDefaultLabel ? `${t`Space default`} (${spaceDefaultLabel})` : t`Space default`}
            </span>
            {!value ? <Check size={14} className="shrink-0" /> : <span className="w-3.5" />}
          </button>

          {visibleGroups.map((group) => {
            const isOpen =
              expanded.includes(group.provider) ||
              (q !== "" && group.models.length > 0) ||
              (value?.provider === group.provider && expanded.length === 0);
            return (
              <div key={group.provider}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleGroup(group.provider)}
                  className="flex w-full min-h-[30px] items-center gap-2 rounded-lg px-2 text-start text-[13px] font-medium hover:bg-accent"
                >
                  <ProviderIcon provider={group.provider} />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <ChevronRight
                    size={13}
                    className={cn(
                      "shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                </button>
                {isOpen ? (
                  <div className="pl-3.5">
                    {group.models.map((model) => {
                      const selected =
                        value?.provider === group.provider && value.modelId === model.modelId;
                      return (
                        <button
                          key={model.modelId}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            onChange({ provider: group.provider, modelId: model.modelId });
                            setOpen(false);
                          }}
                          className="flex w-full min-h-[28px] items-center gap-2 rounded-lg px-2 text-start text-[13px] hover:bg-accent"
                        >
                          <span className="min-w-0 flex-1 truncate">{model.modelLabel}</span>
                          {selected ? <Check size={14} className="shrink-0" /> : <span className="w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}

          {visibleGroups.length === 0 ? (
            <p className="px-2 py-2.5 text-[12.5px] text-muted-foreground">{t`No matching providers`}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
