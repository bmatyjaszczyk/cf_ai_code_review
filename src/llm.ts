// Workers AI (Llama 3.3 70B) calls: the analysis passes run by the review workflow,
// plus the follow-up chat about a finished review.

import type { Chunk } from "./diff";
import type { Category, ChatMessage, Finding, Severity } from "./shared/types";

export interface Pass {
  id: string;
  label: string;
  categories: Category[];
  checklist: string;
  /** Topics other passes own. Llama 3.3 tends to re-report the obvious bug in every pass. */
  notInScope: string;
  /** Backstop for notInScope: findings from this pass whose title matches are dropped. */
  offTopic: RegExp;
}

const SECURITY_TOPICS = /injection|\bxss\b|cross[- ]site|\beval\b|code execution|traversal|\bssrf\b|secret|credential|api key|hardcoded|\bcors\b|\btls\b|certificate|https agent|csrf|deseriali[sz]|unseriali[sz]|pickl|yaml\.load/i;
const PERF_TOPICS = /\bn\+1\b|blocking|readfilesync|missing index|unbounded quer/i;
const RELIABILITY_TOPICS = /floating[- ]point|float(ing)? arithmetic|rounding|empty catch|swallow/i;

/**
 * The analysis passes. Each one is a separate LLM call per chunk, run in parallel
 * by the workflow. A short, focused checklist per call works much better with
 * Llama 3.3 than one prompt asking for everything at once.
 */
export const PASSES: Pass[] = [
  {
    id: "security",
    label: "Security & configuration",
    categories: ["security", "configuration"],
    notInScope: "performance, N+1 queries, blocking I/O, floating-point money math, generic error handling, code style",
    offTopic: new RegExp(`${PERF_TOPICS.source}|${RELIABILITY_TOPICS.source}`, "i"),
    checklist: `
- SQL / NoSQL injection: queries built with string concatenation, template literals, f-strings, format() or % instead of parameters; MongoDB queries taking raw user objects ($where, $ne operators).
- Command injection: exec/execSync/spawn with shell, os.system, subprocess(..., shell=True), backticks built from user input.
- Code and object injection: eval, new Function, setTimeout(string), pickle/marshal loads, yaml.load without SafeLoader, PHP unserialize, Java ObjectInputStream, prototype pollution (deep-merging user JSON into objects, obj[userKey] = value).
- XSS: innerHTML, outerHTML, document.write, dangerouslySetInnerHTML, unescaped template output, |safe filters.
- Path traversal (user input in file paths), SSRF (user-controlled URLs fetched by the server), open redirects.
- Broken access control: missing authentication or ownership checks (IDOR), trusting client-supplied roles or IDs.
- Weak crypto: MD5/SHA1 for passwords, Math.random()/random for tokens, ECB mode, hardcoded IVs or salts, disabled JWT verification or alg "none".
- Insecure configuration: CORS "*" (especially with credentials), debug mode in production, TLS verification disabled (rejectUnauthorized: false, verify=False, InsecureSkipVerify), cookies without Secure/HttpOnly/SameSite, overly permissive IAM or file permissions (chmod 777), services bound to 0.0.0.0 without auth, verbose error pages.`
  },
  {
    id: "correctness",
    label: "Bugs, concurrency & type safety",
    categories: ["correctness", "concurrency", "type-safety"],
    notInScope: "ANY security issue (SQL/code injection, eval, XSS, path traversal, secrets, CORS, TLS), performance, N+1 queries, blocking I/O, floating-point money math, empty catch blocks",
    offTopic: new RegExp(`${SECURITY_TOPICS.source}|${PERF_TOPICS.source}|${RELIABILITY_TOPICS.source}`, "i"),
    checklist: `
- Critical logic bugs: inverted or wrong conditions, off-by-one, wrong variable, unreachable code, null/undefined dereference, wrong return value.
- Async bugs: missing await, floating promises, async callbacks in forEach, unhandled rejections.
- Race conditions: check-then-act and read-modify-write without a transaction, lock or atomic operation (balance -= x, stock checks, "if not exists then insert"), TOCTOU on files, mutable module-level or global state shared between requests, missing mutex around shared maps/counters, goroutines capturing loop variables, double-submit and non-idempotent handlers.
- Language-specific quirks: JS == coercion, parseInt without radix, typeof null, sort() without comparator on numbers, Python mutable default arguments, late-binding closures in loops, "is" for value comparison, bare except, Go ignored errors and nil-interface checks, Java == on Strings, integer overflow, shadowed variables.
- Type safety: any/unknown casts hiding real mismatches, non-null assertions (!) on values that can be null, unchecked casts, implicit string/number conversions, unvalidated external input used as a typed object.`
  },
  {
    id: "performance",
    label: "Database & I/O performance",
    categories: ["database-performance", "blocking-io"],
    notInScope: "ANY security issue (SQL injection is NOT a performance problem; neither are eval, XSS, secrets, CORS, TLS), logic bugs, race conditions, money math, error handling",
    offTopic: new RegExp(`${SECURITY_TOPICS.source}|${RELIABILITY_TOPICS.source}|race condition`, "i"),
    checklist: `
- N+1 queries: a query or ORM lazy-load inside a loop over results (for user in users: user.orders...), await db.query inside for/map.
- Missing indexes: new queries or migrations filtering, joining or sorting on columns with no index; foreign keys without an index; LIKE '%x' scans.
- Unbounded queries: SELECT * on large tables, no LIMIT/pagination, loading whole tables into memory, COUNT(*) in hot paths.
- Blocking I/O: readFileSync/writeFileSync/execSync in request handlers, time.sleep or requests.get inside async def, blocking calls on an event loop, synchronous HTTP calls in hot paths, CPU-heavy work (big JSON parsing, crypto, regex backtracking) in the request path.
- Sequential awaits that could run in parallel, network calls without timeouts, opening a connection per request instead of pooling.`
  },
  {
    id: "reliability",
    label: "Money math, error handling & quality",
    categories: ["financial-precision", "error-handling", "code-quality"],
    notInScope: "ANY security issue (SQL/code injection, eval, XSS, path traversal, secrets, CORS, TLS: an injection is not an error-handling problem), performance, N+1 queries, blocking I/O, race conditions",
    offTopic: new RegExp(`${SECURITY_TOPICS.source}|${PERF_TOPICS.source}|race condition`, "i"),
    checklist: `
- Financial precision: money stored or computed as float/double/JS number (price * qty, balances, tax, currency conversion), toFixed/Math.round used for monetary rounding, comparing floats with ==, summing floats in loops. Recommend integer minor units (cents), Decimal/BigDecimal, or a money library, with an explicit rounding mode.
- Error handling: empty catch blocks, errors that are swallowed or only logged on a critical path, stack traces or internal errors returned to clients, resources not closed (missing finally/using/with/defer), retries without backoff, error messages without useful context.
  Do NOT report generic "missing try/catch" on ordinary calls: frameworks already turn uncaught errors into 500s. Report missing handling only where a failure would leave data half-written, leak internals, or crash a background task.
- Code quality, only where it matters: dead or duplicated logic that will drift, functions that do too much to be safely changed, misleading names that hide behavior, magic numbers in business rules. Skip pure style and formatting.`
  }
];

const SEVERITY_RUBRIC = `Severity:
- critical: exploitable vulnerability, data loss or corruption, money miscalculated, or a crash on a common path.
- high: likely bug or security weakness that will hit production under realistic conditions.
- medium: real problem with limited impact or needing unusual conditions.
- low: minor issue worth fixing.`;

function systemPrompt(pass: Pass, notes: string): string {
  return `You are a senior staff engineer doing a focused code review of a pull request diff.
This pass ONLY covers: ${pass.label}. Other reviewers handle everything else.

Checklist:${pass.checklist}

NOT your job (other reviewers report these; findings about them will be discarded): ${pass.notInScope}.

How to read the diff: every line has its new-file line number ("L42"), then a marker: "+" added by this PR, " " unchanged context, "-" removed (no line number).

Rules:
1. Report only problems on "+" lines, i.e. code introduced or changed by this PR. Use context lines only to understand it.
2. "line_start" and "line_end" must be L-numbers that appear on "+" lines of the cited file. "file" must be the exact path from the "=== FILE:" header.
3. Every finding must be specific and real: say what breaks, how it can be triggered, and its impact. No generic advice, no style or formatting nits, no speculation about code you cannot see.
4. "suggestion" is a concrete fix, ideally a short corrected code snippet in a markdown code block.
5. First write "analysis": go through the checklist item by item and note which items appear in the diff, with line numbers (short, max ~8 lines). Then turn each real issue into a finding.
6. If nothing in scope is wrong, return an empty "findings" array. An empty result is better than a weak finding.
7. At most 8 findings, most important first. "confidence" is between 0 and 1.

${SEVERITY_RUBRIC}${notes.trim() ? `\n\nTeam conventions and notes from the repository owner (respect these, and don't flag what they say is intentional):\n${notes.trim()}` : ""}

Respond with JSON only.`;
}

function findingsSchema(pass: Pass) {
  return {
    type: "object",
    properties: {
      analysis: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            line_start: { type: "integer" },
            line_end: { type: "integer" },
            category: { type: "string", enum: pass.categories },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            title: { type: "string" },
            explanation: { type: "string" },
            suggestion: { type: "string" },
            confidence: { type: "number" }
          },
          required: ["file", "line_start", "line_end", "category", "severity", "title", "explanation", "suggestion", "confidence"]
        }
      }
    },
    required: ["analysis", "findings"]
  };
}

export type RawFinding = Omit<Finding, "id" | "fingerprint">;

/** Run one analysis pass over one chunk and return validated findings. */
export async function runPass(env: Env, pass: Pass, chunk: Chunk, notes: string): Promise<RawFinding[]> {
  const result = await env.AI.run(env.MODEL, {
    messages: [
      { role: "system", content: systemPrompt(pass, notes) },
      { role: "user", content: `Review this diff (${chunk.files.length} file(s)):\n\n${chunk.text}` }
    ],
    response_format: { type: "json_schema", json_schema: findingsSchema(pass) },
    max_tokens: 2500,
    temperature: 0.1
  });
  return validateFindings(extractJson(result), pass, chunk);
}

/** Workers AI JSON mode sometimes returns a parsed object and sometimes a string. */
export function extractJson(result: unknown): unknown {
  const payload = typeof result === "object" && result !== null && "response" in result ? (result as { response: unknown }).response : result;
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(payload.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Model returned non-JSON output: ${payload.slice(0, 200)}`);
  }
}

const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low"]);

/** Never trust the model's output shape: coerce what can be fixed, drop the rest. */
export function validateFindings(data: unknown, pass: Pass, chunk: Chunk): RawFinding[] {
  const items = (data as { findings?: unknown })?.findings;
  if (!Array.isArray(items)) return [];
  const out: RawFinding[] = [];
  for (const it of items.slice(0, 8) as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const file = resolveFile(String(it.file ?? ""), chunk.files);
    const lineStart = Math.trunc(Number(it.line_start));
    if (!file || !Number.isFinite(lineStart) || lineStart < 1) continue;
    let lineEnd = Math.trunc(Number(it.line_end));
    if (!Number.isFinite(lineEnd) || lineEnd < lineStart) lineEnd = lineStart;
    const title = String(it.title ?? "").trim();
    const explanation = String(it.explanation ?? "").trim();
    if (!title || !explanation) continue;
    if (pass.offTopic.test(title)) continue;
    const severity = SEVERITIES.has(it.severity as Severity) ? (it.severity as Severity) : "medium";
    const category = pass.categories.includes(it.category as Category) ? (it.category as Category) : pass.categories[0];
    const confidence = Math.min(1, Math.max(0, Number(it.confidence) || 0.5));
    out.push({
      file,
      lineStart,
      lineEnd: Math.min(lineEnd, lineStart + 30),
      category,
      severity,
      title: title.slice(0, 160),
      explanation: explanation.slice(0, 2000),
      suggestion: String(it.suggestion ?? "").trim().slice(0, 3000),
      confidence,
      source: pass.id
    });
  }
  return out;
}

/** The model sometimes shortens paths; map them back to a real file in the chunk. */
function resolveFile(file: string, files: string[]): string | null {
  const f = file.replace(/^[ab]\//, "").trim();
  if (files.includes(f)) return f;
  const byEnd = files.filter((p) => p.endsWith("/" + f) || f.endsWith("/" + p));
  if (byEnd.length === 1) return byEnd[0];
  const base = f.split("/").pop();
  const byBase = files.filter((p) => p.split("/").pop() === base);
  return byBase.length === 1 ? byBase[0] : files.length === 1 ? files[0] : null;
}

/** Follow-up chat about one review, grounded in its diff and findings. */
export async function chatAboutReview(
  env: Env,
  args: { title: string; context: string; findings: Finding[]; history: ChatMessage[]; question: string }
): Promise<string> {
  const findingList = args.findings
    .map(
      (f, i) =>
        `#${i + 1} [${f.severity}/${f.category}] ${f.file}:${f.lineStart}${f.lineEnd !== f.lineStart ? "-" + f.lineEnd : ""}: ${f.title}${f.dismissed ? " (dismissed by user)" : ""}\n${f.explanation}`
    )
    .join("\n\n");
  const system = `You are the AI code reviewer that reviewed "${args.title}". The developer is asking follow-up questions about your review.
Answer concisely in GitHub-flavored markdown. When asked for a fix, give complete corrected code. Refer to findings by their #number.
If they push back on a finding and they are right, say so plainly. Don't invent code that isn't in the diff.

Findings from your review:
${findingList || "(no findings)"}

The reviewed diff (L-numbers are new-file line numbers, "+" = added lines):
${args.context.slice(0, 40_000)}`;

  const history = args.history.slice(-10).map((m) => ({ role: m.role, content: m.content }));
  const result = await env.AI.run(env.MODEL, {
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: args.question }],
    max_tokens: 1500,
    temperature: 0.3
  });
  const text = typeof result === "string" ? result : (result as { response?: unknown }).response;
  return typeof text === "string" && text.trim() ? text.trim() : "Sorry, I couldn't generate an answer. Please try again.";
}
