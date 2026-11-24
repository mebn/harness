import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FilePen, ListTodo, Search, ShieldOff, ShieldQuestion, Sparkle, Star, Zap } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ClaudeLogo, ProviderLogo } from "@/components/common/provider-logo";
import type { Option, ProviderInfo, Session } from "@/lib/backend";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { SessionSettings } from "@/stores/app-store";

type Props = {
  providers: ProviderInfo[];
  provider: ProviderInfo;
  session: Session;
  onChange: (settings: Partial<SessionSettings>) => void;
  /** The provider can't change mid-turn; models and effort still can. */
  lockProvider?: boolean;
};

type Entry = { provider: ProviderInfo; model: Option };

const FAVORITES_KEY = "harness.model-favorites";
const FAVORITES = "favorites";

function favKey(e: Entry) {
  return `${e.provider.id}:${e.model.id}`;
}

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites(list: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // Favorites are a convenience; losing them is fine.
  }
}

function ProviderIcon({ id, className }: { id: string; className?: string }) {
  return <ProviderLogo id={id} className={className} />;
}

/** Icon for a model: its family when the id tells, otherwise the provider's. */
function ModelIcon({ providerId, modelId, className }: { providerId: string; modelId: string; className?: string }) {
  if (modelId.startsWith("claude")) return <ClaudeLogo className={className} />;
  if (modelId.startsWith("gpt")) return <Sparkle className={className} />;
  return <ProviderIcon id={providerId} className={className} />;
}

/** Full model name, e.g. "Claude Opus 5.5" for a Claude model labelled "Opus 5.5". */
function modelName(e: Entry) {
  return e.model.id.startsWith("claude") && !e.model.label.startsWith("Claude") ? `Claude ${e.model.label}` : e.model.label;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground tabular-nums">{children}</kbd>
  );
}

function ModeIcon({ mode, className }: { mode: string; className?: string }) {
  if (mode === "plan") return <ListTodo className={className} />;
  if (mode === "edits") return <FilePen className={className} />;
  if (mode === "ask") return <ShieldQuestion className={className} />;
  return <ShieldOff className={className} />;
}

type SegmentOption = { id: string; label: string; icon?: ReactNode };

function Segmented({ value, options, onChange }: { value: string; options: SegmentOption[]; onChange: (id: string) => void }) {
  return (
    <div className="flex rounded-lg bg-muted p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-2 text-muted-foreground outline-none hover:text-foreground",
            o.id === value && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

const FAST_OFF_REASONS: Record<string, string> = {
  extra_usage_disabled: "it needs extra usage turned on for your Claude account",
  sdk_opt_in_required: "the CLI didn't get the opt-in",
};

/** Why fast mode isn't in effect, from what the CLI last reported; undefined when it is (or unknown yet). */
function fastOffText(s: Session): string | undefined {
  if (!s.fastState || s.fastState === "on") return undefined;
  if (s.fastState === "cooldown")
    return "Fast mode is cooling down after hitting its rate limit; turns run at standard speed for now.";
  const reason = s.fastOffReason ? (FAST_OFF_REASONS[s.fastOffReason] ?? s.fastOffReason.replaceAll("_", " ")) : "";
  return `Fast mode is off${reason ? `: ${reason}` : ""}. Turns run at standard speed.`;
}

/** Model, provider and reasoning effort in one popover: providers on the left, models in the middle, effort on the right. */
export function ModelPicker({ providers, provider, session, onChange, lockProvider }: Props) {
  const { model, effort } = session;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(provider.id);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [favorites, setFavorites] = useState(loadFavorites);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const currentModel = provider.models?.find((m) => m.id === model);
  const currentEffort = provider.efforts?.find((o) => o.id === effort);
  const currentMode = provider.modes?.find((o) => o.id === session.mode);
  const fast = provider.fast && session.fast;
  const fastOff = fast ? fastOffText(session) : undefined;

  // Reset to the session's provider each time the picker opens.
  useEffect(() => {
    if (!open) return;
    setTab(provider.id);
    setQuery("");
  }, [open, provider.id]);

  const entries = useMemo<Entry[]>(() => {
    const all = providers.flatMap((p) => (p.models ?? []).map((m) => ({ provider: p, model: m })));
    const q = query.trim().toLowerCase();
    let shown: Entry[];
    if (q) {
      // Search spans every provider.
      shown = all.filter((e) => `${modelName(e)} ${e.model.id} ${e.provider.name}`.toLowerCase().includes(q));
    } else if (tab === FAVORITES) {
      shown = favorites.map((k) => all.find((e) => favKey(e) === k)).filter((e): e is Entry => !!e);
    } else {
      shown = all.filter((e) => e.provider.id === tab);
    }
    if (lockProvider) shown = shown.filter((e) => e.provider.id === provider.id);
    return shown;
  }, [providers, query, tab, favorites, lockProvider, provider.id]);

  useEffect(() => {
    setActive(
      Math.max(
        0,
        entries.findIndex((e) => e.provider.id === provider.id && e.model.id === model),
      ),
    );
  }, [entries, provider.id, model]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (e: Entry) => {
    if (e.provider.id === provider.id) {
      onChange({ model: e.model.id });
    } else {
      // Keep the effort when the new provider offers it.
      const keep = e.provider.efforts?.some((o) => o.id === effort);
      onChange({ provider: e.provider.id, model: e.model.id, effort: keep ? effort : e.provider.defaultEffort });
    }
  };

  const toggleFavorite = (e: Entry) => {
    const k = favKey(e);
    const next = favorites.includes(k) ? favorites.filter((x) => x !== k) : [...favorites, k];
    setFavorites(next);
    saveFavorites(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && /^Digit[1-9]$/.test(e.code)) {
      const target = entries[Number(e.code.slice(5)) - 1];
      if (target) {
        e.preventDefault();
        pick(target);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = entries.length;
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && entries[active]) {
      e.preventDefault();
      pick(entries[active]);
      setOpen(false);
    }
  };

  const tabs = [
    { id: FAVORITES, label: "Favorites", icon: <Star className="size-[18px] fill-current" /> },
    ...providers.map((p) => ({ id: p.id, label: p.name, icon: <ProviderIcon id={p.id} className="size-5" /> })),
  ];

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
        <ModelIcon providerId={provider.id} modelId={model} className="size-3.5" />
        <span>
          {currentModel?.label ?? model}
          {currentEffort && <span className="ml-1 opacity-70">{currentEffort.label}</span>}
        </span>
        {fast && (
          <span title={fastOff ?? "Fast mode"}>
            <Zap className={cn("size-3.5", fastOff ? "text-amber-500" : "fill-current")} />
          </span>
        )}
        {currentMode && (
          <span title={currentMode.label}>
            <ModeIcon mode={currentMode.id} className="size-3.5" />
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            search.current?.focus();
          }}
          onKeyDown={onKeyDown}
          className="z-50 flex w-[min(36rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex h-64 min-h-0">
            {/* Provider rail */}
            <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
              {tabs.map((t, i) => {
                const disabled = lockProvider && t.id !== FAVORITES && t.id !== provider.id;
                return (
                  <div key={t.id} className="contents">
                    <button
                      type="button"
                      title={disabled ? `${t.label} (can't switch while running)` : t.label}
                      disabled={disabled}
                      onClick={() => {
                        setTab(t.id);
                        setQuery("");
                        search.current?.focus();
                      }}
                      className={cn(
                        "relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
                        tab === t.id && !query && "text-foreground",
                      )}
                    >
                      {t.icon}
                      {tab === t.id && !query && <span className="absolute -right-2 h-4 w-0.5 rounded-full bg-primary" />}
                    </button>
                    {i === 0 && <div className="my-1 h-px w-7 bg-border" />}
                  </div>
                );
              })}
            </div>

            {/* Models */}
            <div className="flex min-w-0 flex-1 flex-col border-r">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models…"
                  className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div ref={list} className="flex-1 overflow-y-auto p-1">
                {entries.length === 0 && (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {tab === FAVORITES && !query ? "Star a model to keep it here" : "No models found"}
                  </div>
                )}
                {entries.map((e, i) => {
                  const selected = e.provider.id === provider.id && e.model.id === model;
                  const fav = favorites.includes(favKey(e));
                  return (
                    <div
                      key={favKey(e)}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setActive(i)}
                      onClick={() => pick(e)}
                      className={cn(
                        "group flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs",
                        i === active && "bg-accent",
                      )}
                    >
                      <ModelIcon providerId={e.provider.id} modelId={e.model.id} className="size-4 shrink-0" />
                      <span className="truncate">{modelName(e)}</span>
                      {(query || tab === FAVORITES) && <span className="truncate text-muted-foreground">{e.provider.name}</span>}
                      {selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
                      <div className="flex-1" />
                      <button
                        type="button"
                        title={fav ? "Remove from favorites" : "Add to favorites"}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggleFavorite(e);
                        }}
                        className={cn(
                          "flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground",
                          !fav && "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <Star className={cn("size-3", fav && "fill-current")} />
                      </button>
                      {i < 9 && <Kbd>{isMac ? `⌘${i + 1}` : `Ctrl ${i + 1}`}</Kbd>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Reasoning effort */}
            <div className="flex w-44 shrink-0 flex-col">
              <div className="flex h-[41px] items-center justify-between gap-2 border-b px-3 text-xs">
                <span className="text-muted-foreground">Reasoning</span>
                <span className="truncate text-[11px] text-muted-foreground/70">{currentModel?.label}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-1">
                {(provider.efforts ?? []).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onChange({ effort: o.id })}
                    className="flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-xs outline-none hover:bg-accent"
                  >
                    {o.label}
                    {o.id === effort && <Check className="size-3.5" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {fastOff && <div className="border-t px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">{fastOff}</div>}

          {/* Speed and permissions */}
          <div className="flex flex-wrap items-center gap-2 border-t p-2">
            {provider.fast && (
              <Segmented
                value={session.fast ? "fast" : "standard"}
                onChange={(v) => onChange({ fast: v === "fast" })}
                options={[
                  { id: "standard", label: "Standard" },
                  { id: "fast", label: "Fast", icon: <Zap className="size-3" /> },
                ]}
              />
            )}
            <div className="flex-1" />
            <Segmented
              value={session.mode}
              onChange={(mode) => onChange({ mode })}
              options={(provider.modes ?? []).map((o) => ({
                id: o.id,
                label: o.label,
                icon: <ModeIcon mode={o.id} className="size-3" />,
              }))}
            />
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
