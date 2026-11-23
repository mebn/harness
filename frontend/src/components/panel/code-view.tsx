import { useEffect, useRef, useState } from "react";
import { highlight } from "@/lib/highlight";

/**
 * Read-only code viewer with VS Code syntax colors and line numbers. With `line`, it scrolls
 * to and marks that line once rendered, and again whenever `reveals` changes.
 */
export function CodeView({ path, code, line, reveals = 0 }: { path: string; code: string; line?: number; reveals?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const revealed = useRef("");

  // Scroll to the line once per request (not on every content refresh). The plain fallback
  // renders first, so this runs again when highlighting lands.
  useEffect(() => {
    const el = box.current;
    if (!el || !line) return;
    const lines = el.querySelectorAll<HTMLElement>(".line");
    const target = lines[line - 1];
    if (!target) return;
    el.querySelectorAll(".line-hit").forEach((x) => x.classList.remove("line-hit"));
    target.classList.add("line-hit");
    const key = `${line}:${reveals}:${html ? "hl" : "plain"}`;
    if (revealed.current === key) return;
    revealed.current = key;
    target.scrollIntoView({ block: "center" });
  });

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    highlight(code, path)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [code, path]);

  if (html) {
    // Output comes from Shiki, which escapes the source text.
    return <div ref={box} className="code-view min-h-0 flex-1 overflow-auto select-text" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // Plain fallback (unknown language, too large, or still loading) with the same layout.
  return (
    <div ref={box} className="code-view min-h-0 flex-1 overflow-auto select-text">
      <pre className="shiki">
        <code>
          {code.split("\n").map((line, i) => (
            <span key={i} className="line">
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
