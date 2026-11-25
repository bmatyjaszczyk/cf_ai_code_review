# cf_ai_code_review

An AI reviewer for GitHub pull requests, built entirely on Cloudflare. When a non-draft PR is opened, it reviews the diff with Llama 3.3 and posts inline comments, a summary and a status check. A small dashboard shows each review and has a chat for follow-up questions.

> **Note:** this is an MVP for the Cloudflare assignment. It's meant to show the approach and the process (see [PROMPTS.md](PROMPTS.md)), not to be a polished, production-ready code reviewer. Llama 3.3 still produces some noise and false positives.

## See it in action

- **Live app:** https://cf-ai-code-review.bartosz-matyjaszczyk.workers.dev. Open the Playground, click **Load sample**, then **Run review**, then ask about the result in the chat.
- **Demo repo:** https://github.com/bmatyjaszczyk/cf_ai_code_review-demo, with the GitHub App installed.
- **Example PR reviewed by the bot:** https://github.com/bmatyjaszczyk/cf_ai_code_review-demo/pull/1
- **Its dashboard:** https://cf-ai-code-review.bartosz-matyjaszczyk.workers.dev/?agent=bmatyjaszczyk--cf_ai_code_review-demo

## How it maps to the assignment

| Requirement | Implementation |
|---|---|
| LLM | Llama 3.3 70B on Workers AI with JSON-schema output (`src/llm.ts`) |
| Workflow / coordination | Cloudflare Workflows: each review is a durable pipeline of retried steps (`src/workflow.ts`) |
| User input (chat) | React dashboard on Workers static assets: paste-code playground and a chat about each review (`src/client`) |
| Memory / state | One Agents SDK Durable Object (SQLite) per repo: review history, findings, chat, dismissed findings, lines already commented on (`src/agent.ts`) |

```
GitHub PR ──webhook (HMAC)──▶ Worker ──▶ RepoAgent (Durable Object) ──▶ ReviewWorkflow
                                                    ▲                          │ secret scan + 4 Llama passes in parallel
Dashboard (chat, playground) ──WebSocket──┘                          ▼ merge, dedupe → PR comments + status
```

## What we did

- **Triggered by PRs:** reviews start on `opened`, `reopened`, `ready_for_review` and new pushes. Drafts are skipped. The webhook signature is verified, and the webhook replies immediately while the review runs in a Workflow.
- **Focused analysis:** a deterministic secret scanner (regex plus entropy) and four focused LLM passes:
  - security and configuration;
  - bugs, concurrency and type safety;
  - database and I/O performance;
  - money math and error handling.
- **Reliable inline comments:** the model sees the diff with line numbers, and every cited line is checked against the diff, so comments land on real changed lines.
- **No repeated noise:** on a push, only files changed since the last review are re-reviewed, and lines already commented on aren't commented on again.
- **Posted as a GitHub App:** comments come from the app's bot account, with a red or green status check.
- **Dashboard:** live progress, findings with code excerpts, dismiss to suppress a finding in later reviews, and a chat grounded in the review.
- **Tests:** unit tests for diff parsing, the secret scanner, model-output validation, dedupe and GitHub key handling.

## What we didn't do

- **Diff only:** the reviewer sees only the diff, not the whole repo, so missing context can cause false positives.
- **Llama 3.3 limits:** it sometimes mislabels categories or reports the same issue twice under different names.
- **Large PRs are capped:** at most 4 chunks, about 36k tokens of diff; the rest is listed as not reviewed.
- **No chat inside GitHub:** you can't reply to the bot in the PR thread; the chat lives in the dashboard.
- **Unprotected public endpoints:** no rate limiting or auth on the public playground, and no multi-tenant setup or billing.
- **Unfinished features cut from the UI:** "team conventions" and manual PR re-runs (`setNotes` and `reviewPullRequest` in `src/agent.ts`) were removed from the dashboard to keep it simple.

## Running it

Requirements: Node 20+ and a Cloudflare account (Workers AI and Workflows are on the free plan).

```bash
npm install
npx wrangler login
npm run dev        # http://localhost:5173: the Playground works with no other setup
npm test           # unit tests
npm run deploy     # deploy to your account
```

Workers AI always runs remotely, so local dev uses your Cloudflare account.

**Automatic PR reviews (optional):**
1. Create a GitHub App with:
   - webhook URL `https://<your-worker>.workers.dev/webhook/github` and a webhook secret;
   - repository permissions *Pull requests: Read & write*, *Commit statuses: Read & write* and *Contents: Read*;
   - a subscription to *Pull request* events.
2. Generate a private key and install the app on a repo.
3. Store the credentials as Worker secrets:
   ```bash
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the .pem as is
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   ```
4. Open a non-draft PR. The review appears in about a minute.

Instead of an app, you can use a fine-grained token (`GITHUB_TOKEN`) with a repository webhook. Settings such as the model, max inline comments and minimum confidence are in `wrangler.jsonc` under `vars`.

## Project layout

```
src/server.ts    Worker entry: webhook, agent routing
src/workflow.ts  Review pipeline (Cloudflare Workflows)
src/agent.ts     Per-repo memory and chat (Agents SDK Durable Object)
src/llm.ts       Prompts, passes, output validation
src/diff.ts      Diff parsing and chunking
src/secrets.ts   Secret scanner
src/merge.ts     Dedupe, fingerprints, GitHub comment formatting
src/github.ts    GitHub App auth and REST calls
src/client/      React dashboard
```

Built with Claude Code. All prompts are in [PROMPTS.md](PROMPTS.md).
