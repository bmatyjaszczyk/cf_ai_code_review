// Minimal GitHub REST client for Workers: webhook verification, GitHub App auth,
// and the handful of endpoints the reviewer needs.

import type { DiffFile } from "./diff";

const API = "https://api.github.com";
const UA = "cf-ai-code-review";
const enc = new TextEncoder();

// ------------------------------------------------------------- webhook signature

/** Check `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) in constant time. */
export async function verifyWebhookSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const expected = enc.encode("sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const actual = enc.encode(header);
  if (expected.byteLength !== actual.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------ app auth

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub gives out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"), but WebCrypto only
 * imports PKCS#8. Wrap the key in the PKCS#8 envelope so the .pem file can be
 * pasted into `wrangler secret put` as is.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der;
  const rsaAlgorithmId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...rsaAlgorithmId, 0x04, ...derLength(der.length), ...der];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

async function appJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)));
  return `${unsigned}.${b64url(sig)}`;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh<T>(token: string, method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept,
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GitHubError(res.status, `GitHub ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY));
}

/**
 * Get a token for a repository. Uses the GitHub App installation token (comments
 * show up as the app's bot account) and falls back to a personal access token
 * when GITHUB_TOKEN is set.
 */
export async function getRepoToken(env: Env, owner: string, repo: string, installationId?: number | null): Promise<string> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    let id = installationId;
    if (!id) {
      const inst = await gh<{ id: number }>(jwt, "GET", `/repos/${owner}/${repo}/installation`);
      id = inst.id;
    }
    const tok = await gh<{ token: string }>(jwt, "POST", `/app/installations/${id}/access_tokens`, { repositories: [repo] });
    return tok.token;
  }
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  throw new Error("GitHub is not configured: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.");
}

// ------------------------------------------------------------------- endpoints

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  state: string;
  head: { sha: string };
  base: { ref: string };
}

export const getPullRequest = (token: string, owner: string, repo: string, n: number) =>
  gh<PullRequest>(token, "GET", `/repos/${owner}/${repo}/pulls/${n}`);

/** Changed files with their patches (GitHub omits `patch` for binary or huge files). */
export async function listPullFiles(token: string, owner: string, repo: string, n: number, max = 300): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (let page = 1; files.length < max; page++) {
    const batch = await gh<{ filename: string; status: string; patch?: string }[]>(token, "GET", `/repos/${owner}/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
    files.push(...batch.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? "" })));
    if (batch.length < 100) break;
  }
  return files.slice(0, max);
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/**
 * Post one review: a summary body plus inline comments. If GitHub rejects a
 * comment's line (422), retry without the inline comments so the summary still
 * gets posted.
 */
export async function postReview(
  token: string,
  owner: string,
  repo: string,
  n: number,
  review: { commitId: string; body: string; comments: ReviewComment[] }
): Promise<{ inlinePosted: boolean; url: string }> {
  const path = `/repos/${owner}/${repo}/pulls/${n}/reviews`;
  try {
    const r = await gh<{ html_url: string }>(token, "POST", path, { commit_id: review.commitId, body: review.body, event: "COMMENT", comments: review.comments });
    return { inlinePosted: true, url: r.html_url };
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 422 || review.comments.length === 0) throw e;
    const r = await gh<{ html_url: string }>(token, "POST", path, { commit_id: review.commitId, body: review.body, event: "COMMENT" });
    return { inlinePosted: false, url: r.html_url };
  }
}

/** Commit status shown in the PR checks list. Optional: failures are ignored. */
export async function setCommitStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  description: string,
  targetUrl: string | null
): Promise<void> {
  try {
    await gh(token, "POST", `/repos/${owner}/${repo}/statuses/${sha}`, {
      state,
      description: description.slice(0, 140),
      context: "AI code review",
      ...(targetUrl ? { target_url: targetUrl } : {})
    });
  } catch (e) {
    console.warn("commit status failed (missing 'Commit statuses' permission?)", e);
  }
}

export function parsePullRequestUrl(input: string): { owner: string; repo: string; number: number } | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(input.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}
