import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FilePen, Gauge, ListTodo, Search, ShieldCheck, ShieldOff, ShieldQuestion, Star, Zap } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { AccountBadge, ClaudeLogo, OpenAILogo, ProviderLogo, accountLabel } from "@/components/common/provider-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Option, ProviderInfo, Session } from "@/lib/backend";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp, type SessionSettings } from "@/stores/app-store";

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

/** Icon for a model: its family when the id tells, otherwise its CLI's. */
function ModelIcon({ tool, modelId, className }: { tool: string; modelId: string; className?: string }) {
  if (modelId.startsWith("claude")) return <ClaudeLogo className={className} />;
  if (/^(gpt|o\d|codex)/.test(modelId)) return <OpenAILogo className={className} />;
  return <ProviderLogo id={tool} className={className} />;
}

/** Full model name, e.g. "Claude Opus 5.5" for a Claude model labelled "Opus 5.5". */
function modelName(e: Entry) {
  return e.model.id.startsWith("claude") && !e.model.label.startsWith("Claude") ? `Claude ${e.model.label}` : e.model.label;
}

/** Provider name with its account, e.g. "Claude Code · me@example.com". */
function providerTitle(p: ProviderInfo) {
  const account = accountLabel(p);
  return account ? `${p.name} · ${account}` : p.name;
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
  if (mode === "auto") return <ShieldCheck className={className} />;
  return <ShieldOff className={className} />;
}

type MenuOption = { id: string; label: string; icon: ReactNode };

/** A dropdown in the picker's footer: the current choice, opening a menu of all of them. */
function FooterMenu({
  label,
  value,
  options,
  onChange,
  align,
}: {
  label: string;
  value: string;
  options: MenuOption[];
  onChange: (id: string) => void;
  align: "start" | "end";
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={label}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        {current?.icon}
        <span>{current?.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align={align} sideOffset={6} className="min-w-44">
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-normal text-muted-foreground">{label}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onChange(o.id)} className="h-8 gap-2 text-xs">
            {o.icon}
            <span className="flex-1">{o.label}</span>
            {o.id === value && <Check className="size-3.5 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RailButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-accent text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
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

const SPEEDS: MenuOption[] = [
  { id: "standard", label: "Standard", icon: <Gauge className="size-3.5" /> },
  { id: "fast", label: "Fast", icon: <Zap className="size-3.5" /> },
];

/**
 * Model, provider and reasoning effort in one popover: providers on the left (a CLI's
 * accounts numbered on their icons), models in the middle, effort on the right, and speed and
 * permissions in the footer.
 */
export function ModelPicker({ providers, provider, session, onChange, lockProvider }: Props) {
  const { model, effort } = session;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(provider.id);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [favorites, setFavorites] = useState(loadFavorites);
  const reloadProviders = useApp((s) => s.reloadProviders);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const currentModel = provider.models?.find((m) => m.id === model);
  const currentEffort = provider.efforts?.find((o) => o.id === effort);
  const currentMode = provider.modes?.find((o) => o.id === session.mode);
  const fast = provider.fast && session.fast;
  const fastOff = fast ? fastOffText(session) : undefined;

  // Reset to the session's provider each time the picker opens, with accounts up to date.
  useEffect(() => {
    if (!open) return;
    setTab(provider.id);
    setQuery("");
    void reloadProviders();
  }, [open, provider.id, reloadProviders]);

  const entries = useMemo<Entry[]>(() => {
    const all = providers.flatMap((p) => (p.models ?? []).map((m) => ({ provider: p, model: m })));
    const q = query.trim().toLowerCase();
    let shown: Entry[];
    if (q) {
      // Search spans every provider.
      shown = all.filter((e) => `${modelName(e)} ${e.model.id} ${providerTitle(e.provider)}`.toLowerCase().includes(q));
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

  const selectTab = (id: string) => {
    setTab(id);
    setQuery("");
    search.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys in the footer's menus (portaled, but bubbling here through React) are theirs.
    if (!e.currentTarget.contains(e.target as Node)) return;
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

  const tabProvider = providers.find((p) => p.id === tab);
  const modes: MenuOption[] = (provider.modes ?? []).map((o) => ({
    id: o.id,
    label: o.label,
    icon: <ModeIcon mode={o.id} className="size-3.5" />,
  }));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        title={providerTitle(provider)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <AccountBadge no={provider.accountNo} ringClassName="ring-card" className="mr-1">
          <ModelIcon tool={provider.tool} modelId={model} className="size-3.5" />
        </AccountBadge>
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
          className="z-50 flex w-[min(38rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {/* The three columns' headers share one height so their lines meet, and rail buttons
              and list rows share one height so they line up below. */}
          <div className="flex h-72 min-h-0">
            {/* Providers */}
            <div className="flex w-12 shrink-0 flex-col border-r">
              <div className="flex h-10 shrink-0 items-center justify-center border-b">
                <RailButton title="Favorites" active={tab === FAVORITES && !query} onClick={() => selectTab(FAVORITES)}>
                  <Star className="size-[18px] fill-yellow-400 text-yellow-400" />
                </RailButton>
              </div>
              <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-1 [scrollbar-width:none]">
                {providers.map((p) => {
                  const disabled = lockProvider && p.id !== provider.id;
                  const on = tab === p.id && !query;
                  return (
                    <RailButton
                      key={p.id}
                      title={disabled ? `${providerTitle(p)} (can't switch while running)` : providerTitle(p)}
                      disabled={disabled}
                      active={on}
                      onClick={() => selectTab(p.id)}
                    >
                      <AccountBadge no={p.accountNo} ringClassName={on ? "ring-accent" : "ring-popover"}>
                        <ProviderLogo id={p.tool} className="size-5" />
                      </AccountBadge>
                    </RailButton>
                  );
                })}
              </div>
            </div>

            {/* Models */}
            <div className="flex min-w-0 flex-1 flex-col border-r">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models…"
                  className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {!query && (
                  <span className="max-w-[60%] shrink-0 truncate text-[11px] text-muted-foreground/70">
                    {tab === FAVORITES ? "Favorites" : tabProvider && providerTitle(tabProvider)}
                  </span>
                )}
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
                  // Favorites and search mix providers: say whose each model is.
                  const mixed = !!query || tab === FAVORITES;
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
                      <AccountBadge no={mixed ? e.provider.accountNo : 0} ringClassName={i === active ? "ring-accent" : "ring-popover"}>
                        <ModelIcon tool={e.provider.tool} modelId={e.model.id} className="size-4 shrink-0" />
                      </AccountBadge>
                      <span className="shrink-0">{modelName(e)}</span>
                      {mixed && (
                        <span className="min-w-0 truncate text-muted-foreground" title={providerTitle(e.provider)}>
                          {providerTitle(e.provider)}
                        </span>
                      )}
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
                          "flex size-5 shrink-0 items-center justify-center rounded",
                          fav
                            ? "text-yellow-400 hover:text-yellow-500"
                            : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground",
                        )}
                      >
                        <Star className={cn("size-3.5", fav && "fill-current")} />
                      </button>
                      {i < 9 && <Kbd>{isMac ? `⌘${i + 1}` : `Ctrl ${i + 1}`}</Kbd>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Reasoning effort */}
            <div className="flex w-40 shrink-0 flex-col">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs">
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
          <div className="flex h-10 shrink-0 items-center gap-1 border-t px-1.5">
            {provider.fast && (
              <FooterMenu
                label="Speed"
                align="start"
                value={session.fast ? "fast" : "standard"}
                onChange={(v) => onChange({ fast: v === "fast" })}
                options={SPEEDS}
              />
            )}
            <div className="flex-1" />
            {modes.length > 0 && (
              <FooterMenu label="Permissions" align="end" value={session.mode} onChange={(mode) => onChange({ mode })} options={modes} />
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
