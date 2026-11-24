export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Above this many lines on a side, show removed then added lines instead of diffing. */
const MAX_LINES = 1500;

/** A line diff of two texts (longest common subsequence), for showing an edit. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  // Common prefix and suffix first: edits are usually small changes in a bigger block.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j]: length of the LCS of midA[i:] and midB[j:]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i] });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ kind: "add", text: midB[j++] });
    } else {
      out.push({ kind: "del", text: midA[i++] });
    }
  }
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}

/** Keeps changed lines with a few lines of context around them; "…" marks a gap. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  let skipped = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped && out.length > 0) out.push(null);
      skipped = false;
      out.push(l);
    } else {
      skipped = true;
    }
  });
  return out;
}
