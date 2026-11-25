// Types shared by the Worker (agent, workflow) and the React dashboard.

export type Severity = "critical" | "high" | "medium" | "low";

export type Category =
  | "security"
  | "secrets"
  | "correctness"
  | "concurrency"
  | "type-safety"
  | "financial-precision"
  | "database-performance"
  | "blocking-io"
  | "error-handling"
  | "code-quality"
  | "configuration";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

export interface Finding {
  id: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  category: Category;
  severity: Severity;
  title: string;
  explanation: string;
  suggestion: string;
  confidence: number;
  /** Stable identity across pushes, used for dedupe and "dismiss" memory. */
  fingerprint: string;
  /** Which analysis pass produced it ("secret-scan" for the deterministic scanner). */
  source: string;
  /** True when it was posted as an inline PR comment (line is inside the diff). */
  inline?: boolean;
  dismissed?: boolean;
}

export type ReviewStatus = "queued" | "running" | "done" | "failed";

export interface PassProgress {
  id: string;
  label: string;
  total: number;
  done: number;
}

export interface ReviewSummary {
  id: string;
  source: "github" | "playground";
  title: string;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  status: ReviewStatus;
  progress: PassProgress[];
  counts: Record<Severity, number>;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  skippedFiles: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface ReviewDetail {
  review: ReviewSummary;
  findings: Finding[];
  messages: ChatMessage[];
  /** Line-numbered diff that was reviewed, for showing code next to findings. */
  context: string;
}

/** State the RepoAgent broadcasts to every connected dashboard. */
export interface RepoState {
  repo: string;
  /** Free-text team conventions, injected into every review prompt. */
  notes: string;
  reviews: ReviewSummary[];
  dismissedCount: number;
}

export function emptyCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}
