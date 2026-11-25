// RepoAgent: one Durable Object (Agents SDK) per repository, plus one per browser
// for the playground. It is the app's memory: reviews, findings, chat history,
// dismissed findings and team notes live in its SQLite database. Every connected
// dashboard receives live state updates over a WebSocket.

import { Agent, callable } from "agents";
import { getPullRequest, getRepoToken, githubConfigured } from "./github";
import { chatAboutReview, PASSES } from "./llm";
import { lineKey, linesFromContext } from "./merge";
import {
  emptyCounts,
  type ChatMessage,
  type Finding,
  type PassProgress,
  type RepoState,
  type ReviewDetail,
  type ReviewStatus,
  type ReviewSummary,
  type Severity
} from "./shared/types";
import type { ReviewParams } from "./workflow";

export const MAX_PLAYGROUND_CHARS = 60_000;

/** "owner--repo" -> "owner/repo". GitHub usernames can't contain "--", so the first one is the separator. */
export function repoFromAgentName(name: string): { owner: string; repo: string } | null {
  const i = name.indexOf("--");
  if (i <= 0 || name.startsWith("playground-")) return null;
  return { owner: name.slice(0, i), repo: name.slice(i + 2) };
}

export function agentNameForRepo(owner: string, repo: string): string {
  return `${owner}--${repo}`.toLowerCase();
}

type Row = Record<string, string | number | null>;

export function initialProgress(): PassProgress[] {
  return [{ id: "secret-scan", label: "Secret scan", total: 1, done: 0 }, ...PASSES.map((p) => ({ id: p.id, label: p.label, total: 0, done: 0 }))];
}

export class RepoAgent extends Agent<Env, RepoState> {
  initialState: RepoState = { repo: "", notes: "", reviews: [], dismissedCount: 0 };

  /** Dashboards read state but never write it directly; all changes go through callables. */
  validateStateChange(_next: RepoState, source: unknown) {
    if (source !== "server") throw new Error("State is read-only for clients");
  }

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL,
      pr_number INTEGER, pr_url TEXT, head_sha TEXT, installation_id INTEGER,
      status TEXT NOT NULL, progress TEXT NOT NULL, counts TEXT NOT NULL,
      skipped TEXT NOT NULL DEFAULT '[]', context TEXT NOT NULL DEFAULT '',
      error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS findings (
      id TEXT NOT NULL, review_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      file TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      category TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
      explanation TEXT NOT NULL, suggestion TEXT NOT NULL, confidence REAL NOT NULL,
      source TEXT NOT NULL, inline INTEGER NOT NULL DEFAULT 0, posted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (review_id, id))`;
    this.sql`CREATE INDEX IF NOT EXISTS findings_fp ON findings (fingerprint)`;
    // v2: line_key ("already commented on this line"). Added in place so existing data keeps working.
    const cols = this.sql<{ name: string }>`PRAGMA table_info(findings)`.map((c) => c.name);
    if (!cols.includes("line_key")) this.sql`ALTER TABLE findings ADD COLUMN line_key TEXT`;
    this.backfillLineKeys();
    this.sql`CREATE TABLE IF NOT EXISTS dismissals (
      fingerprint TEXT PRIMARY KEY, title TEXT NOT NULL, file TEXT NOT NULL,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE INDEX IF NOT EXISTS messages_review ON messages (review_id)`;

    const gh = repoFromAgentName(this.name);
    if (!this.state.repo) this.setState({ ...this.state, repo: gh ? `${gh.owner}/${gh.repo}` : "playground" });
  }

  /**
   * Findings saved before line keys existed have line_key NULL, so "already commented"
   * memory would ignore them and the next push would repeat every comment. Rebuild
   * the keys from the line-numbered context stored with each review.
   */
  private backfillLineKeys() {
    const rows = this.sql<{ review_id: string; id: string; file: string; line_start: number; context: string }>`
      SELECT f.review_id, f.id, f.file, f.line_start, r.context FROM findings f JOIN reviews r ON r.id = f.review_id
      WHERE f.line_key IS NULL`;
    const parsed = new Map<string, Map<string, Map<number, string>>>();
    for (const row of rows) {
      let lines = parsed.get(row.review_id);
      if (!lines) parsed.set(row.review_id, (lines = linesFromContext(row.context)));
      const text = lines.get(row.file)?.get(row.line_start) ?? "";
      const key = lineKey(row.file, text, row.line_start);
      this.sql`UPDATE findings SET line_key = ${key} WHERE review_id = ${row.review_id} AND id = ${row.id}`;
    }
  }

  // ------------------------------------------------------------ state helpers

  private toSummary(r: Row): ReviewSummary {
    return {
      id: String(r.id),
      source: r.source as ReviewSummary["source"],
      title: String(r.title),
      prNumber: (r.pr_number as number | null) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
      headSha: (r.head_sha as string | null) ?? null,
      status: r.status as ReviewStatus,
      progress: JSON.parse(String(r.progress)),
      counts: JSON.parse(String(r.counts)),
      createdAt: Number(r.created_at),
      finishedAt: (r.finished_at as number | null) ?? null,
      error: (r.error as string | null) ?? null,
      skippedFiles: JSON.parse(String(r.skipped))
    };
  }

  /** Push the latest review list to every connected dashboard. */
  private refresh() {
    const rows = this.sql<Row>`SELECT id, source, title, pr_number, pr_url, head_sha, status, progress, counts, skipped, error, created_at, finished_at
      FROM reviews ORDER BY created_at DESC LIMIT 30`;
    const [{ n }] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM dismissals`;
    this.setState({ ...this.state, reviews: rows.map((r) => this.toSummary(r)), dismissedCount: n });
  }

  private insertReview(id: string, r: { source: "github" | "playground"; title: string; prNumber?: number; prUrl?: string; headSha?: string; installationId?: number | null }) {
    this.sql`INSERT INTO reviews (id, source, title, pr_number, pr_url, head_sha, installation_id, status, progress, counts, created_at)
      VALUES (${id}, ${r.source}, ${r.title}, ${r.prNumber ?? null}, ${r.prUrl ?? null}, ${r.headSha ?? null}, ${r.installationId ?? null},
              'queued', ${JSON.stringify(initialProgress())}, ${JSON.stringify(emptyCounts())}, ${Date.now()})`;
  }

  /** Recompute a review's severity counts without its dismissed findings. */
  private recount(reviewId: string) {
    const counts = emptyCounts();
    const rows = this.sql<{ severity: Severity }>`SELECT severity FROM findings
      WHERE review_id = ${reviewId} AND fingerprint NOT IN (SELECT fingerprint FROM dismissals)`;
    for (const r of rows) counts[r.severity]++;
    this.sql`UPDATE reviews SET counts = ${JSON.stringify(counts)} WHERE id = ${reviewId}`;
  }

  // ------------------------------------------------- entry points that start reviews

  /**
   * Start a review of a GitHub pull request. Called by the webhook handler and
   * from the dashboard. Webhook retries carry the same head SHA, so they map to the
   * same review/workflow ID and never create duplicate reviews.
   */
  async enqueueGithubReview(args: {
    number: number;
    headSha?: string;
    title?: string;
    prUrl?: string;
    installationId?: number | null;
    baseUrl: string;
    force?: boolean;
    /** Push to an open PR: only re-review files changed since the last review. */
    incremental?: boolean;
  }): Promise<{ reviewId: string; duplicate: boolean }> {
    const gh = repoFromAgentName(this.name);
    if (!gh) throw new Error("This agent is not bound to a GitHub repository");
    if (!githubConfigured(this.env)) throw new Error("GitHub credentials are not configured on this deployment");

    let { headSha } = args;
    let title = args.title ?? `PR #${args.number}`;
    let prUrl = args.prUrl ?? `https://github.com/${gh.owner}/${gh.repo}/pull/${args.number}`;
    if (!headSha) {
      const token = await getRepoToken(this.env, gh.owner, gh.repo, args.installationId);
      const pr = await getPullRequest(token, gh.owner, gh.repo, args.number);
      headSha = pr.head.sha;
      title = pr.title;
      prUrl = pr.html_url;
    }

    let reviewId = `pr${args.number}-${headSha.slice(0, 12)}`;
    if (args.force) reviewId += `-r${Date.now().toString(36)}`;
    if (this.sql`SELECT 1 FROM reviews WHERE id = ${reviewId}`.length) return { reviewId, duplicate: true };

    this.insertReview(reviewId, { source: "github", title, prNumber: args.number, prUrl, headSha, installationId: args.installationId });
    this.refresh();
    const params: ReviewParams = {
      agentName: this.name,
      reviewId,
      baseUrl: args.baseUrl,
      github: { owner: gh.owner, repo: gh.repo, number: args.number, headSha, installationId: args.installationId ?? null, incremental: args.incremental ?? false }
    };
    try {
      await this.env.REVIEW_WORKFLOW.create({ id: `${this.name}-${reviewId}`.slice(0, 100).replace(/[^a-zA-Z0-9_-]/g, "_"), params });
    } catch (e) {
      this.failReview(reviewId, `Could not start workflow: ${(e as Error).message}`);
      throw e;
    }
    return { reviewId, duplicate: false };
  }

  @callable({ description: "Review a pull request of this repository by number (or re-run it)" })
  async reviewPullRequest(number: number, baseUrl: string, force = false) {
    if (!Number.isInteger(number) || number < 1) throw new Error("Invalid pull request number");
    return this.enqueueGithubReview({ number, baseUrl, force });
  }

  @callable({ description: "Review pasted code or a unified diff (no GitHub needed)" })
  async startPlaygroundReview(filename: string, content: string, baseUrl: string) {
    if (!content.trim()) throw new Error("Paste some code or a diff first");
    if (content.length > MAX_PLAYGROUND_CHARS) throw new Error(`Input too large (max ${MAX_PLAYGROUND_CHARS / 1000}k characters)`);
    const safeName = (filename || "snippet.txt").replace(/[^\w./-]/g, "_").slice(0, 120);
    const reviewId = `pg-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    this.insertReview(reviewId, { source: "playground", title: safeName });
    this.refresh();
    const params: ReviewParams = { agentName: this.name, reviewId, baseUrl, playground: { filename: safeName, content } };
    await this.env.REVIEW_WORKFLOW.create({ id: `${this.name}-${reviewId}`.slice(0, 100), params });
    return { reviewId };
  }

  // ---------------------------------------------- called by ReviewWorkflow (RPC)

  getMemory(prNumber: number | null): {
    notes: string;
    dismissed: string[];
    postedLineKeys: string[];
    lastReviewedSha: string | null;
    previousFindings: Finding[];
  } {
    const dismissed = this.sql<{ fingerprint: string }>`SELECT fingerprint FROM dismissals`.map((r) => r.fingerprint);
    if (prNumber === null) return { notes: this.state.notes, dismissed, postedLineKeys: [], lastReviewedSha: null, previousFindings: [] };
    const postedLineKeys = this.sql<{ line_key: string }>`SELECT DISTINCT f.line_key FROM findings f JOIN reviews r ON r.id = f.review_id
      WHERE r.pr_number = ${prNumber} AND f.posted = 1 AND f.line_key IS NOT NULL`.map((r) => r.line_key);
    const [last] = this.sql<{ id: string; head_sha: string }>`SELECT id, head_sha FROM reviews
      WHERE pr_number = ${prNumber} AND status = 'done' AND head_sha IS NOT NULL ORDER BY finished_at DESC LIMIT 1`;
    const previousFindings = last ? this.loadFindings(last.id).filter((f) => !f.dismissed) : [];
    return { notes: this.state.notes, dismissed, postedLineKeys, lastReviewedSha: last?.head_sha ?? null, previousFindings };
  }

  markRunning(reviewId: string, info: { title?: string; prUrl?: string; chunks: number }) {
    const progress = initialProgress().map((p) => (p.id === "secret-scan" ? p : { ...p, total: info.chunks }));
    this.sql`UPDATE reviews SET status = 'running', progress = ${JSON.stringify(progress)},
      title = COALESCE(${info.title ?? null}, title), pr_url = COALESCE(${info.prUrl ?? null}, pr_url) WHERE id = ${reviewId}`;
    this.refresh();
  }

  /** Mark one (pass, chunk) unit as finished. Synchronous SQL, so concurrent calls can't lose updates. */
  passDone(reviewId: string, passId: string) {
    const [row] = this.sql<{ progress: string }>`SELECT progress FROM reviews WHERE id = ${reviewId}`;
    if (!row) return;
    const progress = (JSON.parse(row.progress) as PassProgress[]).map((p) => (p.id === passId ? { ...p, done: Math.min(p.total, p.done + 1) } : p));
    this.sql`UPDATE reviews SET progress = ${JSON.stringify(progress)} WHERE id = ${reviewId}`;
    this.refresh();
  }

  completeReview(reviewId: string, result: { findings: Finding[]; postedLineKeys: string[]; context: string; skipped: string[] }) {
    const posted = new Set(result.postedLineKeys);
    const counts = emptyCounts();
    this.ctx.storage.transactionSync(() => {
      this.sql`DELETE FROM findings WHERE review_id = ${reviewId}`;
      for (const f of result.findings) {
        counts[f.severity]++;
        this.sql`INSERT INTO findings (id, review_id, fingerprint, file, line_start, line_end, category, severity, title, explanation, suggestion, confidence, source, inline, posted, line_key)
          VALUES (${f.id}, ${reviewId}, ${f.fingerprint}, ${f.file}, ${f.lineStart}, ${f.lineEnd}, ${f.category}, ${f.severity}, ${f.title},
                  ${f.explanation}, ${f.suggestion}, ${f.confidence}, ${f.source}, ${f.inline ? 1 : 0},
                  ${f.lineKey && posted.has(f.lineKey) ? 1 : 0}, ${f.lineKey ?? null})`;
      }
      const [row] = this.sql<{ progress: string }>`SELECT progress FROM reviews WHERE id = ${reviewId}`;
      const progress = row ? (JSON.parse(row.progress) as PassProgress[]).map((p) => ({ ...p, done: p.total })) : [];
      this.sql`UPDATE reviews SET status = 'done', counts = ${JSON.stringify(counts)}, progress = ${JSON.stringify(progress)},
        context = ${result.context}, skipped = ${JSON.stringify(result.skipped)}, finished_at = ${Date.now()}, error = NULL WHERE id = ${reviewId}`;
    });
    this.refresh();
  }

  failReview(reviewId: string, error: string) {
    this.sql`UPDATE reviews SET status = 'failed', error = ${error.slice(0, 1000)}, finished_at = ${Date.now()} WHERE id = ${reviewId}`;
    this.refresh();
  }

  // ------------------------------------------------------ dashboard callables

  @callable()
  getReview(reviewId: string): ReviewDetail | null {
    const [r] = this.sql<Row>`SELECT * FROM reviews WHERE id = ${reviewId}`;
    if (!r) return null;
    const findings = this.loadFindings(reviewId);
    const messages = this.sql<{ role: string; content: string; created_at: number }>`SELECT role, content, created_at FROM messages WHERE review_id = ${reviewId} ORDER BY id`.map(
      (m): ChatMessage => ({ role: m.role as ChatMessage["role"], content: m.content, createdAt: m.created_at })
    );
    return { review: this.toSummary(r), findings, messages, context: String(r.context ?? "") };
  }

  /** Findings of one review, most severe first, with the repo's current dismissals applied. */
  private loadFindings(reviewId: string): Finding[] {
    const dismissed = new Set(this.sql<{ fingerprint: string }>`SELECT fingerprint FROM dismissals`.map((d) => d.fingerprint));
    const findings = this.sql<Row>`SELECT * FROM findings WHERE review_id = ${reviewId}`.map(
      (f): Finding => ({
        id: String(f.id),
        file: String(f.file),
        lineStart: Number(f.line_start),
        lineEnd: Number(f.line_end),
        category: f.category as Finding["category"],
        severity: f.severity as Severity,
        title: String(f.title),
        explanation: String(f.explanation),
        suggestion: String(f.suggestion),
        confidence: Number(f.confidence),
        fingerprint: String(f.fingerprint),
        lineKey: f.line_key ? String(f.line_key) : undefined,
        source: String(f.source),
        inline: Boolean(f.inline),
        dismissed: dismissed.has(String(f.fingerprint))
      })
    );
    const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b.confidence - a.confidence);
    return findings;
  }

  @callable({ description: "Ask a follow-up question about a review" })
  async ask(reviewId: string, question: string): Promise<ChatMessage[]> {
    const q = question.trim().slice(0, 4000);
    if (!q) throw new Error("Empty question");
    const detail = this.getReview(reviewId);
    if (!detail) throw new Error("Review not found");
    if (detail.review.status !== "done") throw new Error("Wait for the review to finish first");

    this.sql`INSERT INTO messages (review_id, role, content, created_at) VALUES (${reviewId}, 'user', ${q}, ${Date.now()})`;
    let answer: string;
    try {
      answer = await chatAboutReview(this.env, { title: detail.review.title, context: detail.context, findings: detail.findings, history: detail.messages, question: q });
    } catch (e) {
      answer = `⚠️ The model call failed: ${(e as Error).message}`;
    }
    this.sql`INSERT INTO messages (review_id, role, content, created_at) VALUES (${reviewId}, 'assistant', ${answer}, ${Date.now()})`;
    return this.getReview(reviewId)!.messages;
  }

  /** Remember that a finding is a false positive or accepted risk, so later reviews in this repo skip it. */
  @callable()
  dismissFinding(reviewId: string, findingId: string, reason: string) {
    const [f] = this.sql<{ fingerprint: string; title: string; file: string }>`SELECT fingerprint, title, file FROM findings WHERE review_id = ${reviewId} AND id = ${findingId}`;
    if (!f) throw new Error("Finding not found");
    this.sql`INSERT OR REPLACE INTO dismissals (fingerprint, title, file, reason, created_at)
      VALUES (${f.fingerprint}, ${f.title}, ${f.file}, ${(reason || "false positive").slice(0, 300)}, ${Date.now()})`;
    this.recount(reviewId);
    this.refresh();
    return this.getReview(reviewId);
  }

  @callable()
  restoreFinding(reviewId: string, findingId: string) {
    this.sql`DELETE FROM dismissals WHERE fingerprint = (SELECT fingerprint FROM findings WHERE review_id = ${reviewId} AND id = ${findingId})`;
    this.recount(reviewId);
    this.refresh();
    return this.getReview(reviewId);
  }

  @callable({ description: "Team conventions included in every review prompt" })
  setNotes(notes: string) {
    this.setState({ ...this.state, notes: notes.slice(0, 2000) });
  }
}
