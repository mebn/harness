import type { HighlighterGeneric } from "shiki";

/** Files larger than this are shown as plain text to keep the UI responsive. */
const MAX_HIGHLIGHT_CHARS = 200_000;

// VS Code's default themes, so colors match the editor exactly.
const THEMES = { light: "light-plus", dark: "dark-plus" } as const;

const FILENAME_LANGS: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".gitignore": "ini",
  ".env": "dotenv",
  "go.mod": "go",
  "go.sum": "txt",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let highlighter: Promise<HighlighterGeneric<any, any>> | null = null;
let langIndex: Promise<Map<string, string>> | null = null;

// Shiki is imported on first use so it stays out of the startup bundle.
function getHighlighter() {
  highlighter ??= import("shiki").then((s) => s.createHighlighter({ themes: Object.values(THEMES), langs: [] }));
  return highlighter;
}

/** Maps every language id and alias (e.g. "ts", "yml", "md") to its id. */
function getLangIndex() {
  langIndex ??= import("shiki").then((s) => {
    const index = new Map<string, string>();
    for (const info of s.bundledLanguagesInfo) {
      index.set(info.id, info.id);
      for (const alias of info.aliases ?? []) index.set(alias, info.id);
    }
    return index;
  });
  return langIndex;
}

async function langFor(path: string): Promise<string | null> {
  const name = path.split("/").pop()!.toLowerCase();
  if (FILENAME_LANGS[name]) return FILENAME_LANGS[name];
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  return (await getLangIndex()).get(ext) ?? null;
}

/**
 * Highlights `code` for the file at `path`. Returns HTML whose spans carry both
 * light and dark colors as CSS variables (see `.shiki` rules in index.css),
 * or null when the language is unknown or the file is too large.
 */
export async function highlight(code: string, path: string): Promise<string | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const lang = await langFor(path);
  if (!lang || lang === "txt") return null;
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang as never);
  return hl.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
}
