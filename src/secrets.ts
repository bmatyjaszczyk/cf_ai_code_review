// Deterministic secret detection. Regexes and an entropy check find hardcoded
// credentials more reliably than an LLM. The model is still told about secrets,
// but these findings never depend on it.

import type { ParsedFile } from "./diff";
import type { Finding, Severity } from "./shared/types";

interface Rule {
  id: string;
  title: string;
  re: RegExp;
  severity: Severity;
  /** Capture group holding the secret value (0 = whole match). */
  group?: number;
  /** Generic rules also require high entropy and no placeholder words. */
  generic?: boolean;
}

const RULES: Rule[] = [
  { id: "private-key", title: "Private key committed to the repository", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, severity: "critical" },
  { id: "aws-access-key", title: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: "critical" },
  { id: "aws-secret-key", title: "AWS secret access key", re: /aws.{0,20}(?:secret|private).{0,20}['"`]([A-Za-z0-9/+=]{40})['"`]/i, severity: "critical", group: 1 },
  { id: "github-token", title: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, severity: "critical" },
  { id: "stripe-live-key", title: "Stripe live secret key", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/, severity: "critical" },
  { id: "slack-token", title: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, severity: "high" },
  { id: "google-api-key", title: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/, severity: "high" },
  { id: "openai-key", title: "OpenAI / Anthropic API key", re: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}\b/, severity: "critical" },
  { id: "jwt", title: "Hardcoded JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: "high" },
  { id: "connection-string", title: "Database connection string with embedded password", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^:\s'"`/]+:([^@\s'"`]+)@/i, severity: "high", group: 1, generic: true },
  {
    id: "generic-secret",
    title: "Hardcoded credential",
    re: /\b[\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret|token)[\w-]*["'`]?\s*(?::|=|:=|=>)\s*["'`]([^"'`\s]{8,})["'`]/i,
    severity: "high",
    group: 1,
    generic: true
  }
];

const PLACEHOLDER = /(change[-_]?me|example|placeholder|dummy|sample|your[-_]|xxx+|\*\*\*|<[^>]+>|\$\{|\{\{|process\.env|os\.environ|getenv|env\(|redacted|todo|replace|secret_here|password123?$|^test|fake)/i;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function mask(secret: string): string {
  return secret.length <= 8 ? "****" : `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

export function scanSecrets(files: ParsedFile[]): Omit<Finding, "id" | "fingerprint">[] {
  const findings: Omit<Finding, "id" | "fingerprint">[] = [];
  for (const file of files) {
    const isTestFile = /(^|\/)(tests?|__tests__|spec|fixtures?)\/|\.(test|spec)\./i.test(file.path);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add" || line.newLine === null) continue;
        for (const rule of RULES) {
          const m = rule.re.exec(line.text);
          if (!m) continue;
          const value = m[rule.group ?? 0] ?? m[0];
          if (rule.generic && (PLACEHOLDER.test(value) || shannonEntropy(value) < 3)) continue;
          const severity: Severity = isTestFile && rule.severity === "critical" ? "high" : rule.severity;
          findings.push({
            file: file.path,
            lineStart: line.newLine,
            lineEnd: line.newLine,
            category: "secrets",
            severity,
            title: rule.title,
            explanation:
              `Line ${line.newLine} contains what looks like a ${rule.title.toLowerCase()} (\`${mask(value)}\`). ` +
              `Anything committed to git stays in history even after it is deleted, so treat this credential as leaked.` +
              (isTestFile ? " It is in a test file, but real-looking keys in tests still get copied and leaked." : ""),
            suggestion:
              "Revoke and rotate the credential now. Load it from a secret store or environment variable " +
              "(e.g. `wrangler secret put`, `process.env.X`) and add a pre-commit secret scanner.",
            confidence: rule.generic ? 0.7 : 0.95,
            source: "secret-scan"
          });
          break; // one finding per line is enough
        }
      }
    }
  }
  return findings;
}
