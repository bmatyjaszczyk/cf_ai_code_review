// End-to-end smoke test against a running deployment (local or deployed):
// starts a Playground review of a sample over the agent's WebSocket RPC, waits for
// the workflow to finish, prints the findings, then asks one chat question.
//
//   node scripts/smoke.ts [baseUrl] [sampleId]
//   node scripts/smoke.ts http://localhost:5173 ts

import { AgentClient } from "agents/client";
import { SAMPLES } from "../src/shared/samples.ts";

const base = new URL(process.argv[2] ?? "http://localhost:5173");
const sample = SAMPLES.find((s) => s.id === (process.argv[3] ?? "ts")) ?? SAMPLES[0];
const name = `playground-smoke${Math.random().toString(36).slice(2, 12)}`;

const client = new AgentClient({
  agent: "repo-agent",
  name,
  host: base.host,
  protocol: base.protocol === "https:" ? "wss" : "ws"
});
await client.ready;
const call = <T>(method: string, args: unknown[]) => client.call(method, args) as Promise<T>;

const t0 = Date.now();
const { reviewId } = await call<{ reviewId: string }>("startPlaygroundReview", [sample.filename, sample.content, base.origin]);
console.log(`started ${reviewId} (${sample.label})`);

type Detail = { review: { status: string; error: string | null; progress: { label: string; done: number; total: number }[] }; findings: any[] };
let detail: Detail;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  detail = (await call<Detail>("getReview", [reviewId]))!;
  const p = detail.review.progress.map((x) => `${x.label.split(" ")[0]} ${x.done}/${x.total}`).join(" | ");
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${detail.review.status}  ${p}`);
  if (detail.review.status === "done" || detail.review.status === "failed") break;
  if (Date.now() - t0 > 300_000) throw new Error("timed out");
}

if (detail.review.status === "failed") {
  console.error("FAILED:", detail.review.error);
  process.exit(1);
}

console.log(`\n${detail.findings.length} findings:`);
for (const f of detail.findings) {
  console.log(`  [${f.severity.padEnd(8)}] ${f.category.padEnd(21)} L${String(f.lineStart).padEnd(4)} ${f.title}  (${Math.round(f.confidence * 100)}%, ${f.source})`);
}

const messages = await call<{ role: string; content: string }[]>("ask", [reviewId, "Which finding should I fix first, and show the fix?"]);
console.log("\nchat answer:\n" + messages.at(-1)!.content.slice(0, 1500));
client.close();
process.exit(0);
