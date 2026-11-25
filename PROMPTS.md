# Prompts

This project was built with AI assistance (Claude Code). As the assignment requires, this file records:

1. **Development prompts**: what I asked the coding assistant, in order.
2. **Runtime prompts**: the prompts the app itself sends to Llama 3.3 (they live in code).

## 1. Development prompts

### Prompt 1: exploring the idea

> Ok, we need to do assignment for Cloudflare Job I'm interviewing too. the requirements and context:
>
> *Optional Assignment: … build a type of AI-powered application on Cloudflare … LLM (recommend using Llama 3.3 on Workers AI) … Workflow / coordination (recommend using Workflows, Workers or Durable Objects) … User input via chat or voice … Memory or state … AI-assisted coding is encouraged, but you have to submit prompt history.*
>
> here is additional page with info: https://developers.cloudflare.com/agents/. Any recommendations? I was thinking about ai-code-review. let's explore that. it needs to be a finished product, doesn't have to be big, we are looking for working MVP. Let's explore first the functionalities we can achieve: -critical bugs, security, sql injection, object injection and other vulnerabilities - hardcoded secrets and credentials - insecure configuration - conurrency & race conditions - language specific quirks and type safety - financial precision and floating point math - database performance (N+1 for example and indexing) - blocking i/o operations - code quality and error handling

*Outcome:* mapped the requirements to Workers AI + Workflows + Agents SDK, grouped the nine categories into four LLM passes plus a deterministic secret scanner, and agreed the MVP scope.

### Prompt 2: trigger on new pull requests

> it should work when new MR has been created (which is not Draft) is this something we can achieve here? So run this on the Diff from the MR?

*Outcome:* webhook → Worker → Workflow design: draft filtering, `ready_for_review` handling, fast webhook response, idempotent workflow IDs, inline comments only on valid diff lines, per-repo memory.

### Prompt 3: GitHub

> they want github repo so lets do that

*Outcome:* implemented the GitHub integration (App auth with a PAT fallback, `pull_request` events, PR Reviews API with inline comments, commit status), the RepoAgent memory, the ReviewWorkflow pipeline, the React dashboard with playground and chat, unit tests and the docs.

### Prompt 4: end-to-end test

> 1. login done. you can continue. 2. renaming done in github, you can check. 3. after end-to-end test 4. can't I just create a public repo for it?

*Outcome:* ran real reviews against Workers AI with `scripts/smoke.ts`. The first run showed Llama re-reporting SQL injection in every pass, and a dedupe bug that merged three different secrets on adjacent lines. Fixed with per-pass "not in scope" lists, an off-topic filter, a short "analysis" field before the findings (better recall: the race condition, N+1 and money-math issues were then caught), a stricter error-handling rule and title-similarity dedupe. Webhook signature and draft filtering were tested with signed `curl` requests.

### Prompts 5–13: GitHub App setup and first production run

> *(short exchanges while setting up the GitHub App)*: "github recommends using github apps instead of fine-grained token. i connected Cloudflare to my account. check the connection and if we can use it to this case insteadl of token" · "ok. push and deploy and give me webhook url. i filled the rest already so i jus need the url" · "try it now" · "i don't see Generate a private key. looks like i need to do it other way" · "ok done. it was in different place but secret is put now. try it again." · "done." · "PR is open. check now" · "Got 405 on the recent deliveries. i double checked the secret and looks fine. can you verify?" · "delivery is OK now. added new commit. check"

*Outcome:* explained that the Cloudflare GitHub integration (Workers Builds) can't post comments for us, so a separate GitHub App is needed. Deployed, found the missing private-key secret, and traced the 405 to a webhook URL without the `/webhook/github` path. The first automatic reviews worked end to end.

### Prompt 14: less noise on push

> yes *(to: per-line "already commented" memory, incremental review on push, better titles and scope filters)*

> also add in the readme link to the demo repo, so Cloudflare can see the result of it.

*Outcome:* `line_key` column (schema migration on startup), incremental review via the compare API with findings carried over for untouched files, title rules in the prompt, more off-topic filters, and README links to the live app, demo repo and example PR.

### Prompt 15: verifying incremental review in production

> pushed a new commit. check

*Outcome:* the push was reviewed incrementally (only the changed file, about 35 s), but all 15 findings were posted again inline. Cause: reviews saved before the `line_key` column existed had empty keys, so the "already commented" memory was empty. Fix: on startup the agent backfills missing line keys from the line-numbered diff stored with each review. Added a unit test for that.

### Prompt 16: wording and submission check

> added, check now

*Outcome:* the next push was reviewed with no repeated comments ("16 finding(s) on lines already commented on are not repeated"), so the fix was confirmed in production.

> ok. change this and tell me if all AC are met, to have our MVP. and if we are ready to submit https://github.com/bmatyjaszczyk/cf_ai_code_review as the repo with the solution for Cloudflare job

*Outcome:* the summary no longer shows a ✅ "no new issues found" while earlier findings are still open; it says how many are still open. Audited the repo against the assignment requirements before submission.

### Prompt 17: UI cleanup and README

> ok UI doesn't fully work on https://cf-ai-code-review.bartosz-matyjaszczyk.workers.dev/  when I click on the History, everything dissapear. Review the UI and leave only what's needed. currently there is too much going on,  like team conventions, or sending questions? nothing works. either fix it or hide it

> afet that, create me a short, descriptive Readme. add what we did, what we did not, and that this is just to show the process rather than be a perfect tool

*Outcome:* reproduced it in headless Chromium. The chat's auto-scroll effect returned the Promise that newer browsers return from `scrollIntoView`, React treated that as the effect's cleanup and crashed, and the whole page went blank. Fixed, plus an error boundary so a crash shows a message instead of a blank page. Removed "team conventions" and the manual PR re-run form from the UI. Verified the playground review, History switching and chat (playground and repo) in the browser against production. Rewrote the README to be short: what it does, what was done, what wasn't, and that it's an MVP that shows the process.

<!-- Add later prompts below as the project evolves. -->

## 2. Runtime prompts (used by the app)

| Prompt | Location |
|---|---|
| Per-pass system prompt (scope, checklist, line-citation rules, severity rubric, team conventions) | `src/llm.ts` → `systemPrompt()` and `PASSES[].checklist` |
| JSON schema for structured findings | `src/llm.ts` → `findingsSchema()` |
| Follow-up chat system prompt (grounded in the review's diff and findings) | `src/llm.ts` → `chatAboutReview()` |
