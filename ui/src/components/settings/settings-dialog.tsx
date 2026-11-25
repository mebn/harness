import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  CornerDownRight,
  Keyboard,
  LayoutGrid,
  ListPlus,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  RotateCcw,
  Server,
  Sun,
  Type,
  type LucideIcon,
} from "lucide-react";
import { KIND_META, TabIcon } from "@/components/workspace/tab-meta";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  SHORTCUTS,
  combosFor,
  comboFromEvent,
  conflictsWith,
  formatCombo,
  isCustomized,
  isMac,
  shortcutLabel,
  useShortcuts,
  type Shortcut,
} from "@/lib/shortcuts";
import {
  SPLIT_STRATEGIES,
  TAB_KINDS,
  computeLayout,
  newPane,
  placeNewPane,
  type LayoutNode,
  type SplitStrategy,
} from "@/lib/layout-tree";
import { Browser, HotkeyService, type HotkeyInfo } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { AgentsSettings } from "./agents-settings";
import { List, Row, Section } from "./parts";
import { FONT_META, UI_FONT_META, fontSize, useSettings, type SendMode } from "@/stores/settings-store";
import { useTheme, type ThemePref } from "@/stores/theme-store";

type Category = { id: string; label: string; icon: LucideIcon; render: () => ReactNode };

const CATEGORIES: Category[] = [
  { id: "appearance", label: "Appearance", icon: Palette, render: () => <Appearance /> },
  { id: "chat", label: "Chat", icon: MessageSquare, render: () => <ChatSettings /> },
  { id: "agents", label: "Agents & models", icon: Bot, render: () => <AgentsSettings /> },
  { id: "windows", label: "Windows", icon: LayoutGrid, render: () => <SplitStrategyPicker /> },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, render: () => <ShortcutsTable /> },
  { id: "server", label: "Server", icon: Server, render: () => <ServerInfo /> },
];

type Props = { open: boolean; onOpenChange: (open: boolean) => void; initial?: string };

export function SettingsDialog({ open, onOpenChange, initial }: Props) {
  const [current, setCurrent] = useState(initial ?? CATEGORIES[0].id);
  useEffect(() => {
    if (open) setCurrent(initial ?? CATEGORIES[0].id);
  }, [open, initial]);
  const category = CATEGORIES.find((c) => c.id === current) ?? CATEGORIES[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(640px,85vh)] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-2">
          <DialogTitle className="px-2 pt-2 pb-3 text-sm font-semibold">Settings</DialogTitle>
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCurrent(id)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                id === current && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="flex flex-col gap-8">{category.render()}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- appearance ----

const THEMES: { id: ThemePref; label: string; icon: LucideIcon }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

function Appearance() {
  return (
    <>
      <Section title="Theme">
        <ThemeToggle />
      </Section>
      <TextSizes />
    </>
  );
}

/** Two or three options side by side, one chosen. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string; icon: LucideIcon }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex w-fit rounded-lg bg-muted p-0.5">
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground",
            value === id && "bg-background text-foreground shadow-sm",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  return <Segmented value={pref} options={THEMES} onChange={setPref} />;
}

// ---- chat ----

const SEND_MODES: { id: SendMode; label: string; icon: LucideIcon }[] = [
  { id: "steer", label: "Steer", icon: CornerDownRight },
  { id: "queue", label: "Queue", icon: ListPlus },
];

function ChatSettings() {
  const mode = useSettings((s) => s.sendWhileRunning);
  const setMode = useSettings((s) => s.setSendWhileRunning);
  const alt = isMac ? "⌥" : "Alt+";
  return (
    <Section title="Sending while the agent works">
      <Segmented value={mode} options={SEND_MODES} onChange={setMode} />
      <p className="text-xs text-muted-foreground">
        {mode === "steer"
          ? `Enter sends into the running turn right away; ${alt}Enter queues it for after.`
          : `Enter queues the message for after the turn; ${alt}Enter steers it in right away.`}
      </p>
    </Section>
  );
}

// ---- text size ----

function TextSizes() {
  const sizes = useSettings((s) => s.fontSizes);
  const setFontSize = useSettings((s) => s.setFontSize);
  const reset = useSettings((s) => s.resetFontSize);
  const uiSize = useSettings((s) => s.uiFontSize);
  const setUiSize = useSettings((s) => s.setUiFontSize);
  const anyChanged = Object.keys(sizes).length > 0 || uiSize !== UI_FONT_META.def;

  return (
    <Section
      title="Text size"
      action={
        <Button
          variant="ghost"
          size="xs"
          disabled={!anyChanged}
          onClick={() => {
            reset();
            setUiSize(UI_FONT_META.def);
          }}
        >
          <RotateCcw /> Reset all
        </Button>
      }
    >
      <List>
        <SizeRow
          icon={<Type className="size-4 text-muted-foreground" />}
          label="App interface"
          meta={UI_FONT_META}
          value={uiSize}
          changed={uiSize !== UI_FONT_META.def}
          onChange={setUiSize}
          onReset={() => setUiSize(UI_FONT_META.def)}
        />
        {TAB_KINDS.map((kind, i) => {
          const meta = FONT_META[kind];
          return (
            <SizeRow
              key={kind}
              icon={<TabIcon kind={kind} className="size-4 text-muted-foreground" />}
              label={kind === "browser" ? "Browser zoom" : KIND_META[kind].label}
              meta={meta}
              value={fontSize(kind, sizes)}
              changed={sizes[kind] !== undefined}
              onChange={(v) => setFontSize(kind, v)}
              onReset={() => reset(kind)}
            />
          );
        })}
      </List>
    </Section>
  );
}

function SizeRow({
  icon,
  label,
  meta,
  value,
  changed,
  onChange,
  onReset,
}: {
  icon: ReactNode;
  label: string;
  meta: { def: number; min: number; max: number; step: number; unit: string };
  value: number;
  changed: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-3 py-1.5">
      {icon}
      <div className="flex-1 text-sm">{label}</div>
      <div className="flex items-center rounded-md border bg-background/60">
        <button
          aria-label={`Smaller ${label} text`}
          disabled={value <= meta.min}
          onClick={() => onChange(value - meta.step)}
          className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Minus className="size-3.5" />
        </button>
        <span className={cn("w-14 text-center text-sm tabular-nums", changed && "font-semibold")}>
          {value}
          {meta.unit}
        </span>
        <button
          aria-label={`Larger ${label} text`}
          disabled={value >= meta.max}
          onClick={() => onChange(value + meta.step)}
          className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <button
        aria-label={`Reset ${label} text size`}
        title={`Reset to ${meta.def}${meta.unit}`}
        onClick={onReset}
        className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", !changed && "invisible")}
      >
        <RotateCcw className="size-3.5" />
      </button>
    </div>
  );
}

// ---- windows ----

const PREVIEW = { width: 120, height: 76, gap: 3 };

/** Four windows opened one after another with a strategy, each new one focused. */
function previewLayout(strategy: SplitStrategy) {
  let root: LayoutNode = newPane([{ id: "t0", kind: "chat" }], "p0");
  let focused: string | null = "p0";
  for (let i = 1; i < 4; i++) {
    const placed = placeNewPane(root, newPane([{ id: `t${i}`, kind: "chat" }], `p${i}`), {
      strategy,
      width: PREVIEW.width,
      height: PREVIEW.height,
      focused,
      gap: PREVIEW.gap,
    });
    root = placed.root;
    focused = placed.focus;
  }
  return computeLayout(root, { left: 0, top: 0, width: PREVIEW.width, height: PREVIEW.height }, PREVIEW.gap).panes;
}

function SplitStrategyPicker() {
  const current = useSettings((s) => s.splitStrategy);
  const setStrategy = useSettings((s) => s.setSplitStrategy);
  return (
    <Section title="Where new windows open">
    <div role="radiogroup" className="grid gap-2">
      {SPLIT_STRATEGIES.map((s) => {
        const rects = previewLayout(s.id);
        const selected = s.id === current;
        return (
          <button
            key={s.id}
            role="radio"
            aria-checked={selected}
            onClick={() => setStrategy(s.id)}
            className={cn(
              "flex items-center gap-4 rounded-xl border p-3 text-left hover:bg-accent/50",
              selected && "border-ring bg-accent/60 ring-2 ring-ring/25",
            )}
          >
            <div className="relative shrink-0 rounded-md bg-muted" style={{ width: PREVIEW.width, height: PREVIEW.height }}>
              {Object.entries(rects).map(([id, r]) => (
                <div
                  key={id}
                  className={cn(
                    "absolute flex items-center justify-center rounded-[3px] border text-[9px] text-muted-foreground",
                    id === "p0" ? "bg-background" : "bg-background/70",
                  )}
                  style={r}
                >
                  {Number(id.slice(1)) + 1}
                </div>
              ))}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {s.label}
                {s.id === "dwindle" && <span className="text-xs font-normal text-muted-foreground">Default</span>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>
            </div>
          </button>
        );
      })}
    </div>
    </Section>
  );
}

// ---- server ----

function ServerInfo() {
  const system = useApp((s) => s.system);
  return (
    <Section title="Connection">
      <List>
        <Row label="Connected to">
          <span className="text-sm text-muted-foreground">{system.os === "darwin" ? "This Mac" : "This PC"}</span>
        </Row>
        <Row label="Machine">
          <span className="font-mono text-xs text-muted-foreground">{system.hostname || "—"}</span>
        </Row>
        <Row label="Platform">
          <span className="text-sm text-muted-foreground">
            {system.os}
            {system.hasWsl && " · WSL available"}
          </span>
        </Row>
      </List>
    </Section>
  );
}

// ---- quick chat hotkey ----

const MOD = isMac ? "⌘" : "Ctrl";
/** The double taps offered, as hotkey specs (see internal/hotkey). */
const DOUBLE_TAPS: { spec: string; label: string }[] = [
  { spec: "mod mod", label: `Double-tap ${MOD}` },
  { spec: "alt alt", label: `Double-tap ${isMac ? "⌥" : "Alt"}` },
  { spec: "shift shift", label: `Double-tap ${isMac ? "⇧" : "Shift"}` },
];

/** Wails key names for KeyboardEvent codes that aren't a letter or digit. */
const NAMED_KEYS: Record<string, string> = {
  Space: "space",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "page up",
  PageDown: "page down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** A key press as a hotkey combination ("ctrl+shift+space"); null for a modifier alone or no modifier. */
function hotkeyFromEvent(e: KeyboardEvent): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code.toLowerCase();
  else if (NAMED_KEYS[e.code]) key = NAMED_KEYS[e.code];
  else if (e.key.length === 1 && e.key !== "+") key = e.key.toLowerCase();
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && (isMac ? "cmd" : "win")].filter(Boolean);
  // Function keys may stand alone; anything else needs a modifier, or it would swallow typing.
  if (mods.length === 0 && !/^f\d/.test(key)) return null;
  return [...mods, key].join("+");
}

/** The system-wide shortcut that opens the quick chat (kept by the server). */
function QuickChatShortcut() {
  const [info, setInfo] = useState<HotkeyInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const setGlobalRecording = useShortcuts((s) => s.setRecording);

  useEffect(() => {
    HotkeyService.Get()
      .then(setInfo)
      .catch((e) => setProblem(String(e)));
  }, []);

  const save = (spec: string) => {
    setProblem(null);
    HotkeyService.Set(spec)
      .then(setInfo)
      .catch((e) => setProblem(String(e)));
  };

  useEffect(() => {
    if (!recording) return;
    setGlobalRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return setRecording(false);
      const spec = hotkeyFromEvent(e);
      if (!spec) return; // modifiers alone: keep waiting
      setRecording(false);
      save(spec);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setGlobalRecording(false);
    };
  }, [recording, setGlobalRecording]); // eslint-disable-line react-hooks/exhaustive-deps

  const spec = info?.spec ?? "";
  const custom = !!info && spec !== "off" && !DOUBLE_TAPS.some((d) => d.spec === spec);
  const choice = !info ? "" : spec === "off" ? "off" : custom ? "custom" : spec;

  return (
    <Section title="Quick chat">
      <List>
        <Row label="Open quick chat">
          <div className="flex items-center gap-2">
            <select
              value={choice}
              disabled={!info}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") setRecording(true);
                else save(v);
              }}
              className="h-7 rounded-md border bg-background/60 px-2 text-xs outline-none hover:border-ring focus:border-ring"
            >
              {DOUBLE_TAPS.map((d) => (
                <option key={d.spec} value={d.spec}>
                  {d.label}
                </option>
              ))}
              <option value="custom">Custom shortcut…</option>
              <option value="off">Off</option>
            </select>
            {(custom || recording) && (
              <button
                onClick={() => setRecording(!recording)}
                title="Click to change"
                className={cn(
                  "inline-flex h-7 min-w-24 shrink-0 items-center justify-center rounded-md border bg-background/60 px-2 font-mono text-xs hover:border-ring",
                  recording && "border-ring ring-2 ring-ring/30",
                )}
              >
                {recording ? "Press keys…" : info?.label}
              </button>
            )}
          </div>
        </Row>
      </List>
      {(problem || info?.error) && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {problem ?? info?.error}
          {info?.settingsUrl && info.error && (
            <>
              {" "}
              <button className="underline underline-offset-2" onClick={() => void Browser.OpenURL(info.settingsUrl)}>
                Open System Settings
              </button>
            </>
          )}
        </p>
      )}
    </Section>
  );
}

// ---- shortcuts ----

function ShortcutsTable() {
  const overrides = useShortcuts((s) => s.overrides);
  const reset = useShortcuts((s) => s.reset);
  const [recording, setRecording] = useState<string | null>(null);
  const sections = [...new Set(SHORTCUTS.map((s) => s.section))];
  const anyCustom = Object.keys(overrides).length > 0;

  return (
    <>
      <QuickChatShortcut />
      {sections.map((section, i) => (
        <Section
          key={section}
          title={section}
          action={
            i === 0 && (
              <Button variant="ghost" size="xs" disabled={!anyCustom} onClick={() => reset()}>
                <RotateCcw /> Reset all
              </Button>
            )
          }
        >
          <List>
            {SHORTCUTS.filter((s) => s.section === section).map((s) => (
              <ShortcutRow
                key={s.id}
                shortcut={s}
                recording={recording === s.id}
                onRecord={(on) => setRecording(on ? s.id : null)}
              />
            ))}
          </List>
        </Section>
      ))}
    </>
  );
}

function ShortcutRow({
  shortcut,
  recording,
  onRecord,
}: {
  shortcut: Shortcut;
  recording: boolean;
  onRecord: (on: boolean) => void;
}) {
  const overrides = useShortcuts((s) => s.overrides);
  const bind = useShortcuts((s) => s.set);
  const reset = useShortcuts((s) => s.reset);
  const setGlobalRecording = useShortcuts((s) => s.setRecording);
  const combos = combosFor(shortcut.id, overrides);
  const conflicts = conflictsWith(shortcut.id, combos, overrides);
  const custom = isCustomized(shortcut.id, overrides);

  // While recording, the next key press (with its modifiers) becomes the binding.
  useEffect(() => {
    if (!recording) return;
    setGlobalRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.code === "Escape" && noMods) return onRecord(false);
      if ((e.code === "Backspace" || e.code === "Delete") && noMods) {
        bind(shortcut.id, null);
        return onRecord(false);
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier on its own: keep waiting
      bind(shortcut.id, combo);
      onRecord(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setGlobalRecording(false);
    };
  }, [recording, shortcut.id, bind, onRecord, setGlobalRecording]);

  const mods = combos[0] ? formatCombo({ ...combos[0], code: "" }) : "";
  const shown =
    shortcut.numbered && combos.length > 0 ? `${mods}${isMac || !mods ? "" : "+"}1…9` : shortcutLabel(shortcut.id, overrides);

  return (
    <div className="flex min-h-11 items-center gap-3 px-3 py-1.5 text-sm">
      <div className="min-w-0 flex-1">
        <div>{shortcut.label}</div>
        {conflicts.length > 0 && (
          <div className="text-xs text-amber-600 dark:text-amber-400">Also used by {conflicts.map((c) => c.label).join(", ")}</div>
        )}
      </div>
      <button
          onClick={() => onRecord(!recording)}
          title="Click to change"
          className={cn(
            "inline-flex h-7 min-w-24 shrink-0 items-center justify-center rounded-md border bg-background/60 px-2 font-mono text-xs hover:border-ring",
            recording && "border-ring ring-2 ring-ring/30",
            !shown && !recording && "text-muted-foreground",
            custom && !recording && "font-semibold",
          )}
        >
          {recording ? (shortcut.numbered ? "Press modifiers + a digit…" : "Press keys…") : shown || "Not set"}
        </button>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {custom && (
          <button
            aria-label={`Reset ${shortcut.label}`}
            title="Reset to default"
            onClick={() => reset(shortcut.id)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}
