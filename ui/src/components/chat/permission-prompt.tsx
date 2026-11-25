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
    <div className="mb-2 rounded-xl border border-amber-500/40 bg-card shadow-sm" role="dialog" aria-label="The agent needs your input">
      {items.length > 1 && <p className="px-4 pt-2 text-[11px] text-muted-foreground">1 of {items.length} waiting</p>}
      {req.elicitation ? (
        <ElicitationPrompt key={req.id} req={req} onAnswer={answer} />
      ) : req.toolName === "AskUserQuestion" ? (
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
      {req.feedback && (
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
      )}
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
    case "Shell":
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
        <Button size="sm" variant="secondary" onClick={() => onAnswer({ allow: true, mode: "auto" })}>
          Auto mode
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAnswer({ allow: true, mode: "ask" })}>
          Manual mode
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

/** One field of an MCP elicitation form (a flat JSON Schema property). */
type FieldSchema = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title?: string }[] };
};

type Choice = { value: string; label: string };

function choicesOf(f: FieldSchema): Choice[] | null {
  if (f.oneOf) return f.oneOf.map((o) => ({ value: o.const, label: o.title ?? o.const }));
  if (f.enum) return f.enum.map((v, i) => ({ value: v, label: f.enumNames?.[i] ?? v }));
  return null;
}

function multiChoicesOf(f: FieldSchema): Choice[] | null {
  if (f.type !== "array" || !f.items) return null;
  if (f.items.anyOf) return f.items.anyOf.map((o) => ({ value: o.const, label: o.title ?? o.const }));
  if (f.items.enum) return f.items.enum.map((v) => ({ value: v, label: v }));
  return null;
}

/** An MCP server asking for input: a short form, or a link to open. */
function ElicitationPrompt({ req, onAnswer }: PromptProps) {
  const e = req.elicitation!;
  const schema = useMemo(() => {
    try {
      return JSON.parse(e.schema || "{}") as { properties?: Record<string, FieldSchema>; required?: string[] };
    } catch {
      return {};
    }
  }, [e.schema]);
  const props = schema.properties ?? {};
  const keys = (e.order?.length ? e.order : Object.keys(props)).filter((k) => props[k]);
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(keys.filter((k) => props[k].default !== undefined).map((k) => [k, props[k].default])),
  );
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));

  const missing = keys.some((k) => {
    if (!required.has(k)) return false;
    const v = values[k];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
  const submit = () => {
    const content: Record<string, unknown> = {};
    for (const k of keys) {
      const v = values[k];
      if (v === undefined || v === "") continue;
      const t = props[k].type;
      content[k] = t === "number" || t === "integer" ? Number(v) : v;
    }
    onAnswer({ allow: true, content });
  };

  const header = (
    <div className="mb-2 flex items-start gap-2">
      <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{req.title || `${e.server} needs your input`}</p>
        {req.description && <p className="text-xs text-muted-foreground">{req.description}</p>}
        {e.message && <p className="mt-1 whitespace-pre-wrap select-text">{e.message}</p>}
      </div>
    </div>
  );
  const refuse = (
    <>
      <Button size="sm" variant="ghost" onClick={() => onAnswer({ allow: false })} title="Tell the server no">
        Decline
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onAnswer({ allow: false, interrupt: true })} title="Dismiss without answering">
        Cancel
      </Button>
    </>
  );

  if (e.mode === "url") {
    return (
      <div className="p-3">
        {header}
        <p className="truncate rounded-md bg-muted/50 p-2 font-mono text-[11px] select-text" title={e.url}>
          {e.url}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" asChild>
            <a href={e.url} target="_blank" rel="noreferrer" onClick={() => onAnswer({ allow: true })}>
              Open link
            </a>
          </Button>
          {refuse}
        </div>
      </div>
    );
  }

  const input = "rounded-md border bg-transparent px-2 py-1 text-sm outline-none select-text focus:border-ring";
  return (
    <form
      className="p-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!missing) submit();
      }}
    >
      {header}
      <div className="grid gap-3">
        {keys.map((k) => {
          const f = props[k];
          const label = (
            <span className="text-xs font-medium">
              {f.title ?? k}
              {required.has(k) && <span className="text-destructive"> *</span>}
            </span>
          );
          const hint = f.description && <span className="text-[11px] text-muted-foreground">{f.description}</span>;
          const choices = choicesOf(f);
          const multi = multiChoicesOf(f);
          if (f.type === "boolean") {
            return (
              <label key={k} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={values[k] === true} onChange={(ev) => set(k, ev.target.checked)} />
                <span className="grid">
                  {label}
                  {hint}
                </span>
              </label>
            );
          }
          if (choices || multi) {
            const list = (choices ?? multi)!;
            const cur = values[k];
            const on = (v: string) => (multi ? Array.isArray(cur) && cur.includes(v) : cur === v);
            const toggle = (v: string) => {
              if (!multi) return set(k, v);
              const arr = Array.isArray(cur) ? (cur as string[]) : [];
              set(k, arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
            };
            return (
              <div key={k} className="grid gap-1">
                {label}
                {hint}
                <div className="flex flex-wrap gap-1.5">
                  {list.map((c) => (
                    <button
                      type="button"
                      key={c.value}
                      onClick={() => toggle(c.value)}
                      className={cn("rounded-lg border px-2.5 py-1 text-sm hover:bg-accent/60", on(c.value) && "border-ring bg-accent ring-1 ring-ring/40")}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          const numeric = f.type === "number" || f.type === "integer";
          const type = numeric ? "number" : f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : f.format === "date-time" ? "datetime-local" : "text";
          return (
            <label key={k} className="grid gap-1">
              {label}
              {hint}
              <input
                type={type}
                className={input}
                value={values[k] === undefined ? "" : String(values[k])}
                min={f.minimum}
                max={f.maximum}
                step={f.type === "integer" ? 1 : "any"}
                onChange={(ev) => set(k, ev.target.value)}
              />
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={missing}>
          Submit
        </Button>
        {refuse}
      </div>
    </form>
  );
}
