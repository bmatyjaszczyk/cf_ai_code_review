import { describe, expect, it } from "vitest";
import { chunkFiles, parsePatch, playgroundToFiles, renderFile, shouldSkip } from "../src/diff";
import { PASSES, extractJson, validateFindings } from "../src/llm";
import { fingerprint, lineKey, linesFromContext, mergeFindings, summaryBody } from "../src/merge";
import { scanSecrets } from "../src/secrets";
import { SAMPLES } from "../src/shared/samples";
import { pemToPkcs8, parsePullRequestUrl } from "../src/github";
import type { RawFinding } from "../src/llm";

const PATCH = `@@ -10,4 +10,6 @@ export function getUser(id) {
   const a = 1;
-  return db.query("SELECT * FROM users WHERE id = $1", [id]);
+  const q = "SELECT * FROM users WHERE id = " + id;
+  return db.query(q);
   // end
+  const password = "hunter2hunter2Xy9";
+  const dbPassword = "changeme-please";
 }`;

describe("diff", () => {
  const file = parsePatch({ path: "src/users.ts", status: "modified", patch: PATCH });

  it("numbers added and context lines with new-file line numbers", () => {
    expect([...file.added]).toEqual([11, 12, 14, 15]);
    expect(file.commentable.has(10)).toBe(true); // context line
    expect(file.commentable.has(13)).toBe(true);
    expect(file.language).toBe("TypeScript");
  });

  it("renders L-numbers, leaving removed lines unnumbered", () => {
    const text = renderFile(file);
    expect(text).toContain("   L11 +   const q =");
    expect(text).toMatch(/^\s+-\s+return db\.query\("SELECT/m);
  });

  it("skips lockfiles, vendored and binary files", () => {
    expect(shouldSkip({ path: "package-lock.json", status: "modified", patch: "@@" })).toBeTruthy();
    expect(shouldSkip({ path: "vendor/x/y.go", status: "modified", patch: "@@" })).toBeTruthy();
    expect(shouldSkip({ path: "logo.png", status: "added", patch: "" })).toBeTruthy();
    expect(shouldSkip({ path: "src/a.ts", status: "modified", patch: "@@" })).toBeNull();
  });

  it("splits big diffs into chunks and reports what didn't fit", () => {
    const big = Array.from({ length: 6 }, (_, i) =>
      parsePatch({ path: `f${i}.ts`, status: "added", patch: `@@ -0,0 +1,400 @@\n` + Array.from({ length: 400 }, (_, j) => `+const v${j} = compute(${j}); // some code here`).join("\n") })
    );
    const { chunks, skipped } = chunkFiles(big, 9000, 4);
    expect(chunks.length).toBe(4);
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.text.length / 3.5).toBeLessThanOrEqual(9000 * 1.05);
  });

  it("treats pasted plain code as a new file", () => {
    const [f] = playgroundToFiles("app.py", "import os\nprint(1)\n");
    expect(f.status).toBe("added");
    expect([...parsePatch(f).added]).toEqual([1, 2]);
  });

  it("parses a multi-file git diff, including removed '-- ' SQL comment lines", () => {
    const diff = `diff --git a/db/q.sql b/db/q.sql
index 1..2 100644
--- a/db/q.sql
+++ b/db/q.sql
@@ -1,2 +1,2 @@
--- old comment
+-- new comment
 SELECT 1;
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;
    const files = playgroundToFiles("x", diff);
    expect(files.map((f) => [f.path, f.status])).toEqual([["db/q.sql", "modified"], ["src/new.ts", "added"]]);
    expect(parsePatch(files[0]).added.has(1)).toBe(true);
  });
});

describe("secret scanner", () => {
  it("finds real-looking secrets and ignores placeholders", () => {
    const file = parsePatch({ path: "src/users.ts", status: "modified", patch: PATCH });
    const found = scanSecrets([file]);
    expect(found.map((f) => f.lineStart)).toEqual([14]); // "changeme-please" is a placeholder
    expect(found[0].explanation).not.toContain("hunter2hunter2Xy9"); // masked
  });

  it("finds every planted credential in the samples", () => {
    const ts = SAMPLES.find((s) => s.id === "ts")!;
    const found = scanSecrets(playgroundToFiles(ts.filename, ts.content).map(parsePatch));
    const titles = found.map((f) => f.title);
    expect(titles).toContain("Stripe live secret key");
    expect(titles).toContain("AWS access key ID");
    expect(titles).toContain("Database connection string with embedded password");

    const py = SAMPLES.find((s) => s.id === "py")!;
    expect(scanSecrets(playgroundToFiles(py.filename, py.content).map(parsePatch)).length).toBe(1);
  });
});

describe("model output handling", () => {
  const chunk = { index: 0, files: ["src/users.ts"], text: "" };
  const pass = PASSES[0];

  it("accepts parsed objects, JSON strings and JSON wrapped in prose", () => {
    expect(extractJson({ response: { findings: [] } })).toEqual({ findings: [] });
    expect(extractJson({ response: '{"findings": []}' })).toEqual({ findings: [] });
    expect(extractJson('Sure! Here you go: {"findings": []} hope it helps')).toEqual({ findings: [] });
    expect(() => extractJson({ response: "no json here" })).toThrow();
  });

  it("coerces or drops malformed findings", () => {
    const out = validateFindings(
      {
        findings: [
          { file: "users.ts", line_start: "11", line_end: 2, category: "made-up", severity: "urgent", title: "SQLi", explanation: "bad", suggestion: "", confidence: 3 },
          { file: "other.ts", line_start: 1, title: "x", explanation: "y" }, // unknown file in a 1-file chunk: mapped to it
          { file: "src/users.ts", line_start: -1, title: "x", explanation: "y" }, // invalid line
          { file: "src/users.ts", line_start: 5, title: "", explanation: "y" } // no title
        ]
      },
      pass,
      chunk
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ file: "src/users.ts", lineStart: 11, lineEnd: 11, category: "security", severity: "medium", confidence: 1 });
  });
});

describe("merge", () => {
  const file = parsePatch({ path: "src/users.ts", status: "modified", patch: PATCH });
  const base: RawFinding = {
    file: "src/users.ts", lineStart: 11, lineEnd: 12, category: "security", severity: "critical",
    title: "SQL injection", explanation: "x", suggestion: "", confidence: 0.9, source: "security"
  };

  it("dedupes overlapping findings of the same category from different passes, keeping the most severe", () => {
    const { findings } = mergeFindings(
      [{ ...base, severity: "high", title: "Unsanitized input", lineStart: 12, source: "correctness" }, base],
      [file],
      { minConfidence: 0.5, dismissed: new Set() }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("dedupes the same issue reported by two passes under different categories", () => {
    const a = { ...base, category: "type-safety" as const, severity: "high" as const, title: "Mutable default argument", source: "correctness" };
    const b = { ...a, category: "code-quality" as const, severity: "low" as const, title: "Mutable default argument in add_tag", source: "reliability" };
    const { findings } = mergeFindings([b, a], [file], { minConfidence: 0.5, dismissed: new Set() });
    expect(findings.map((f) => f.severity)).toEqual(["high"]);
  });

  it("keeps distinct secrets on adjacent lines", () => {
    const ts = SAMPLES.find((s) => s.id === "ts")!;
    const files = playgroundToFiles(ts.filename, ts.content).map(parsePatch);
    const { findings } = mergeFindings(scanSecrets(files), files, { minConfidence: 0.5, dismissed: new Set() });
    expect(findings.length).toBe(3);
  });

  it("drops off-topic findings from a pass", () => {
    const perf = PASSES.find((p) => p.id === "performance")!;
    const out = validateFindings(
      { findings: [
        { file: "src/users.ts", line_start: 11, line_end: 11, category: "database-performance", severity: "high", title: "SQL Injection Vulnerability", explanation: "x", suggestion: "", confidence: 1 },
        { file: "src/users.ts", line_start: 12, line_end: 12, category: "database-performance", severity: "high", title: "N+1 query in order loop", explanation: "x", suggestion: "", confidence: 1 }
      ] },
      perf,
      { index: 0, files: ["src/users.ts"], text: "" }
    );
    expect(out.map((f) => f.title)).toEqual(["N+1 query in order loop"]);
  });

  it("dedupes an LLM secret finding against the deterministic scanner", () => {
    const secret = scanSecrets([file])[0];
    const llm = { ...base, category: "configuration" as const, lineStart: 14, lineEnd: 14, title: "Hardcoded password", severity: "high" as const };
    const { findings } = mergeFindings([llm, secret], [file], { minConfidence: 0.5, dismissed: new Set() });
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("secret-scan");
  });

  it("drops low-confidence and hallucinated-line findings, snaps near-misses", () => {
    const { findings } = mergeFindings(
      [
        { ...base, confidence: 0.2, severity: "low", category: "code-quality" },
        { ...base, lineStart: 400, lineEnd: 400, category: "correctness" },
        { ...base, lineStart: 13, lineEnd: 13, category: "error-handling" } // context line next to added 12/14
      ],
      [file],
      { minConfidence: 0.5, dismissed: new Set() }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "error-handling", inline: true });
    expect([12, 14]).toContain(findings[0].lineStart);
  });

  it("fingerprints by line content, so dismissals survive code moving", () => {
    const fp = fingerprint({ file: "a.ts", category: "security", lineStart: 10 }, "  const q = 'x' + id;");
    expect(fingerprint({ file: "a.ts", category: "security", lineStart: 99 }, "const q = 'x' +   id;")).toBe(fp);
    const { findings, suppressed } = mergeFindings([base], [file], { minConfidence: 0.5, dismissed: new Set() });
    const again = mergeFindings([base], [file], { minConfidence: 0.5, dismissed: new Set([findings[0].fingerprint]) });
    expect(suppressed).toBe(0);
    expect(again.findings).toHaveLength(0);
    expect(again.suppressed).toBe(1);
  });

  it("gives the same lineKey to a relabeled finding on the same line", () => {
    const first = mergeFindings([{ ...base, category: "security", title: "Insecure configuration" }], [file], { minConfidence: 0.5, dismissed: new Set() }).findings[0];
    const second = mergeFindings([{ ...base, category: "configuration", title: "Debug mode enabled", source: "security" }], [file], { minConfidence: 0.5, dismissed: new Set() }).findings[0];
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.lineKey).toBe(second.lineKey);
    expect(lineKey("a.py", "  x = 1", 3)).toBe(lineKey("a.py", "x   = 1", 99));
  });

  it("rebuilds the same lineKey from a stored review context (backfill)", () => {
    const merged = mergeFindings([base], [file], { minConfidence: 0.5, dismissed: new Set() }).findings[0];
    const lines = linesFromContext(renderFile(file) + "\n\n" + renderFile(file, []).replace("src/users.ts", "other.ts"));
    const text = lines.get("src/users.ts")?.get(merged.lineStart) ?? "";
    expect(text).toContain("SELECT");
    expect(lineKey(merged.file, text, merged.lineStart)).toBe(merged.lineKey);
  });

  it("describes incremental reviews and carried-over findings", () => {
    const body = summaryBody({ findings: [], inlineIds: new Set(), repeated: 0, carried: 4, incrementalBase: "5728563abc", suppressed: 0, filesReviewed: 1, skipped: [], headSha: "f5bd10cdef", dashboardUrl: null });
    expect(body).toContain("changed since `5728563`");
    expect(body).toContain("no new issues");
    expect(body).toContain("4 earlier finding(s)");
  });

  it("renders a summary with a table and notes", () => {
    const { findings } = mergeFindings([base], [file], { minConfidence: 0.5, dismissed: new Set() });
    const body = summaryBody({ findings, inlineIds: new Set(), repeated: 2, suppressed: 1, filesReviewed: 1, skipped: ["package-lock.json"], headSha: "abcdef1234", dashboardUrl: "https://x.dev" });
    expect(body).toContain("| 1 | 🔴 critical | Security | `src/users.ts:11-12` | SQL injection ¹ |");
    expect(body).toContain("already commented");
    expect(body).toContain("`package-lock.json`");
  });
});

describe("github helpers", () => {
  it("parses PR URLs", () => {
    expect(parsePullRequestUrl("https://github.com/acme/web-app/pull/42/files")).toEqual({ owner: "acme", repo: "web-app", number: 42 });
    expect(parsePullRequestUrl("https://gitlab.com/a/b/-/merge_requests/1")).toBeNull();
  });

  it("wraps PKCS#1 keys into a valid PKCS#8 envelope", async () => {
    const { privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
    // PKCS#1 RSAPrivateKey is the OCTET STRING payload at the end of the PKCS#8 structure (26-byte header for 2048-bit keys).
    const pkcs1 = pkcs8.slice(26);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs1))}\n-----END RSA PRIVATE KEY-----`;
    expect(pemToPkcs8(pem)).toEqual(pkcs8);
  });
});
