import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Keyboard, LayoutGrid, Minus, Monitor, Moon, Palette, Plus, RotateCcw, Server, Sun, Type, type LucideIcon } from "lucide-react";
import { KIND_META, TabIcon } from "@/components/workspace/tab-meta";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { FONT_META, fontSize, useSettings } from "@/stores/settings-store";
import { useTheme, type ThemePref } from "@/stores/theme-store";

type Category = { id: string; label: string; icon: LucideIcon; description: string; render: () => ReactNode };

const CATEGORIES: Category[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    description: "How Harness looks. The window is translucent and picks up what is behind it.",
    render: () => <Appearance />,
  },
  {
    id: "text",
    label: "Text size",
    icon: Type,
    description: `Text size for each kind of tab. ${isMac ? "⌘" : "Ctrl"} + / − / 0 changes it for the tab you are in.`,
    render: () => <TextSizes />,
  },
  {
    id: "windows",
    label: "Windows",
    icon: LayoutGrid,
    description:
      "Where a new window goes when you open one (Ctrl/⌘+Enter) or move a tab into another group. Splitting by hand always splits the window you choose.",
    render: () => <SplitStrategyPicker />,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: Keyboard,
    description:
      "Click a shortcut to record a new one. Esc cancels, Backspace removes it. Changes apply immediately and are saved on this device.",
    render: () => <ShortcutsTable />,
  },
  {
    id: "server",
    label: "Server",
    icon: Server,
    description: "The background server owns your workspaces, chats and terminals, and keeps them running when the window is closed.",
    render: () => <ServerInfo />,
  },
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
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b px-6 pt-5 pb-4">
            <h2 className="text-base font-semibold">{category.label}</h2>
            <DialogDescription className="mt-1 text-xs">{category.description}</DialogDescription>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{category.render()}</div>
        </section>
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
    <Row label="Theme" hint="System follows your OS setting.">
      <ThemeToggle />
    </Row>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function ThemeToggle() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  return (
    <div role="radiogroup" className="flex rounded-lg bg-muted p-0.5">
      {THEMES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="radio"
          aria-checked={pref === id}
          onClick={() => setPref(id)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground",
            pref === id && "bg-background text-foreground shadow-sm",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- text size ----

function TextSizes() {
  const sizes = useSettings((s) => s.fontSizes);
  const setFontSize = useSettings((s) => s.setFontSize);
  const reset = useSettings((s) => s.resetFontSize);
  const anyChanged = Object.keys(sizes).length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={!anyChanged} onClick={() => reset()}>
          <RotateCcw /> Reset all
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border">
        {TAB_KINDS.map((kind, i) => {
          const meta = FONT_META[kind];
          const value = fontSize(kind, sizes);
          const changed = sizes[kind] !== undefined;
          return (
            <div key={kind} className={cn("flex items-center gap-3 px-3 py-2", i > 0 && "border-t", i % 2 === 1 && "bg-muted/70 dark:bg-muted/50")}>
              <TabIcon kind={kind} className="size-4 text-muted-foreground" />
              <div className="flex-1">
                <div className="text-sm">{KIND_META[kind].label}</div>
                <div className="text-xs text-muted-foreground">
                  {kind === "browser" ? "Page zoom" : "Font size"} · default {meta.def}
                  {meta.unit}
                </div>
              </div>
              <div className="flex items-center rounded-md border bg-background/60">
                <button
                  aria-label={`Smaller ${KIND_META[kind].label} text`}
                  disabled={value <= meta.min}
                  onClick={() => setFontSize(kind, value - meta.step)}
                  className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <Minus className="size-3.5" />
                </button>
                <span className={cn("w-14 text-center text-sm tabular-nums", changed && "font-semibold")}>
                  {value}
                  {meta.unit}
                </span>
                <button
                  aria-label={`Larger ${KIND_META[kind].label} text`}
                  disabled={value >= meta.max}
                  onClick={() => setFontSize(kind, value + meta.step)}
                  className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              <button
                aria-label={`Reset ${KIND_META[kind].label} text size`}
                title="Reset to default"
                onClick={() => reset(kind)}
                className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", !changed && "invisible")}
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
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
  );
}

// ---- server ----

function ServerInfo() {
  const system = useApp((s) => s.system);
  return (
    <>
      <Row label="Connected to" hint="Servers on other machines are not supported yet.">
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
    </>
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
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={!anyCustom} onClick={() => reset()}>
          <RotateCcw /> Reset all to defaults
        </Button>
      </div>
      <table className="w-full overflow-hidden rounded-lg border text-sm">
        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Shortcut</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section}>
              <tr className="border-t">
                <td colSpan={3} className="bg-muted/30 px-3 pt-3 pb-1.5 text-xs font-semibold text-muted-foreground">
                  {section}
                </td>
              </tr>
              {SHORTCUTS.filter((s) => s.section === section).map((s, i) => (
                <ShortcutRow
                  key={s.id}
                  shortcut={s}
                  striped={i % 2 === 1}
                  recording={recording === s.id}
                  onRecord={(on) => setRecording(on ? s.id : null)}
                />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShortcutRow({
  shortcut,
  striped,
  recording,
  onRecord,
}: {
  shortcut: Shortcut;
  /** Alternate rows are tinted, restarting in each section. */
  striped: boolean;
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
    <tr className={cn("border-t", striped && "bg-muted/70 dark:bg-muted/50")}>
      <td className="px-3 py-1.5">
        <div>{shortcut.label}</div>
        {conflicts.length > 0 && (
          <div className="text-xs text-amber-600 dark:text-amber-400">Also used by {conflicts.map((c) => c.label).join(", ")}</div>
        )}
      </td>
      <td className="px-3 py-1.5">
        <button
          onClick={() => onRecord(!recording)}
          title="Click to change"
          className={cn(
            "inline-flex h-7 min-w-24 items-center rounded-md border bg-background/60 px-2 font-mono text-xs hover:border-ring",
            recording && "border-ring ring-2 ring-ring/30",
            !shown && !recording && "text-muted-foreground",
            custom && !recording && "font-semibold",
          )}
        >
          {recording ? (shortcut.numbered ? "Press modifiers + a digit…" : "Press keys…") : shown || "Not set"}
        </button>
      </td>
      <td className="px-2 py-1.5 text-right">
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
      </td>
    </tr>
  );
}
