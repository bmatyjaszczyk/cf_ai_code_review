// Unified-diff handling: parse GitHub patches, number the lines so the model can
// cite them, know which lines GitHub allows inline comments on, and split the diff
// into chunks that fit in Llama 3.3's context window.

export interface DiffFile {
  path: string;
  status: string; // added | modified | renamed | removed | ...
  patch: string; // hunks only, starting at the first "@@"
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  newLine: number | null;
  text: string;
}

export interface ParsedFile {
  path: string;
  status: string;
  language: string;
  hunks: { header: string; lines: DiffLine[] }[];
  /** New-file line numbers that may carry an inline comment (added + context lines). */
  commentable: Set<number>;
  /** New-file line numbers introduced by this change. */
  added: Set<number>;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parsePatch(file: DiffFile): ParsedFile {
  const parsed: ParsedFile = {
    path: file.path,
    status: file.status,
    language: detectLanguage(file.path),
    hunks: [],
    commentable: new Set(),
    added: new Set()
  };
  let newLine = 0;
  let current: ParsedFile["hunks"][number] | null = null;

  for (const raw of file.patch.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      newLine = Number(m[1]);
      current = { header: raw, lines: [] };
      parsed.hunks.push(current);
      continue;
    }
    if (!current || raw.startsWith("\\ No newline")) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", newLine, text });
      parsed.commentable.add(newLine);
      parsed.added.add(newLine);
      newLine++;
    } else if (marker === "-") {
      current.lines.push({ kind: "del", newLine: null, text });
    } else if (marker === " " || raw === "") {
      current.lines.push({ kind: "ctx", newLine, text });
      parsed.commentable.add(newLine);
      newLine++;
    }
  }
  return parsed;
}

/**
 * Render a file the way the model sees it. Each line has its new-file line number,
 * so findings can cite exact lines. Removed lines get no number because they can't
 * be commented on.
 *
 *   L12 + const q = "SELECT * FROM users WHERE id=" + id;
 *   L13   return db.query(q);
 *       - return db.query("SELECT ...", [id]);
 */
export function renderFile(file: ParsedFile, hunks = file.hunks): string {
  const out = [`=== FILE: ${file.path} (${file.status}, ${file.language}) ===`];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const num = l.newLine === null ? "" : `L${l.newLine}`;
      const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      out.push(`${num.padStart(6)} ${mark} ${l.text}`);
    }
  }
  return out.join("\n");
}

const SKIP_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage)\//,
  /\.(min\.(js|css)|map|snap|svg|png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|eot|lock)$/i,
  /\.(pb\.go|generated\.\w+|g\.dart)$/,
  /(^|\/)worker-configuration\.d\.ts$/
];

export function shouldSkip(file: DiffFile): string | null {
  if (file.status === "removed") return "file removed";
  if (!file.patch) return "binary or too large for GitHub to diff";
  if (SKIP_PATTERNS.some((re) => re.test(file.path))) return "generated, vendored or lockfile";
  return null;
}

export interface Chunk {
  index: number;
  files: string[];
  text: string;
}

/** Rough token estimate: code averages about 3.5 characters per Llama token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Pack files into chunks of at most `budget` tokens. A file too big for one chunk
 * is split at hunk boundaries. Anything past `maxChunks` is reported as skipped,
 * so cost per review stays bounded.
 */
export function chunkFiles(
  files: ParsedFile[],
  budget = 9000,
  maxChunks = 4
): { chunks: Chunk[]; skipped: string[] } {
  const pieces: { path: string; text: string }[] = [];
  for (const f of files) {
    const whole = renderFile(f);
    if (estimateTokens(whole) <= budget) {
      pieces.push({ path: f.path, text: whole });
      continue;
    }
    let group: ParsedFile["hunks"] = [];
    for (const h of f.hunks) {
      const candidate = renderFile(f, [...group, h]);
      if (group.length > 0 && estimateTokens(candidate) > budget) {
        pieces.push({ path: f.path, text: renderFile(f, group) });
        group = [];
      }
      group.push(h);
    }
    if (group.length) pieces.push({ path: f.path, text: renderFile(f, group) });
  }

  const chunks: Chunk[] = [];
  const skipped = new Set<string>();
  let cur: { files: string[]; parts: string[]; tokens: number } | null = null;
  const flush = () => {
    if (cur && cur.parts.length) {
      chunks.push({ index: chunks.length, files: [...new Set(cur.files)], text: cur.parts.join("\n\n") });
    }
    cur = null;
  };
  for (const p of pieces) {
    const t = estimateTokens(p.text);
    if (t > budget) {
      // A single hunk larger than the budget: truncate, don't drop it.
      p.text = p.text.slice(0, Math.floor(budget * 3.5)) + "\n... (truncated)";
    }
    if (cur && cur.tokens + Math.min(t, budget) > budget) flush();
    if (!cur) {
      if (chunks.length >= maxChunks) {
        skipped.add(p.path);
        continue;
      }
      cur = { files: [], parts: [], tokens: 0 };
    }
    cur.files.push(p.path);
    cur.parts.push(p.text);
    cur.tokens += Math.min(t, budget);
  }
  flush();
  // A file that was only partly reviewed still counts as reviewed.
  const reviewed = new Set(chunks.flatMap((c) => c.files));
  return { chunks, skipped: [...skipped].filter((s) => !reviewed.has(s)) };
}

/**
 * Turn playground input into DiffFiles. A unified diff (`git diff` output) is
 * parsed per file. Plain source code becomes one new file where every line counts
 * as added.
 */
export function playgroundToFiles(filename: string, content: string): DiffFile[] {
  const looksLikeDiff = /^(diff --git |--- |\+\+\+ |@@ -\d)/m.test(content) && /^@@ -\d+/m.test(content);
  if (!looksLikeDiff) {
    const lines = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    return [
      {
        path: filename || "snippet.txt",
        status: "added",
        patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n")
      }
    ];
  }

  const files: DiffFile[] = [];
  const current = () => files[files.length - 1];
  const startFile = (path: string) => files.push({ path, status: "modified", patch: "" });
  // Lines still owed to the current hunk, taken from its header counts. This way a
  // deleted line that happens to start with "--" (an SQL comment) is never mistaken
  // for a file header.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      current().patch += "\n" + line;
      if (line.startsWith("+")) newLeft--;
      else if (line.startsWith("-")) oldLeft--;
      else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      startFile(/ b\/(.+)$/.exec(line)?.[1] ?? filename);
    } else if (line.startsWith("--- ")) {
      // A "---" header without a preceding "diff --git" starts a new file.
      if (!current() || current().patch) startFile(filename);
      if (line.includes("/dev/null")) current().status = "added";
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "").trim();
      if (current() && p !== "/dev/null") current().path = p;
    } else if (line.startsWith("deleted file mode") && current()) {
      current().status = "removed";
    } else if (line.startsWith("new file mode") && current()) {
      current().status = "added";
    } else {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      if (!current()) startFile(filename || "snippet.diff");
      const f = current();
      f.patch += (f.patch ? "\n" : "") + line;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    }
  }
  return files.filter((f) => f.patch);
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript (React)", js: "JavaScript", jsx: "JavaScript (React)",
  mjs: "JavaScript", cjs: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java",
  kt: "Kotlin", cs: "C#", rb: "Ruby", php: "PHP", swift: "Swift", scala: "Scala",
  c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", sql: "SQL", sh: "Shell", bash: "Shell",
  yml: "YAML", yaml: "YAML", json: "JSON", jsonc: "JSON", toml: "TOML", tf: "Terraform",
  ex: "Elixir", exs: "Elixir", dart: "Dart", vue: "Vue", svelte: "Svelte", html: "HTML",
  ini: "INI", env: "dotenv", properties: "Java properties", xml: "XML", gradle: "Gradle"
};

export function detectLanguage(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^Dockerfile/i.test(base)) return "Dockerfile";
  if (/^\.env/.test(base)) return "dotenv";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return LANGUAGES[ext] ?? "unknown";
}
