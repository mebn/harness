import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MAC_TITLE_BAR_HEIGHT,
  WindowControls,
  dragStyle,
  noDragStyle,
  onTitleBarDoubleClick,
  useMacTitleBar,
} from "@/components/layout/window-controls";

/** Where the window (or, in a browser, the server) says whether the server is reachable. */
const CONNECTION_PATH = "/harness/connection";

/** Automatic retries after a failure, then only the Retry button. */
const RETRY_DELAYS = [2000, 5000, 10000];

type Connection = { connected: boolean; error?: string; logPath?: string };
type State = { phase: "connecting" } | { phase: "failed"; error: string; logPath?: string };

async function checkServer(): Promise<Connection> {
  try {
    const res = await fetch(CONNECTION_PATH, { cache: "no-store" });
    if (!res.ok) return { connected: false, error: `${res.status} ${res.statusText}` };
    return (await res.json()) as Connection;
  } catch (e) {
    return { connected: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Connects to the background server (the window starts it when needed), then loads the app.
 * Until that works it shows progress, or the reason it failed with a way to retry, instead
 * of an empty window.
 */
export function useStartup(load: () => Promise<void>) {
  const [state, setState] = useState<State>({ phase: "connecting" });
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);

  const connect = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      clearTimeout(timer.current);
      if (manual) attempt.current = 0;
      setState({ phase: "connecting" });
      let failure: Omit<Extract<State, { phase: "failed" }>, "phase"> | null = null;
      const res = await checkServer();
      if (!res.connected) failure = { error: res.error || "The server did not answer.", logPath: res.logPath };
      else {
        try {
          await load();
        } catch (e) {
          failure = { error: errorText(e) };
        }
      }
      busy.current = false;
      if (!failure) return;
      setState({ phase: "failed", ...failure });
      const delay = RETRY_DELAYS[attempt.current++];
      if (delay !== undefined) timer.current = setTimeout(() => void connect(false), delay);
    },
    [load],
  );

  useEffect(() => {
    void connect(false);
    return () => clearTimeout(timer.current);
  }, [connect]);

  return { state, retry: () => void connect(true) };
}

export function StartupScreen({ state, onRetry }: { state: State; onRetry: () => void }) {
  // A quick connection shouldn't flash a spinner.
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowSpinner(true), 400);
    return () => clearTimeout(t);
  }, []);

  const isMac = useMacTitleBar();
  return (
    <div className="app-backdrop flex h-full flex-col">
      <div
        className="h-11 shrink-0"
        style={{ ...dragStyle, height: isMac ? MAC_TITLE_BAR_HEIGHT : undefined }}
        onDoubleClick={onTitleBarDoubleClick}
      />
      <WindowControls />
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        {state.phase === "connecting" ? (
          showSpinner && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Starting Harness…
            </div>
          )
        ) : (
          <div className="flex w-full max-w-lg flex-col gap-3 rounded-xl border bg-background p-6 shadow-sm" style={noDragStyle}>
            <div className="flex items-center gap-2 font-medium">
              <ServerCrash className="size-5 text-destructive" />
              Couldn't connect to the Harness server
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap select-text">
              {state.error}
            </pre>
            {state.logPath && (
              <p className="text-xs text-muted-foreground">
                Server log: <span className="font-mono select-text">{state.logPath}</span>
              </p>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={onRetry}>
                <RotateCcw /> Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
