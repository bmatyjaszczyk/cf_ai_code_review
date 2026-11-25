import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SAMPLES } from "../shared/samples";
import type { ChatMessage, Finding, RepoState, ReviewDetail, ReviewSummary, Severity } from "../shared/types";
import { Markdown } from "./Markdown";

interface Config {
  githubConfigured: boolean;
  webhookConfigured: boolean;
  dashboardProtected: boolean;
  model: string;
  defaultRepo: string | null;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const CATEGORY_LABEL = (c: string) => c.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function safeStorage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

/** Each browser gets its own playground agent, so pasted code stays private to it. */
function playgroundName(): string {
  let id = safeStorage("playground-id");
  if (!id) id = safeStorage("playground-id", crypto.randomUUID().replace(/-/g, "").slice(0, 20));
  return `playground-${id}`;
}

function repoAgentName(repo: string): string | null {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, ""));
  return m ? `${m[1]}--${m[2]}`.toLowerCase() : null;
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  return { agent: p.get("agent"), review: p.get("review"), token: p.get("token") };
}

export function App() {
  const initial = useMemo(readUrl, []);
  const [config, setConfig] = useState<Config | null>(null);
  const [agentName, setAgentName] = useState(initial.agent ?? playgroundName());
  const [reviewId, setReviewId] = useState<string | null>(initial.review);
  const [token, setToken] = useState(initial.token ?? safeStorage("dashboard-token") ?? "");
  const [repoInput, setRepoInput] = useState(initial.agent && !initial.agent.startsWith("playground-") ? initial.agent.replace("--", "/") : "");
  const isPlayground = agentName.startsWith("playground-");

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c: Config) => {
      setConfig(c);
      if (c.defaultRepo && !repoInput) setRepoInput(c.defaultRepo);
    }).catch(() => setConfig(null));
  }, []);

  // Keep the URL shareable: ?agent=...&review=... (the token is never put in the URL).
  useEffect(() => {
    const p = new URLSearchParams();
    if (!isPlayground) p.set("agent", agentName);
    if (reviewId) p.set("review", reviewId);
    history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
  }, [agentName, reviewId, isPlayground]);

  useEffect(() => {
    if (initial.token) safeStorage("dashboard-token", initial.token);
  }, [initial.token]);

  const openRepo = () => {
    const name = repoAgentName(repoInput);
    if (name) {
      setAgentName(name);
      setReviewId(null);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <strong>AI Code Review</strong>
            <span className="muted"> · {config?.model.replace("@cf/meta/", "") ?? "Llama 3.3"} on Workers AI</span>
          </div>
        </div>
        <nav className="modes">
          <button className={isPlayground ? "tab active" : "tab"} onClick={() => { setAgentName(playgroundName()); setReviewId(null); }}>
            Playground
          </button>
          <form className="repo-form" onSubmit={(e) => { e.preventDefault(); openRepo(); }}>
            <input aria-label="GitHub repository" placeholder="owner/repo" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} className={!isPlayground ? "active" : ""} />
            <button className={!isPlayground ? "tab active" : "tab"} disabled={!repoAgentName(repoInput)}>Open repo</button>
          </form>
        </nav>
      </header>
      <Workspace
        key={agentName + token}
        agentName={agentName}
        token={token}
        config={config}
        reviewId={reviewId}
        onSelect={setReviewId}
        onToken={(t) => { safeStorage("dashboard-token", t); setToken(t); }}
      />
    </div>
  );
}

function Workspace(props: { agentName: string; token: string; config: Config | null; reviewId: string | null; onSelect: (id: string | null) => void; onToken: (t: string) => void }) {
  const { agentName, reviewId, onSelect } = props;
  const isPlayground = agentName.startsWith("playground-");
  const [state, setState] = useState<RepoState | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const agent = useAgent<RepoState>({
    agent: "repo-agent",
    name: agentName,
    query: props.token ? { token: props.token } : undefined,
    onStateUpdate: (s) => setState(s),
    onClose: (e: CloseEvent) => {
      if (e.code !== 1000) setConnError("Connection lost. Reconnecting…");
    },
    onOpen: () => setConnError(null)
  });
  const call = agent.call as <T>(method: string, args?: unknown[]) => Promise<T>;
  const summary = state?.reviews.find((r) => r.id === reviewId) ?? null;

  if (!isPlayground && props.config?.dashboardProtected && !props.token) {
    return <TokenGate onToken={props.onToken} />;
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        {isPlayground ? (
          <PlaygroundForm call={call} onStarted={onSelect} />
        ) : (
          <RepoPanel call={call} state={state} config={props.config} onStarted={onSelect} />
        )}
        <ReviewList reviews={state?.reviews ?? []} selected={reviewId} onSelect={onSelect} loading={!state} error={connError} />
      </aside>
      <section className="content">
        {summary ? (
          <ReviewView key={summary.id} summary={summary} call={call} />
        ) : (
          <EmptyState isPlayground={isPlayground} repo={state?.repo} config={props.config} />
        )}
      </section>
    </main>
  );
}

type Call = <T>(method: string, args?: unknown[]) => Promise<T>;

function TokenGate({ onToken }: { onToken: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <main className="gate">
      <form onSubmit={(e) => { e.preventDefault(); onToken(t); }} className="card">
        <h3>Dashboard token required</h3>
        <p className="muted">Repository dashboards on this deployment are protected. Enter the DASHBOARD_TOKEN.</p>
        <input type="password" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
        <button className="primary">Continue</button>
      </form>
    </main>
  );
}

function PlaygroundForm({ call, onStarted }: { call: Call; onStarted: (id: string) => void }) {
  const [filename, setFilename] = useState(SAMPLES[0].filename);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { reviewId } = await call<{ reviewId: string }>("startPlaygroundReview", [filename, content, location.origin]);
      onStarted(reviewId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h3>Review code</h3>
      <p className="muted small">Paste a source file or a unified diff (<code>git diff</code>). Or connect a repo so every non-draft PR gets reviewed automatically.</p>
      <div className="samples">
        {SAMPLES.map((s) => (
          <button key={s.id} className="chip" onClick={() => { setFilename(s.filename); setContent(s.content); }}>
            Load sample: {s.label}
          </button>
        ))}
      </div>
      <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="filename (sets the language)" aria-label="File name" />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste code or a diff…" spellCheck={false} rows={12} aria-label="Code" />
      {error && <div className="error">{error}</div>}
      <button className="primary" onClick={submit} disabled={busy || !content.trim()}>
        {busy ? "Starting…" : "Run review"}
      </button>
    </div>
  );
}

function RepoPanel({ call, state, config, onStarted }: { call: Call; state: RepoState | null; config: Config | null; onStarted: (id: string) => void }) {
  const [pr, setPr] = useState("");
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = Number(pr.replace(/.*\/pull\//, "").replace(/\D/g, ""));
      const { reviewId } = await call<{ reviewId: string }>("reviewPullRequest", [n, location.origin, true]);
      onStarted(reviewId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async () => {
    await call("setNotes", [notes ?? ""]);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="panel">
      <h3>{state?.repo ?? "…"}</h3>
      {config && !config.githubConfigured && <div className="warn small">GitHub credentials aren't configured on this deployment, so PR reviews can't run.</div>}
      <p className="muted small">Reviews start automatically when a PR is opened or marked ready for review. You can also run one by hand:</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="PR # or URL" aria-label="Pull request" />
        <button className="primary" disabled={busy || !/\d/.test(pr)}>{busy ? "…" : "Review"}</button>
      </form>
      {error && <div className="error">{error}</div>}
      <details className="notes">
        <summary>Team conventions ({state?.dismissedCount ?? 0} dismissed findings remembered)</summary>
        <p className="muted small">Added to every review prompt for this repo, e.g. "Money is always integer cents", "scripts/ is internal tooling, ignore blocking I/O there".</p>
        <textarea rows={5} value={notes ?? state?.notes ?? ""} onChange={(e) => setNotes(e.target.value)} aria-label="Team conventions" />
        <button onClick={saveNotes}>{saved ? "Saved ✓" : "Save conventions"}</button>
      </details>
    </div>
  );
}

function ReviewList({ reviews, selected, onSelect, loading, error }: { reviews: ReviewSummary[]; selected: string | null; onSelect: (id: string) => void; loading: boolean; error: string | null }) {
  return (
    <div className="review-list">
      <h4 className="muted">History</h4>
      {error && <div className="warn small">{error}</div>}
      {loading && <div className="muted small">Connecting…</div>}
      {!loading && reviews.length === 0 && <div className="muted small">No reviews yet.</div>}
      {reviews.map((r) => (
        <button key={r.id} className={`review-item ${selected === r.id ? "selected" : ""}`} onClick={() => onSelect(r.id)}>
          <div className="review-item-title">
            <StatusDot status={r.status} />
            <span>{r.prNumber ? `#${r.prNumber} ` : ""}{r.title}</span>
          </div>
          <div className="review-item-meta">
            <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
            {r.status === "done" && <Counts counts={r.counts} compact />}
          </div>
        </button>
      ))}
    </div>
  );
}

const StatusDot = ({ status }: { status: ReviewSummary["status"] }) => <span className={`dot dot-${status}`} title={status} />;

function Counts({ counts, compact }: { counts: Record<Severity, number>; compact?: boolean }) {
  const total = SEVERITIES.reduce((a, s) => a + counts[s], 0);
  if (total === 0) return <span className="sev-pill sev-none">{compact ? "clean" : "No issues"}</span>;
  return (
    <span className="counts">
      {SEVERITIES.filter((s) => counts[s]).map((s) => (
        <span key={s} className={`sev-pill sev-${s}`}>{counts[s]}{compact ? "" : ` ${s}`}</span>
      ))}
    </span>
  );
}

function EmptyState({ isPlayground, repo, config }: { isPlayground: boolean; repo?: string; config: Config | null }) {
  return (
    <div className="empty">
      <h2>{isPlayground ? "Find bugs before your reviewers do" : `Reviews for ${repo ?? "this repository"}`}</h2>
      <p className="muted">
        Each review runs as a durable <strong>Cloudflare Workflow</strong>: a deterministic secret scan, then four focused Llama 3.3 passes in parallel
        (security &amp; config · bugs, concurrency &amp; types · DB &amp; I/O performance · money math, error handling &amp; quality). The results are merged,
        deduplicated and ranked, then stored in this repo's <strong>Durable Object</strong> memory.
      </p>
      <ul className="muted">
        <li>Dismiss a false positive and later reviews in the same repo won't report it again.</li>
        <li>Ask follow-up questions about any review in the chat.</li>
        {!isPlayground && <li>{config?.webhookConfigured ? "Webhook is configured: new non-draft PRs are reviewed automatically." : "Webhook isn't configured on this deployment."}</li>}
      </ul>
      {isPlayground && <p>Load a sample on the left and press <strong>Run review</strong>.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- review view

interface CtxLine { num: number | null; mark: string; text: string }

/** Parse the line-numbered diff the agent stored, to show code next to each finding. */
function parseContext(ctx: string): Map<string, CtxLine[]> {
  const files = new Map<string, CtxLine[]>();
  let cur: CtxLine[] | null = null;
  for (const line of ctx.split("\n")) {
    const h = /^=== FILE: (.+) \([^)]*\) ===$/.exec(line);
    if (h) {
      cur = files.get(h[1]) ?? [];
      files.set(h[1], cur);
      continue;
    }
    if (!cur || line.startsWith("@@")) continue;
    const num = line.slice(0, 6).trim();
    cur.push({ num: num ? Number(num.slice(1)) : null, mark: line[7] ?? " ", text: line.slice(9) });
  }
  return files;
}

function excerpt(lines: CtxLine[] | undefined, start: number, end: number): CtxLine[] {
  if (!lines) return [];
  const from = lines.findIndex((l) => l.num !== null && l.num >= start - 2);
  if (from < 0) return [];
  const out: CtxLine[] = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (l.num !== null && l.num > end + 2) break;
    out.push(l);
    if (out.length > 40) break;
  }
  return out;
}

function ReviewView({ summary, call }: { summary: ReviewSummary; call: Call }) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [showDismissed, setShowDismissed] = useState(false);
  const versionKey = `${summary.status}:${summary.finishedAt}`;

  useEffect(() => {
    call<ReviewDetail | null>("getReview", [summary.id]).then(setDetail).catch(() => {});
  }, [summary.id, versionKey]);

  const ctx = useMemo(() => parseContext(detail?.context ?? ""), [detail?.context]);
  const findings = (detail?.findings ?? []).filter((f) => (filter === "all" || f.severity === filter) && (showDismissed || !f.dismissed));
  const dismissedCount = detail?.findings.filter((f) => f.dismissed).length ?? 0;

  const dismiss = async (f: Finding) => {
    const reason = prompt("Why is this not an issue? (remembered for this repo)", "false positive");
    if (reason === null) return;
    setDetail(await call<ReviewDetail>("dismissFinding", [summary.id, f.id, reason]));
  };
  const restore = async (f: Finding) => setDetail(await call<ReviewDetail>("restoreFinding", [summary.id, f.id]));

  return (
    <div className="review">
      <div className="review-header">
        <div>
          <h2>
            {summary.prNumber && <span className="muted">#{summary.prNumber} </span>}
            {summary.title}
          </h2>
          <div className="muted small">
            {summary.prUrl && <><a href={summary.prUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a> · </>}
            {summary.headSha && <code>{summary.headSha.slice(0, 7)}</code>} {summary.status === "done" && summary.finishedAt && `· finished in ${Math.round((summary.finishedAt - summary.createdAt) / 1000)}s`}
          </div>
        </div>
        {summary.status === "done" && <Counts counts={summary.counts} />}
      </div>

      {(summary.status === "queued" || summary.status === "running") && <Progress summary={summary} />}
      {summary.status === "failed" && <div className="error">Review failed: {summary.error}</div>}

      {summary.status === "done" && detail && (
        <div className="review-body">
          <div className="findings">
            <div className="filters">
              {(["all", ...SEVERITIES] as const).map((s) => (
                <button key={s} className={`chip ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>
                  {s === "all" ? `All (${detail.findings.filter((f) => !f.dismissed).length})` : `${s} (${detail.findings.filter((f) => f.severity === s && !f.dismissed).length})`}
                </button>
              ))}
              {dismissedCount > 0 && (
                <label className="small muted toggle">
                  <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> show {dismissedCount} dismissed
                </label>
              )}
            </div>
            {findings.length === 0 && <div className="card muted">{detail.findings.length ? "No findings match this filter." : "✅ No issues found in this change."}</div>}
            {findings.map((f, i) => (
              <FindingCard key={f.id} index={i + 1} finding={f} code={excerpt(ctx.get(f.file), f.lineStart, f.lineEnd)} onDismiss={() => dismiss(f)} onRestore={() => restore(f)} />
            ))}
            {summary.skippedFiles.length > 0 && (
              <details className="small muted">
                <summary>{summary.skippedFiles.length} file(s) not reviewed</summary>
                <ul>{summary.skippedFiles.map((s) => <li key={s}><code>{s}</code></li>)}</ul>
              </details>
            )}
          </div>
          <Chat reviewId={summary.id} call={call} initial={detail.messages} findings={detail.findings} />
        </div>
      )}
    </div>
  );
}

function Progress({ summary }: { summary: ReviewSummary }) {
  return (
    <div className="card progress">
      <div className="small muted">{summary.status === "queued" ? "Queued: starting workflow…" : "Workflow running: passes execute in parallel, each step retried on its own"}</div>
      {summary.progress.map((p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        return (
          <div key={p.id} className="progress-row">
            <span>{p.done >= p.total && p.total > 0 ? "✓" : <span className="spinner" />} {p.label}</span>
            <div className="bar"><div style={{ width: `${pct}%` }} /></div>
            <span className="muted small">{p.total ? `${p.done}/${p.total}` : "…"}</span>
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({ finding: f, index, code, onDismiss, onRestore }: { finding: Finding; index: number; code: CtxLine[]; onDismiss: () => void; onRestore: () => void }) {
  return (
    <article className={`card finding sev-border-${f.severity} ${f.dismissed ? "dismissed" : ""}`}>
      <header>
        <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
        <span className="tag">{CATEGORY_LABEL(f.category)}</span>
        {f.source === "secret-scan" && <span className="tag" title="Found by the regex/entropy scanner, not the LLM">deterministic</span>}
        <span className="loc"><code>{f.file}:{f.lineStart}{f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}</code></span>
        <span className="muted small conf">{Math.round(f.confidence * 100)}%</span>
      </header>
      <h3><span className="muted">#{index}</span> {f.title}</h3>
      {code.length > 0 && (
        <pre className="excerpt">
          {code.map((l, i) => {
            const hit = l.num !== null && l.num >= f.lineStart && l.num <= f.lineEnd;
            return (
              <div key={i} className={`ln ${l.mark === "+" ? "add" : l.mark === "-" ? "del" : ""} ${hit ? "hit" : ""}`}>
                <span className="num">{l.num ?? ""}</span>
                <span className="mark">{l.mark}</span>
                <span>{l.text}</span>
              </div>
            );
          })}
        </pre>
      )}
      <Markdown text={f.explanation} />
      {f.suggestion && (
        <details className="fix" open={f.severity === "critical"}>
          <summary>Suggested fix</summary>
          <Markdown text={f.suggestion} />
        </details>
      )}
      <footer>
        {f.dismissed ? <button onClick={onRestore}>Restore</button> : <button onClick={onDismiss} title="Mark as a false positive or accepted risk. Later reviews in this repo will skip it.">Dismiss</button>}
      </footer>
    </article>
  );
}

function Chat({ reviewId, call, initial, findings }: { reviewId: string; call: Call; initial: ChatMessage[]; findings: Finding[] }) {
  const [messages, setMessages] = useState(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [messages, busy]);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q, createdAt: Date.now() }]);
    try {
      setMessages(await call<ChatMessage[]>("ask", [reviewId, q]));
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${(e as Error).message}`, createdAt: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }, [busy, call, reviewId]);

  const suggestions = findings.length
    ? ["Which finding should I fix first and why?", "Write the fix for #1", "Explain #2 like I'm new to this codebase"]
    : ["What did you check?", "Any risky patterns even if not bugs?"];

  return (
    <aside className="chat card">
      <h4>Ask about this review</h4>
      <div className="messages">
        {messages.length === 0 && (
          <div className="suggestions">
            {suggestions.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
          </div>
        ))}
        {busy && <div className="msg msg-assistant"><span className="spinner" /> thinking…</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Is #3 really exploitable?" aria-label="Message" />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </aside>
  );
}
