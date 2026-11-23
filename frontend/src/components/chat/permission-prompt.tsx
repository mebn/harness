import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingRequest, PermissionAnswer } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { DiffBlock, PlanView, toolArgs } from "./tool-call";

const EMPTY: PendingRequest[] = [];

/** The oldest request waiting for the user in a chat: a tool to approve, questions, or a plan. */
export function PermissionPrompt({ sessionId }: { sessionId: string }) {
  const items = useApp((s) => s.pending[sessionId] ?? EMPTY);
  const respond = useApp((s) => s.respond);
  const [error, setError] = useState<string | null>(null);
  const req = items[0];
  if (!req) return null;

  const answer = (a: Partial<PermissionAnswer>) => {
    setError(null);
    respond(sessionId, req.id, a).catch((e) => setError(String(e)));
  };

  return (
    <div className="mb-2 rounded-xl border border-amber-500/40 bg-card shadow-sm" role="dialog" aria-label="Claude needs your input">
      {items.length > 1 && <p className="px-4 pt-2 text-[11px] text-muted-foreground">1 of {items.length} waiting</p>}
      {req.toolName === "AskUserQuestion" ? (
        <QuestionsPrompt key={req.id} req={req} onAnswer={answer} />
      ) : req.toolName === "ExitPlanMode" ? (
        <PlanPrompt key={req.id} req={req} onAnswer={answer} />
      ) : (
        <ToolPrompt key={req.id} req={req} onAnswer={answer} />
      )}
      {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

type PromptProps = { req: PendingRequest; onAnswer: (a: Partial<PermissionAnswer>) => void };

function ToolPrompt({ req, onAnswer }: PromptProps) {
  const args = useMemo(() => toolArgs({ toolArgs: req.input }), [req.input]);
  const [feedback, setFeedback] = useState("");
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => allowRef.current?.focus(), [req.id]);

  return (
    <div className="p-3">
      <div className="mb-2 flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{req.title || `Allow ${req.toolName}${req.fromSubagent ? " (from a subagent)" : ""}?`}</p>
          {req.description && <p className="text-xs text-muted-foreground">{req.description}</p>}
          {req.reason && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{req.reason}</p>}
        </div>
      </div>
      <ToolPreview name={req.toolName} args={args} blockedPath={req.blockedPath} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button ref={allowRef} size="sm" onClick={() => onAnswer({ allow: true })}>
          Allow
        </Button>
        {req.canAlways && (
          <Button size="sm" variant="secondary" onClick={() => onAnswer({ allow: true, always: true })} title={req.alwaysLabel}>
            Always allow <span className="max-w-56 truncate font-mono text-[11px] opacity-70">{req.alwaysLabel}</span>
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onAnswer({ allow: false, interrupt: true })} title="Deny and stop the turn">
          Deny
        </Button>
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (feedback.trim()) onAnswer({ allow: false, message: feedback.trim() });
        }}
      >
        <input
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Or deny and tell Claude what to do instead…"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none select-text focus:border-ring"
        />
        {feedback.trim() && (
          <Button size="sm" variant="secondary" type="submit">
            Send
          </Button>
        )}
      </form>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ToolPreview({ name, args, blockedPath }: { name: string; args: Record<string, any> | null; blockedPath: string }) {
  if (!args) return null;
  const pre = (text: string) => (
    <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{text}</pre>
  );
  switch (name) {
    case "Bash":
    case "PowerShell":
      return pre(`$ ${args.command ?? ""}`);
    case "Edit":
      return (
        <>
          <p className="font-mono text-[11px] text-muted-foreground">{args.file_path}</p>
          <DiffBlock before={args.old_string ?? ""} after={args.new_string ?? ""} />
        </>
      );
    case "MultiEdit":
      return (
        <>
          <p className="font-mono text-[11px] text-muted-foreground">{args.file_path}</p>
          {(args.edits ?? []).map((e: { old_string?: string; new_string?: string }, i: number) => (
            <DiffBlock key={i} before={e.old_string ?? ""} after={e.new_string ?? ""} />
          ))}
        </>
      );
    case "Write":
      return (
        <>
          <p className="font-mono text-[11px] text-muted-foreground">{args.file_path}</p>
          <DiffBlock before="" after={args.content ?? ""} />
        </>
      );
    case "WebFetch":
      return pre(String(args.url ?? ""));
  }
  return pre(blockedPath ? `${blockedPath}\n\n${JSON.stringify(args, null, 2)}` : JSON.stringify(args, null, 2));
}

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; preview?: string }[];
};

function QuestionsPrompt({ req, onAnswer }: PromptProps) {
  const questions: Question[] = useMemo(() => toolArgs({ toolArgs: req.input })?.questions ?? [], [req.input]);
  // Per question: chosen labels, and free text for "Other".
  const [chosen, setChosen] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const answerFor = (i: number) => {
    const picks = [...(chosen[i] ?? [])];
    if (other[i]?.trim()) picks.push(other[i].trim());
    return picks.join(", ");
  };
  const complete = questions.every((_, i) => answerFor(i) !== "");

  const toggle = (i: number, label: string, multi: boolean) => {
    const cur = chosen[i] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setChosen({ ...chosen, [i]: next });
    if (!multi) setOther({ ...other, [i]: "" });
  };

  return (
    <div className="space-y-4 p-3">
      {questions.map((q, i) => (
        <div key={i}>
          {q.header && <span className="mb-1 inline-block rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase">{q.header}</span>}
          <p className="mb-2 text-sm font-medium select-text">{q.question}</p>
          <div className="grid gap-1.5">
            {(q.options ?? []).map((o) => {
              const on = (chosen[i] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(i, o.label, !!q.multiSelect)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-left text-sm hover:bg-accent/60",
                    on && "border-ring bg-accent ring-1 ring-ring/40",
                  )}
                >
                  <span className="font-medium">{o.label}</span>
                  {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                  {on && o.preview && (
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] whitespace-pre">{o.preview}</pre>
                  )}
                </button>
              );
            })}
            <input
              value={other[i] ?? ""}
              onChange={(e) => {
                setOther({ ...other, [i]: e.target.value });
                if (!q.multiSelect && e.target.value) setChosen({ ...chosen, [i]: [] });
              }}
              placeholder="Other…"
              className="rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none select-text focus:border-ring"
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!complete}
          onClick={() => onAnswer({ allow: true, answers: Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)])) })}
        >
          Submit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer({ allow: false })}>
          Skip
        </Button>
      </div>
    </div>
  );
}

function PlanPrompt({ req, onAnswer }: PromptProps) {
  const plan: string = useMemo(() => toolArgs({ toolArgs: req.input })?.plan ?? "", [req.input]);
  const [feedback, setFeedback] = useState("");
  return (
    <div className="p-3">
      <p className="mb-1 text-sm font-medium">Claude's plan is ready</p>
      {plan && <PlanView plan={plan} />}
      <p className="mt-3 mb-1.5 text-xs text-muted-foreground">Approve and continue with:</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onAnswer({ allow: true, mode: "edits" })}>
          Accept edits
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAnswer({ allow: true, mode: "ask" })}>
          Ask permissions
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAnswer({ allow: true, mode: "full" })}>
          Full access
        </Button>
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer({ allow: false, message: feedback.trim() || undefined });
        }}
      >
        <input
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Or keep planning: tell Claude what to change…"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none select-text focus:border-ring"
        />
        <Button size="sm" variant="ghost" type="submit">
          Keep planning
        </Button>
      </form>
    </div>
  );
}
