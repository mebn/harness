import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Events, TerminalService } from "@/lib/backend";
import { useTheme } from "@/stores/theme-store";

// Transparent backgrounds let the window card show through.
const THEMES = {
  dark: { background: "#00000000", foreground: "#e5e5e5", cursor: "#e5e5e5", selectionBackground: "#ffffff30" },
  light: {
    background: "#00000000",
    foreground: "#262626",
    cursor: "#262626",
    cursorAccent: "#ffffff",
    selectionBackground: "#00000020",
    yellow: "#a16207",
    brightYellow: "#ca8a04",
    white: "#737373",
    brightWhite: "#404040",
  },
};

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * An interactive shell in a project folder. The backend picks WSL or a native shell
 * from where that folder lives. Starts on mount and lives until unmount.
 */
export function TerminalView({
  projectId,
  worktree = "",
  admin = false,
  active,
  fontSize = 12,
}: {
  projectId: string;
  /** Where the shell starts; a running shell stays put if its group moves to another worktree. */
  worktree?: string;
  /** Runs the shell as administrator (Windows; asks via UAC). Fixed for this instance. */
  admin?: boolean;
  active: boolean;
  fontSize?: number;
}) {
  const startIn = useRef(worktree);
  const theme = useTheme((s) => s.theme);
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!container.current) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize,
      cursorBlink: true,
      theme: THEMES[useTheme.getState().theme],
      allowProposedApi: true,
      allowTransparency: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();

    let id = "";
    let disposed = false;
    // Listen before starting so the shell's first prompt isn't missed; buffer until the id is known.
    const early: { id: string; data: string }[] = [];
    const cleanups: Array<() => void> = [
      Events.On("term:data", (e) => {
        if (!id) early.push(e.data);
        else if (e.data.id === id) term.write(decode(e.data.data));
      }),
      Events.On("term:exit", (e) => e.data.id === id && term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n")),
    ];

    if (admin) term.write("\x1b[2mStarting as administrator — confirm the Windows prompt…\x1b[0m\r\n");
    TerminalService.Start(projectId, startIn.current, admin, term.cols, term.rows)
      .then((tid) => {
        if (disposed) return void TerminalService.Close(tid);
        id = tid;
        early.filter((c) => c.id === id).forEach((c) => term.write(decode(c.data)));
        early.length = 0;
        const input = term.onData((d) => void TerminalService.Write(id, d));
        const resize = term.onResize(({ cols, rows }) => void TerminalService.Resize(id, cols, rows));
        cleanups.push(() => input.dispose(), () => resize.dispose());
      })
      .catch((err) => term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`));

    const observer = new ResizeObserver(() => {
      if (container.current?.offsetWidth) fit.fit();
    });
    observer.observe(container.current);

    return () => {
      disposed = true;
      observer.disconnect();
      cleanups.forEach((c) => c());
      if (id) void TerminalService.Close(id);
      term.dispose();
    };
    // projectId is fixed for this instance.
  }, [projectId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  // Zooming changes the font size; refit so the shell gets the new rows/columns.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return (
    <div className="terminal-host h-full w-full px-3 pt-1 pb-2">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
