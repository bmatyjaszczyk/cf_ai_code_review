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

<!-- Add later prompts below as the project evolves. -->

## 2. Runtime prompts (used by the app)

| Prompt | Location |
|---|---|
| Per-pass system prompt (scope, checklist, line-citation rules, severity rubric, team conventions) | `src/llm.ts` → `systemPrompt()` and `PASSES[].checklist` |
| JSON schema for structured findings | `src/llm.ts` → `findingsSchema()` |
| Follow-up chat system prompt (grounded in the review's diff and findings) | `src/llm.ts` → `chatAboutReview()` |
