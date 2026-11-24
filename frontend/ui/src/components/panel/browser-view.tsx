import { useState } from "react";
import { Globe, RotateCw } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";

function normalize(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?/i.test(v)) return `http://${v}`;
  return `https://${v}`;
}

/** Minimal embedded browser, mainly for previewing local dev servers. */
export function BrowserView({ initialUrl = "", onNavigate }: { initialUrl?: string; onNavigate: (url: string) => void }) {
  const [input, setInput] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const [nonce, setNonce] = useState(0);

  const go = () => {
    const next = normalize(input);
    setInput(next);
    setUrl(next);
    setNonce((n) => n + 1);
    onNavigate(next);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 px-2 pb-1">
        <IconButton label="Reload" onClick={() => setNonce((n) => n + 1)} disabled={!url}>
          <RotateCw />
        </IconButton>
        <input
          value={input}
          placeholder="localhost:3000"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          onFocus={(e) => e.target.select()}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md bg-muted/60 px-2 font-mono text-xs outline-none select-text placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring"
        />
      </div>
      {url ? (
        <iframe key={nonce} src={url} title="Browser" className="min-h-0 flex-1 border-t bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground/40">
          <Globe className="size-8" />
        </div>
      )}
    </div>
  );
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
