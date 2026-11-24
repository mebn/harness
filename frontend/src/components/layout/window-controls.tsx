import { Minus, Square, X } from "lucide-react";
import { Window } from "@wailsio/runtime";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";

/** Width reserved at the top-right for the controls (Windows/Linux only). */
export const WINDOW_CONTROLS_WIDTH = 138;

/** The OS, from the server once connected and from the browser before that (startup screen). */
function useIsMac() {
  return useApp((s) => (s.system.os ? s.system.os === "darwin" : /Mac/i.test(navigator.userAgent)));
}

/** True when the app draws its own min/max/close buttons (frameless window). */
export function useCustomTitleBar() {
  return !useIsMac();
}

/** True on macOS, where the traffic lights sit over the top-left corner. */
export function useMacTitleBar() {
  return useIsMac();
}

export const dragStyle = { "--wails-draggable": "drag" } as React.CSSProperties;
export const noDragStyle = { "--wails-draggable": "no-drag" } as React.CSSProperties;

/** Double-clicking empty title bar space maximizes or restores the window, like a native one. */
export function onTitleBarDoubleClick(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest("button, a, input, textarea, [role=button], [role=menu]")) return;
  void Window.ToggleMaximise();
}

export function WindowControls() {
  if (!useCustomTitleBar()) return null;
  return (
    <div className="fixed top-0 right-0 z-50 flex h-11" style={noDragStyle}>
      <ControlButton label="Minimize" onClick={() => void Window.Minimise()}>
        <Minus className="size-4" />
      </ControlButton>
      <ControlButton label="Maximize" onClick={() => void Window.ToggleMaximise()}>
        <Square className="size-3" />
      </ControlButton>
      <ControlButton label="Close" onClick={() => void Window.Close()} danger>
        <X className="size-4" />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex w-[46px] items-center justify-center text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        danger && "hover:bg-red-600 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
