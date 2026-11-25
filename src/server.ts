// Worker entry point.
//   POST /webhook/github  GitHub App / repo webhook: pull_request events
//   GET  /api/config      what this deployment has configured (for the UI)
//   /agents/repo-agent/*  Agents SDK WebSocket + RPC (the dashboard)
//   everything else       React dashboard (static assets)

import { getAgentByName, routeAgentRequest } from "agents";
import { agentNameForRepo, repoFromAgentName } from "./agent";
import { githubConfigured, verifyWebhookSignature } from "./github";

export { RepoAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Actions that mean "this PR is ready for review". */
const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: { draft: boolean; state: string; title: string; html_url: string; head: { sha: string } };
  repository: { name: string; owner: { login: string } };
  installation?: { id: number };
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: "GITHUB_WEBHOOK_SECRET is not configured" }, 503);
  const body = await request.text();
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
    return json({ error: "invalid signature" }, 401);
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") return json({ ok: true, pong: true });
  if (event !== "pull_request") return json({ ignored: `event ${event}` }, 202);

  const payload = JSON.parse(body) as PullRequestEvent;
  const pr = payload.pull_request;
  const reviewOnPush = env.REVIEW_ON_PUSH === "true" && payload.action === "synchronize";
  if (!REVIEW_ACTIONS.has(payload.action) && !reviewOnPush) return json({ ignored: `action ${payload.action}` }, 202);
  if (pr.draft) return json({ ignored: "draft pull request" }, 202);
  if (pr.state !== "open") return json({ ignored: `pull request is ${pr.state}` }, 202);

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const agent = await getAgentByName(env.RepoAgent, agentNameForRepo(owner, repo));
  // Returns as soon as the workflow is queued. GitHub expects an answer within
  // 10 seconds, and the review itself takes much longer.
  const result = await agent.enqueueGithubReview({
    number: payload.number,
    headSha: pr.head.sha,
    title: pr.title,
    prUrl: pr.html_url,
    installationId: payload.installation?.id ?? null,
    baseUrl: new URL(request.url).origin,
    incremental: payload.action === "synchronize"
  });
  return json({ queued: !result.duplicate, ...result }, 202);
}

/**
 * Repo dashboards show code from (possibly private) repos. When DASHBOARD_TOKEN is
 * set, they require ?token=. Playground agents are per-browser and always open.
 */
function authorizeAgent(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  if (/^playground-[a-z0-9-]{8,64}$/.test(name)) return;
  if (!repoFromAgentName(name)) return json({ error: "unknown agent" }, 404);
  if (env.DASHBOARD_TOKEN && url.searchParams.get("token") !== env.DASHBOARD_TOKEN) {
    return json({ error: "dashboard token required" }, 401);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/github" && request.method === "POST") {
      try {
        return await handleWebhook(request, env);
      } catch (e) {
        console.error("webhook failed", e);
        return json({ error: (e as Error).message }, 500);
      }
    }

    if (url.pathname === "/api/config") {
      return json({
        githubConfigured: githubConfigured(env),
        webhookConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
        dashboardProtected: Boolean(env.DASHBOARD_TOKEN),
        model: env.MODEL,
        defaultRepo: env.DEFAULT_REPO ?? null
      });
    }

    const agentResponse = await routeAgentRequest(request, env, {
      onBeforeConnect: (req) => authorizeAgent(req, env),
      onBeforeRequest: (req) => authorizeAgent(req, env)
    });
    if (agentResponse) return agentResponse;

    return json({ error: "not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
