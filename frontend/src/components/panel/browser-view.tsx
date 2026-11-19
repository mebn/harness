import { useState } from "react";
import { Globe, RotateCw } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { cn } from "@/lib/utils";
import { PerSession } from "./per-session";
import { SubTabBar, closeTab } from "./sub-tabs";

function normalize(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?/i.test(v)) return `http://${v}`;
  return `https://${v}`;
}

/** One page: minimal embedded browser, mainly for previewing local dev servers. */
function BrowserPage({ onNavigate }: { onNavigate: (url: string) => void }) {
  const [input, setInput] = useState("");
  const [url, setUrl] = useState("");
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
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
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
        <iframe key={nonce} src={url} title="Browser" className="min-h-0 flex-1 bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground/40">
          <Globe className="size-8" />
        </div>
      )}
    </div>
  );
}


function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

let pageSeq = 0;
const newPage = () => ({ id: `page-${++pageSeq}`, url: "" });

/** Several pages for one session, as sub-tabs. */
function SessionBrowser() {
  const [pages, setPages] = useState(() => [newPage()]);
  const [current, setCurrent] = useState(pages[0].id);

  const add = () => {
    const page = newPage();
    setPages([...pages, page]);
    setCurrent(page.id);
  };

  return (
    <div className="flex h-full flex-col">
      <SubTabBar
        tabs={pages.map((p) => ({
          id: p.id,
          label: p.url ? hostLabel(p.url) : "New tab",
          title: p.url || "New tab",
          icon: <Globe />,
          closable: true,
        }))}
        active={current}
        onSelect={setCurrent}
        onClose={(id) => {
          const next = closeTab(pages, id, current);
          setPages(next.tabs);
          setCurrent(next.active);
        }}
        onAdd={add}
        addLabel="New page"
      />
      <div className="relative min-h-0 flex-1">
        {pages.map((p) => (
          <div key={p.id} className={cn("absolute inset-0", p.id !== current && "invisible")}>
            <BrowserPage onNavigate={(url) => setPages((list) => list.map((x) => (x.id === p.id ? { ...x, url } : x)))} />
          </div>
        ))}
        {pages.length === 0 && (
          <button onClick={add} className="flex h-full w-full items-center justify-center text-xs text-muted-foreground hover:text-foreground">
            New page
          </button>
        )}
      </div>
    </div>
  );
}

/** Browser tab: each session keeps its own pages. */
export function BrowserView({ active }: { active: boolean }) {
  return <PerSession active={active} render={() => <SessionBrowser />} />;
}
