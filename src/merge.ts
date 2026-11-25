// Combine results from all passes into one ranked review: drop invalid and
// duplicate findings, apply the repo's memory (dismissed findings, earlier
// comments), decide which findings can be inline comments, and render GitHub
// markdown.

import type { ParsedFile } from "./diff";
import type { RawFinding } from "./llm";
import { SEVERITY_ORDER, emptyCounts, type Finding, type Severity } from "./shared/types";

/** FNV-1a: small, synchronous and stable. Good enough for fingerprints. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A fingerprint is based on the file, the category and the *content* of the cited
 * line, not its line number and not the model's wording. It survives code moving
 * around and the model phrasing the same issue differently, which is what makes
 * "dismiss" and "don't repeat comments" work across pushes.
 */
export function fingerprint(f: Pick<Finding, "file" | "category" | "lineStart">, lineText: string): string {
  const norm = lineText.replace(/\s+/g, " ").trim().toLowerCase();
  return hash(`${f.file}|${f.category}|${norm || f.lineStart}`);
}

export function lineKey(file: string, lineText: string, line: number): string {
  const norm = lineText.replace(/\s+/g, " ").trim().toLowerCase();
  return hash(`${file}|${norm || line}`);
}

const SECRETISH = /secret|password|credential|api.?key|token|hardcoded|connection string/i;

function overlaps(a: RawFinding, b: RawFinding): boolean {
  return a.file === b.file && a.lineStart <= b.lineEnd + 2 && b.lineStart <= a.lineEnd + 2;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w.length > 2));

/** Jaccard similarity of title words: "Mutable default argument" vs "Mutable default arguments in add_tag". */
function similarTitles(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / (wa.size + wb.size - shared || 1) >= 0.5;
}

function isDuplicate(a: RawFinding, b: RawFinding): boolean {
  // Within one pass the model already lists distinct issues; only an exact repeat is a duplicate.
  if (a.source === b.source) return a.file === b.file && a.lineStart === b.lineStart && a.category === b.category;
  if (!overlaps(a, b)) return false;
  if (a.category === b.category) return true;
  if (a.lineStart === b.lineStart && similarTitles(a.title, b.title)) return true;
  // The deterministic secret scanner and an LLM pass reporting the same credential.
  const secretA = a.category === "secrets" || SECRETISH.test(a.title);
  const secretB = b.category === "secrets" || SECRETISH.test(b.title);
  return secretA && secretB;
}

const rank = (f: RawFinding) => SEVERITY_ORDER[f.severity] * 10 - f.confidence;

export interface MergeOptions {
  minConfidence: number;
  dismissed: Set<string>;
}

export function mergeFindings(raw: RawFinding[], files: ParsedFile[], opts: MergeOptions): { findings: Finding[]; suppressed: number } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const lineText = (file: ParsedFile, n: number) => {
    for (const h of file.hunks) for (const l of h.lines) if (l.newLine === n) return l.text;
    return "";
  };

  // Deterministic findings come first, then the most severe and most confident.
  const sorted = [...raw].sort((a, b) => (a.source === "secret-scan" ? -1 : 0) - (b.source === "secret-scan" ? -1 : 0) || rank(a) - rank(b));
  const kept: Finding[] = [];
  let suppressed = 0;

  for (const r of sorted) {
    const file = byPath.get(r.file);
    if (!file) continue;
    if (r.confidence < opts.minConfidence && r.severity !== "critical") continue;

    // Snap a cited line that sits next to the change onto the nearest added line.
    let { lineStart, lineEnd } = r;
    let inline = file.added.has(lineStart);
    if (!inline) {
      const near = [...file.added].filter((n) => Math.abs(n - lineStart) <= 3).sort((a, b) => Math.abs(a - lineStart) - Math.abs(b - lineStart))[0];
      if (near !== undefined) {
        lineEnd = Math.max(near, lineEnd - (lineStart - near));
        lineStart = near;
        inline = true;
      } else if (!file.commentable.has(lineStart)) {
        // Cites a line that isn't in the diff at all: most likely a hallucinated line number.
        continue;
      }
    }
    const candidate = { ...r, lineStart, lineEnd };
    if (kept.some((k) => isDuplicate(k, candidate))) continue;

    const fp = fingerprint(candidate, lineText(file, lineStart));
    if (opts.dismissed.has(fp)) {
      suppressed++;
      continue;
    }
    kept.push({ ...candidate, id: `${fp}-${kept.length}`, fingerprint: fp, lineKey: lineKey(file.path, lineText(file, lineStart), lineStart), inline });
  }

  kept.sort((a, b) => rank(a) - rank(b));
  return { findings: kept, suppressed };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c = emptyCounts();
  for (const f of findings) if (!f.dismissed) c[f.severity]++;
  return c;
}

// ---------------------------------------------------------------- GitHub markdown

const ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const catLabel = (c: string) => c.split("-").map(cap).join(" ");
const loc = (f: Finding) => `${f.file}:${f.lineStart}${f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}`;

export function inlineCommentBody(f: Finding, dashboardUrl: string | null): string {
  return [
    `${ICON[f.severity]} **${cap(f.severity)} · ${catLabel(f.category)}**: ${f.title}`,
    "",
    f.explanation,
    ...(f.suggestion ? ["", "**Suggested fix**", "", f.suggestion] : []),
    "",
    `<sub>confidence ${Math.round(f.confidence * 100)}% · ${f.source === "secret-scan" ? "deterministic secret scan" : "Llama 3.3 on Workers AI"}${dashboardUrl ? ` · [discuss or dismiss](${dashboardUrl})` : ""}</sub>`
  ].join("\n");
}

export function summaryBody(args: {
  findings: Finding[];
  inlineIds: Set<string>;
  repeated: number;
  /** Findings in files not touched since the last review, carried over from it. */
  carried?: number;
  /** Set when only files changed since this commit were re-reviewed. */
  incrementalBase?: string | null;
  suppressed: number;
  filesReviewed: number;
  skipped: string[];
  headSha: string;
  dashboardUrl: string | null;
}): string {
  const { findings } = args;
  const c = countBySeverity(findings);
  const lines: string[] = ["## 🤖 AI Code Review", ""];
  const total = findings.length;
  const scope = args.incrementalBase
    ? `${args.filesReviewed} file(s) changed since \`${args.incrementalBase.slice(0, 7)}\`, at \`${args.headSha.slice(0, 7)}\``
    : `${args.filesReviewed} file(s) at \`${args.headSha.slice(0, 7)}\``;
  lines.push(
    total === 0
      ? `✅ Reviewed ${scope}: no new issues found.`
      : `Reviewed ${scope}: **${total} new finding(s)**: ` +
          (Object.keys(c) as Severity[]).filter((s) => c[s]).map((s) => `${ICON[s]} ${c[s]} ${s}`).join(" · ")
  );

  if (total) {
    lines.push("", "| | Severity | Category | Location | Finding |", "|---|---|---|---|---|");
    findings.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${ICON[f.severity]} ${f.severity} | ${catLabel(f.category)} | \`${loc(f)}\` | ${f.title.replace(/\|/g, "\\|")}${args.inlineIds.has(f.id) ? "" : " ¹"} |`);
    });
    const notInline = findings.filter((f) => !args.inlineIds.has(f.id));
    if (notInline.length) {
      lines.push("", "¹ Couldn't be attached to a changed line, so the details are here:", "");
      for (const f of notInline) {
        lines.push(`<details><summary>${ICON[f.severity]} <code>${loc(f)}</code>: ${escapeHtml(f.title)}</summary>`, "", f.explanation, "", f.suggestion, "", "</details>");
      }
    }
  }

  const notes: string[] = [];
  if (args.repeated) notes.push(`${args.repeated} finding(s) on lines already commented on are not repeated.`);
  if (args.carried) notes.push(`${args.carried} earlier finding(s) in files untouched by this push are still open (see the dashboard).`);
  if (args.suppressed) notes.push(`${args.suppressed} finding(s) hidden because they were dismissed earlier in this repo.`);
  if (args.skipped.length) notes.push(`Not reviewed: ${args.skipped.slice(0, 10).map((s) => `\`${s}\``).join(", ")}${args.skipped.length > 10 ? ` and ${args.skipped.length - 10} more` : ""}.`);
  if (notes.length) lines.push("", ...notes.map((n) => `> ${n}`));

  lines.push("", `<sub>Llama 3.3 70B on Workers AI · orchestrated with Cloudflare Workflows${args.dashboardUrl ? ` · [open dashboard](${args.dashboardUrl})` : ""}</sub>`);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
