import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronRight, Circle, CircleDot } from "lucide-react";
import { PreviewableImage } from "@/components/common/image-preview";
import type { Part } from "@/lib/backend";
import { lineDiff, withContext } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];

/** Tools whose result is shown inline without clicking (the change is the point). */
const SHOWN = new Set(["Edit", "MultiEdit", "Write", "TodoWrite", "ExitPlanMode", "AskUserQuestion", "NotebookEdit"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

export function toolArgs(part: Pick<Part, "toolArgs">): Args | null {
  if (!part.toolArgs) return null;
  try {
    return JSON.parse(part.toolArgs);
  } catch {
    return null;
  }
}

/** One tool invocation: a line that expands to its details; edits and to-dos show inline. */
export function ToolCall({ part }: { part: Part }) {
  const args = useMemo(() => toolArgs(part), [part.toolArgs]);
  const name = part.toolName ?? "";
  const inline = SHOWN.has(name) && args !== null && !part.isError;
  const [open, setOpen] = useState(false);
  const hasDetails = !!part.toolOutput || !!args;
  const images = part.images ?? [];

  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground",
          hasDetails && "hover:bg-accent/60",
        )}
      >
        {/* No icons: a running tool pulses, a failed one is red. */}
        <span
          className={cn(
            "shrink-0 font-medium text-foreground/80",
            !part.done && "animate-pulse",
            part.done && part.isError && "text-destructive",
          )}
        >
          {displayName(name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{part.toolInput}</span>
        {hasDetails && <ChevronRight className={cn("size-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")} />}
      </button>
      {inline && !open && <InlineView name={name} args={args} part={part} />}
      {images.length > 0 && (
        <div className="mt-1 ml-2 flex flex-wrap gap-2">
          {images.map((url) => (
            <PreviewableImage key={url} src={url}>
              <img src={url} alt="" className="max-h-48 max-w-xs rounded-md border object-contain" />
            </PreviewableImage>
          ))}
        </div>
      )}
      {open && <Details name={name} args={args} part={part} />}
    </div>
  );
}

export function displayName(name: string): string {
  // mcp__server__tool → server · tool
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/^claude_ai_/, "")} · ${m[2]}` : name;
}

/** What shows under the line without expanding it. */
function InlineView({ name, args, part }: { name: string; args: Args; part: Part }) {
  switch (name) {
    case "Edit":
      return <DiffBlock before={str(args.old_string)} after={str(args.new_string)} />;
    case "MultiEdit":
      return (
        <>
          {(Array.isArray(args.edits) ? args.edits : []).map((e: Args, i: number) => (
            <DiffBlock key={i} before={str(e.old_string)} after={str(e.new_string)} />
          ))}
        </>
      );
    case "NotebookEdit":
      return <DiffBlock before="" after={str(args.new_source)} />;
    case "Write":
      return <DiffBlock before="" after={str(args.content)} />;
    case "TodoWrite":
      return <Todos todos={Array.isArray(args.todos) ? args.todos : []} />;
    case "ExitPlanMode":
      return args.plan ? <PlanView plan={str(args.plan)} /> : null;
    case "AskUserQuestion":
      return part.done && part.toolOutput ? <p className="mt-0.5 ml-2 px-2 text-muted-foreground select-text">{answerText(part.toolOutput)}</p> : null;
  }
  return null;
}

/** Everything about a call: its full input and its output. */
function Details({ name, args, part }: { name: string; args: Args | null; part: Part }) {
  const output = part.toolOutput;
  const outputBlock = output ? (
    <pre className="mt-1 ml-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{output}</pre>
  ) : null;
  if (!args) return outputBlock;
  switch (name) {
    case "Bash":
    case "PowerShell":
    case "Shell":
      return (
        <>
          <pre className="mt-1 ml-2 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
            <span className="text-muted-foreground">$ </span>
            {str(args.command)}
          </pre>
          {outputBlock}
        </>
      );
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "TodoWrite":
    case "ExitPlanMode":
    case "AskUserQuestion":
      return (
        <>
          <InlineView name={name} args={args} part={part} />
          {part.isError && outputBlock}
        </>
      );
  }
  return (
    <>
      <pre className="mt-1 ml-2 max-h-48 overflow-auto rounded-md bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground select-text">
        {JSON.stringify(args, null, 2)}
      </pre>
      {outputBlock}
    </>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const DIFF_PREVIEW = 40;

/** Changed lines with a little context, colored like a diff. */
export function DiffBlock({ before, after }: { before: string; after: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => withContext(lineDiff(before, after)), [before, after]);
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW);
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 ml-2 overflow-hidden rounded-md border font-mono text-[11px]">
      <div className="max-h-[28rem] overflow-auto">
        {shown.map((l, i) =>
          l === null ? (
            <div key={i} className="px-2 text-muted-foreground/60 select-none">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "flex px-2 whitespace-pre-wrap select-text",
                l.kind === "add" && "bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
                l.kind === "del" && "bg-red-500/12 text-red-800 dark:text-red-300",
              )}
            >
              <span className="w-3 shrink-0 opacity-60 select-none">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
              <span className="min-w-0 break-all">{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {lines.length > DIFF_PREVIEW && (
        <button onClick={() => setAll((a) => !a)} className="w-full border-t px-2 py-0.5 text-left text-muted-foreground hover:bg-accent/60">
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

type Todo = { content?: string; activeForm?: string; status?: string };

function Todos({ todos }: { todos: Todo[] }) {
  return (
    <ul className="mt-0.5 ml-2 space-y-0.5 px-2">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          {t.status === "completed" ? (
            <Check className="mt-0.5 size-3 shrink-0 text-emerald-600" />
          ) : t.status === "in_progress" ? (
            <CircleDot className="mt-0.5 size-3 shrink-0 text-sky-500" />
          ) : (
            <Circle className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
          )}
          <span
            className={cn(
              "select-text",
              t.status === "completed" && "text-muted-foreground line-through",
              t.status === "in_progress" && "font-medium text-foreground",
            )}
          >
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PlanView({ plan }: { plan: string }) {
  return (
    <div className="prose-chat mt-1 ml-2 max-h-[32rem] overflow-auto rounded-md border bg-muted/30 px-3 py-2 text-xs select-text">
      <Markdown remarkPlugins={remarkPlugins}>{plan}</Markdown>
    </div>
  );
}

/** The answers in an AskUserQuestion result, without the wrapper text. */
function answerText(output: string): string {
  const m = /answered:\s*([\s\S]*?)(?:\.\s*You can now continue|$)/.exec(output);
  return m ? m[1] : output;
}
