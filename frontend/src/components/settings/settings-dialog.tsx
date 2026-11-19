import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTheme, type ThemePref } from "@/stores/theme-store";

const THEMES: { id: ThemePref; label: string; icon: LucideIcon }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function SettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Row label="Theme">
          <ThemeToggle />
        </Row>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm">{label}</span>
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
