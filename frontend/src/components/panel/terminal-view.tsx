import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Events, TerminalService } from "@/lib/backend";
import { useApp, useActiveProject } from "@/stores/app-store";
import { useTheme } from "@/stores/theme-store";

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
 * An interactive shell. The shell starts lazily the first time the tab is shown,
 * in the folder (and Windows/WSL environment) of the project active at that moment.
 */
export function TerminalView({ active }: { active: boolean }) {
  const project = useActiveProject();
  const ready = useApp((s) => s.ready);
  const theme = useTheme((s) => s.theme);
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Latches true the first time the tab is visible; the shell then lives until unmount.
  const [shouldStart, setShouldStart] = useState(false);

  useEffect(() => {
    if (active && ready) setShouldStart(true);
  }, [active, ready]);

  useEffect(() => {
    if (!shouldStart || !container.current) return;

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

    TerminalService.Start(project?.id ?? "", term.cols, term.rows)
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
    // Start once; later project switches don't move an existing shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldStart]);

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
