import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Events, TerminalService } from "@/lib/backend";
import { useTheme } from "@/stores/theme-store";
import { PerSession } from "./per-session";

const THEMES = {
  dark: { background: "#1c1c1c", foreground: "#e5e5e5", cursor: "#e5e5e5", selectionBackground: "#ffffff30" },
  light: {
    background: "#fafafa",
    foreground: "#262626",
    cursor: "#262626",
    cursorAccent: "#fafafa",
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
 * An interactive shell for one session, in its project folder. The backend picks
 * WSL or a native shell from where that folder lives. Starts on mount (PerSession
 * mounts it the first time the session is shown) and lives until unmount.
 */
function SessionTerminal({ projectId, active }: { projectId: string; active: boolean }) {
  const theme = useTheme((s) => s.theme);
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!container.current) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: THEMES[useTheme.getState().theme],
      allowProposedApi: true,
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

    TerminalService.Start(projectId, term.cols, term.rows)
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
    // projectId is fixed for this instance (one terminal per session).
  }, [projectId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return (
    <div className="h-full w-full p-2" style={{ background: THEMES[theme].background }}>
      <div ref={container} className="h-full w-full" />
    </div>
  );
}


/** Terminal tab: each session gets its own shell; switching sessions switches shells. */
export function TerminalView({ active }: { active: boolean }) {
  return (
    <PerSession
      active={active}
      render={(inst, visible) => <SessionTerminal projectId={inst.projectId} active={visible} />}
    />
  );
}