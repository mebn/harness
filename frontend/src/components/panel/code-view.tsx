import { useEffect, useState } from "react";
import { highlight } from "@/lib/highlight";

/** Read-only code viewer with VS Code syntax colors and line numbers. */
export function CodeView({ path, code }: { path: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);

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
    return <div className="code-view min-h-0 flex-1 overflow-auto select-text" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // Plain fallback (unknown language, too large, or still loading) with the same layout.
  return (
    <div className="code-view min-h-0 flex-1 overflow-auto select-text">
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
