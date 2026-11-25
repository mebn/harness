import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowUpCircle, Copy, LogIn, RefreshCw, X } from "lucide-react";
import { ProviderLogo } from "@/components/common/provider-logo";
import { TERMINAL_THEMES, decode } from "@/components/panel/terminal-view";
import { Button } from "@/components/ui/button";
import { AgentService, Browser, Events, TerminalService, type AgentInstall, type NewChatDefaults } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useTheme } from "@/stores/theme-store";
import { List, Row, Section } from "./parts";

export function AgentsSettings() {
  return (
    <>
      <NewChatDefaultsSection />
      <InstallsSection />
    </>
  );
}

// ---- defaults for new chats ----

const SAME_AS_LAST = "";

function NewChatDefaultsSection() {
  const providers = useApp((s) => s.providers);
  const [defaults, setDefaults] = useState<NewChatDefaults | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    AgentService.NewChatDefaults()
      .then(setDefaults)
      .catch((e) => setProblem(String(e)));
  }, []);

  const save = (next: NewChatDefaults) => {
    setProblem(null);
    setDefaults(next);
    AgentService.SetNewChatDefaults(next)
      .then(setDefaults)
      .catch((e) => setProblem(String(e)));
  };

  const provider = providers.find((p) => p.id === defaults?.provider);
  const modelValue = defaults?.provider ? `${defaults.provider}:${defaults.model}` : SAME_AS_LAST;

  return (
    <Section title="New chats">
      <List>
        <Row label="Model">
          <select
            value={modelValue}
            disabled={!defaults}
            onChange={(e) => {
              const v = e.target.value;
              if (v === SAME_AS_LAST) return save({ provider: "", model: "", effort: "" });
              const [pid, ...rest] = v.split(":");
              const p = providers.find((x) => x.id === pid);
              const keepEffort = p?.efforts?.some((o) => o.id === defaults?.effort);
              save({ provider: pid, model: rest.join(":"), effort: keepEffort ? defaults!.effort : (p?.defaultEffort ?? "") });
            }}
            className={SELECT}
          >
            <option value={SAME_AS_LAST}>Same as the last chat</option>
            {providers.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {(p.models ?? []).map((m) => (
                  <option key={m.id} value={`${p.id}:${m.id}`}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Row>
        <Row label="Reasoning effort">
          <select
            value={defaults?.effort ?? ""}
            disabled={!provider}
            onChange={(e) => defaults && save({ ...defaults, effort: e.target.value })}
            className={SELECT}
          >
            {!provider && <option value="">Same as the last chat</option>}
            {(provider?.efforts ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      </List>
      <p className="text-xs text-muted-foreground">
        {provider
          ? "New chats start with this model and effort. You can still change them in each chat."
          : "New chats start with the model and effort of the chat you used last."}
      </p>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </Section>
  );
}

const SELECT =
  "h-7 max-w-56 rounded-md border bg-background/60 px-2 text-xs outline-none hover:border-ring focus:border-ring disabled:opacity-50";

// ---- installed CLIs ----

/** How to install each CLI where it's missing. */
function installHint(tool: string, env: string, place: string): string {
  const windows = env === "native" && place === "Windows";
  switch (tool) {
    case "claude":
      return windows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
    case "codex":
      return "npm install -g @openai/codex";
    case "copilot":
      return "npm install -g @github/copilot";
  }
  return "";
}

type Action = { tool: string; env: string; action: "update" | "login"; label: string };

function actionKey(a: { tool: string; env: string }) {
  return `${a.tool}:${a.env}`;
}

function InstallsSection() {
  const [installs, setInstalls] = useState<AgentInstall[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState<Action | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setProblem(null);
    AgentService.Installs()
      .then((list) => setInstalls(list ?? []))
      .catch((e) => setProblem(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  // One card per CLI, in the order the server lists them.
  const tools = [...new Map((installs ?? []).map((i) => [i.tool, i.name])).entries()];

  return (
    <Section
      title="Agent CLIs"
      action={
        <Button variant="ghost" size="xs" disabled={loading} onClick={refresh}>
          <RefreshCw className={cn(loading && "animate-spin")} /> {loading ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {!installs && !problem && <p className="text-xs text-muted-foreground">Looking for Claude Code, Codex and Copilot…</p>}
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {tools.map(([tool, name]) => (
        <List key={tool}>
          <div className="flex min-h-10 items-center gap-2 bg-muted/40 px-3 text-sm font-medium">
            <ProviderLogo id={tool} className="size-4" />
            {name}
          </div>
          {installs!
            .filter((i) => i.tool === tool)
            .map((i) => (
              <InstallRow
                key={actionKey(i)}
                install={i}
                busy={!!running}
                running={running && actionKey(running) === actionKey(i) ? running : null}
                onRun={(action) =>
                  setRunning({
                    tool: i.tool,
                    env: i.env,
                    action,
                    label: `${action === "update" ? "Updating" : "Signing in to"} ${i.name} (${i.place})`,
                  })
                }
                onDone={() => {
                  setRunning(null);
                  refresh();
                }}
              />
            ))}
        </List>
      ))}
      {installs && (
        <p className="text-xs text-muted-foreground">
          Chats in Windows folders use the Windows install; chats in WSL folders use the one in WSL.
        </p>
      )}
    </Section>
  );
}

function InstallRow({
  install: i,
  busy,
  running,
  onRun,
  onDone,
}: {
  install: AgentInstall;
  busy: boolean;
  running: Action | null;
  onRun: (action: "update" | "login") => void;
  onDone: () => void;
}) {
  const hint = installHint(i.tool, i.env, i.place);
  return (
    <div>
      <div className="flex min-h-12 items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            {i.place}
            {i.installed && i.version && <span className="text-xs text-muted-foreground tabular-nums">v{i.version}</span>}
            {i.latest && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">v{i.latest} available</span>
            )}
          </div>
          {i.error ? (
            <div className="text-xs text-amber-600 dark:text-amber-400">{i.error}</div>
          ) : i.installed ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <SignInState install={i} />
              <span className="truncate font-mono text-[11px] opacity-70" title={i.path}>
                {i.path}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0">Not installed.</span>
              {hint && <CopyCommand command={hint} />}
            </div>
          )}
        </div>
        {i.installed && !i.error && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant={i.signedIn === "no" ? "default" : "outline"}
              size="xs"
              disabled={busy}
              onClick={() => onRun("login")}
            >
              <LogIn /> {i.signedIn === "yes" ? "Sign in again" : "Sign in"}
            </Button>
            <Button variant="outline" size="xs" disabled={busy} onClick={() => onRun("update")}>
              <ArrowUpCircle /> Update
            </Button>
          </div>
        )}
      </div>
      {running && <CommandTerminal action={running} onClose={onDone} />}
    </div>
  );
}

function SignInState({ install: i }: { install: AgentInstall }) {
  if (i.signedIn === "yes")
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Signed in{i.account && ` · ${i.account}`}
      </span>
    );
  if (i.signedIn === "no")
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" />
        Not signed in
      </span>
    );
  return null;
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the install command"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:text-foreground"
    >
      <span className="truncate">{copied ? "Copied" : command}</span>
      <Copy className="size-3 shrink-0" />
    </button>
  );
}

// ---- the terminal an update or sign-in runs in ----

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** Runs a CLI's update or sign-in in a small terminal, so prompts and device codes can be answered. */
function CommandTerminal({ action, onClose }: { action: Action; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const idRef = useRef("");
  const [exited, setExited] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: TERMINAL_THEMES[useTheme.getState().theme],
      allowTransparency: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();

    // Sign-in flows print links; open them in the browser on click.
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const found: ILink[] = [];
        for (const m of line.matchAll(URL_RE)) {
          const url = m[0].replace(/[.,)]+$/, "");
          const x = (m.index ?? 0) + 1;
          found.push({
            range: { start: { x, y }, end: { x: x + url.length - 1, y } },
            text: url,
            activate: () => void Browser.OpenURL(url),
          });
        }
        callback(found);
      },
    });

    let disposed = false;
    const early: { id: string; data: string }[] = [];
    const cleanups: Array<() => void> = [
      () => links.dispose(),
      Events.On("term:data", (e) => {
        if (!idRef.current) early.push(e.data);
        else if (e.data.id === idRef.current) term.write(decode(e.data.data));
      }),
      Events.On("term:exit", (e) => {
        if (e.data.id !== idRef.current) return;
        term.write("\r\n\x1b[2m[done]\x1b[0m\r\n");
        setExited(true);
      }),
    ];

    const start = setTimeout(() => {
      if (disposed) return;
      AgentService.Run(action.tool, action.env, action.action, term.cols, term.rows)
        .then((id) => {
          if (disposed) return void TerminalService.Close(id);
          idRef.current = id;
          early.filter((c) => c.id === id).forEach((c) => term.write(decode(c.data)));
          early.length = 0;
          const input = term.onData((d) => void TerminalService.Write(id, d));
          const resize = term.onResize(({ cols, rows }) => void TerminalService.Resize(id, cols, rows));
          cleanups.push(() => input.dispose(), () => resize.dispose());
          term.focus();
        })
        .catch((err) => {
          term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
          setExited(true);
        });
    }, 0);

    const observer = new ResizeObserver(() => {
      if (container.current?.offsetWidth) fit.fit();
    });
    observer.observe(container.current);

    return () => {
      disposed = true;
      clearTimeout(start);
      observer.disconnect();
      cleanups.forEach((c) => c());
      if (idRef.current) void TerminalService.Close(idRef.current);
      term.dispose();
    };
  }, [action]);

  return (
    <div className="border-t bg-muted/30">
      <div className="flex h-8 items-center justify-between gap-2 px-3 text-xs text-muted-foreground">
        <span className="truncate">
          {action.label}
          {!exited && "…"}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={exited ? "Close" : "Stop and close"}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" /> {exited ? "Close" : "Stop"}
        </button>
      </div>
      <div className="terminal-host h-56 px-3 pb-2">
        <div ref={container} className="h-full w-full" />
      </div>
    </div>
  );
}
