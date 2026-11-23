/**
 * Fuzzy path matching for the file finder, in the spirit of VS Code's quick open: the query's
 * characters must appear in order; matches in the file name, at word starts and in runs score
 * higher. Returns null for no match, else a score (higher is better) and the matched indices.
 */
export function fuzzyMatch(path: string, query: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase().replace(/\\/g, "/");
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;

  // Prefer a match that lies entirely in the file name when there is one.
  const inName = matchFrom(lower, q, nameStart);
  const indices = inName ?? matchFrom(lower, q, 0);
  if (!indices) return null;

  let score = 0;
  let prev = -2;
  for (const i of indices) {
    let s = 1;
    if (i === prev + 1) s += 5; // consecutive run
    const before = path[i - 1];
    if (i === 0 || i === nameStart || before === "/" || before === "_" || before === "-" || before === ".") s += 8;
    else if (path[i] !== lower[i] && before === before?.toLowerCase()) s += 6; // camelCase hump
    if (i >= nameStart) s += 3;
    score += s;
    prev = i;
  }
  // Tighter matches and shorter paths win ties.
  score -= (indices[indices.length - 1] - indices[0]) * 0.1;
  score -= path.length * 0.01;
  if (inName && lower.slice(nameStart).startsWith(q)) score += 20;
  return { score, indices };
}

/** Greedy left-to-right match of q in s starting at `from`, with a backward pass to tighten it. */
function matchFrom(s: string, q: string, from: number): number[] | null {
  const out: number[] = [];
  let j = from;
  for (const ch of q) {
    j = s.indexOf(ch, j);
    if (j === -1) return null;
    out.push(j++);
  }
  // Walk back from the end so the match hugs its last character (fewer gaps).
  for (let k = out.length - 2; k >= 0; k--) {
    const last = s.lastIndexOf(q[k], out[k + 1] - 1);
    if (last > out[k]) out[k] = last;
  }
  return out;
}

/** Splits text into runs for highlighting the matched characters. */
export function highlightRuns(text: string, indices: number[], offset = 0): { text: string; hit: boolean }[] {
  const hits = new Set(indices.map((i) => i - offset));
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
