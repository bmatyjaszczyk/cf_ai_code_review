// ReviewWorkflow: a review is a durable, multi-step job. Each step's result is
// checkpointed, so if one LLM call fails or the isolate restarts, only that step
// is retried. The webhook handler returns right away and GitHub never waits on us.
//
//   load diff -> secret scan -> [4 analysis passes x N chunks, in parallel]
//             -> merge & rank -> post PR review -> save to the RepoAgent

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { getAgentByName } from "agents";
import { chunkFiles, parsePatch, playgroundToFiles, shouldSkip, type DiffFile } from "./diff";
import { getPullRequest, getRepoToken, listPullFiles, postReview, setCommitStatus, type ReviewComment } from "./github";
import { PASSES, runPass, type RawFinding } from "./llm";
import { countBySeverity, inlineCommentBody, mergeFindings, summaryBody } from "./merge";
import { scanSecrets } from "./secrets";
import type { Finding } from "./shared/types";

export interface ReviewParams {
  agentName: string;
  reviewId: string;
  baseUrl: string;
  github?: { owner: string; repo: string; number: number; headSha: string; installationId: number | null };
  playground?: { filename: string; content: string };
}

const LLM_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" } as const;
const API_STEP = { retries: { limit: 4, delay: "3 seconds", backoff: "exponential" }, timeout: "1 minute" } as const;

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep) {
    const p = event.payload;
    const agent = await getAgentByName(this.env.RepoAgent, p.agentName);
    const gh = p.github;
    const dashboardUrl = `${p.baseUrl}/?agent=${encodeURIComponent(p.agentName)}&review=${encodeURIComponent(p.reviewId)}`;

    try {
      // 1. Load the diff (GitHub PR files API or the pasted playground input).
      const loaded = await step.do("load diff", API_STEP, async () => {
        if (!gh) return { title: null, prUrl: null, files: playgroundToFiles(p.playground!.filename, p.playground!.content) };
        const token = await getRepoToken(this.env, gh.owner, gh.repo, gh.installationId);
        const [pr, files] = await Promise.all([getPullRequest(token, gh.owner, gh.repo, gh.number), listPullFiles(token, gh.owner, gh.repo, gh.number)]);
        await setCommitStatus(token, gh.owner, gh.repo, gh.headSha, "pending", "Reviewing changes…", dashboardUrl);
        return { title: pr.title as string | null, prUrl: pr.html_url as string | null, files };
      });

      const skipped: string[] = [];
      const reviewable: DiffFile[] = [];
      for (const f of loaded.files) (shouldSkip(f) ? skipped.push(f.path) : reviewable.push(f));
      if (reviewable.length === 0 && loaded.files.length === 0) throw new NonRetryableError("The diff is empty: nothing to review");

      // Parsing and chunking are deterministic, so they don't need checkpoints:
      // replaying them after a restart gives the same result.
      const parsed = reviewable.map(parsePatch);
      const { chunks, skipped: overBudget } = chunkFiles(parsed);
      skipped.push(...overBudget.map((s) => `${s} (diff too large)`));

      const memory = await step.do("load memory", async () => {
        await agent.markRunning(p.reviewId, { title: loaded.title ?? undefined, prUrl: loaded.prUrl ?? undefined, chunks: chunks.length });
        return agent.getMemory(gh?.number ?? null);
      });

      // 2. Deterministic secret scan (no LLM).
      const secretFindings = await step.do("secret scan", async () => {
        const found = scanSecrets(parsed);
        await agent.passDone(p.reviewId, "secret-scan");
        return found;
      });

      // 3. LLM passes: one step per (pass, chunk), all running concurrently.
      //    Each one retries on its own; a failure after all retries skips just that unit.
      const passResults = await Promise.all(
        PASSES.flatMap((pass) =>
          chunks.map(async (chunk) => {
            try {
              return await step.do(`${pass.id} pass, chunk ${chunk.index + 1}/${chunks.length}`, LLM_STEP, async () => {
                const found = await runPass(this.env, pass, chunk, memory.notes);
                await agent.passDone(p.reviewId, pass.id);
                return found;
              });
            } catch (e) {
              console.error(`pass ${pass.id} chunk ${chunk.index} failed permanently`, e);
              await step.do(`${pass.id} pass, chunk ${chunk.index + 1} gave up`, () => agent.passDone(p.reviewId, pass.id));
              return [] as RawFinding[];
            }
          })
        )
      );

      // 4. Merge: validate lines, dedupe across passes, apply memory, rank.
      const minConfidence = Number(this.env.MIN_CONFIDENCE ?? 0.5);
      const { findings, suppressed } = mergeFindings([...secretFindings, ...passResults.flat()], parsed, {
        minConfidence,
        dismissed: new Set(memory.dismissed)
      });

      // 5. Post to GitHub as one PR review with inline comments and a summary.
      let postedFingerprints: string[] = [];
      if (gh) {
        postedFingerprints = await step.do("post review to GitHub", API_STEP, async () => {
          const alreadyPosted = new Set(memory.postedOnPr);
          const maxInline = Number(this.env.MAX_INLINE_COMMENTS ?? 20);
          const inline = findings.filter((f) => f.inline && !alreadyPosted.has(f.fingerprint)).slice(0, maxInline);
          const repeated = findings.filter((f) => alreadyPosted.has(f.fingerprint)).length;
          const comments: ReviewComment[] = inline.map((f) => ({ path: f.file, line: f.lineStart, side: "RIGHT", body: inlineCommentBody(f, dashboardUrl) }));
          const inlineIds = new Set(inline.map((f) => f.id));
          const token = await getRepoToken(this.env, gh.owner, gh.repo, gh.installationId);
          const body = summaryBody({
            findings: findings.filter((f) => !alreadyPosted.has(f.fingerprint)),
            inlineIds,
            repeated,
            suppressed,
            filesReviewed: parsed.length,
            skipped,
            headSha: gh.headSha,
            dashboardUrl
          });
          const res = await postReview(token, gh.owner, gh.repo, gh.number, { commitId: gh.headSha, body, comments });
          const c = countBySeverity(findings);
          await setCommitStatus(
            token, gh.owner, gh.repo, gh.headSha,
            c.critical > 0 ? "failure" : "success",
            findings.length ? `${findings.length} finding(s): ${c.critical} critical, ${c.high} high` : "No issues found",
            dashboardUrl
          );
          return [...memory.postedOnPr, ...(res.inlinePosted ? inline.map((f) => f.fingerprint) : [])];
        });
      }

      // 6. Save to the agent (memory + live dashboard update).
      const context = chunks.map((c) => c.text).join("\n\n").slice(0, 200_000);
      await step.do("save results", () =>
        agent.completeReview(p.reviewId, { findings: findings as Finding[], postedFingerprints, context, skipped })
      );
      return { findings: findings.length, suppressed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await step.do("mark failed", async () => {
        await agent.failReview(p.reviewId, msg);
        if (gh) {
          const token = await getRepoToken(this.env, gh.owner, gh.repo, gh.installationId).catch(() => null);
          if (token) await setCommitStatus(token, gh.owner, gh.repo, gh.headSha, "error", "AI review failed", dashboardUrl);
        }
      });
      throw e;
    }
  }
}

