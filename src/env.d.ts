// Secrets (set with `wrangler secret put`, or in .dev.vars locally). They aren't in
// wrangler.jsonc, so `wrangler types` doesn't know about them.
interface __BaseEnv_Env {
  /** Webhook secret configured on the GitHub App or repository webhook. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** GitHub App ID + private key (.pem, PKCS#1 or PKCS#8): comments come from the app's bot account. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Alternative to a GitHub App: a fine-grained PAT (Pull requests: read & write). */
  GITHUB_TOKEN?: string;
  /** When set, repository dashboards need ?token=<value>. */
  DASHBOARD_TOKEN?: string;
  /** owner/repo pre-filled in the dashboard. */
  DEFAULT_REPO?: string;
}
