// One-shot judge: grades a diff against the starter-stock task with a fixed rubric.
// A different model family from the builder (Nemotron on NIM). Default: Gemini 3.5 Flash with the
// FULL diff. JUDGE=groq uses gpt-oss-120b, but Groq's free tier allows 8K tokens/minute, so the diff
// gets clipped — and git orders files alphabetically, so the UI (src/) is what gets cut: the first
// Groq verdict on Kimchi's result said "lead time: no, notifies: unknown" for exactly that reason.
//   node bench/judge.mjs <repo-dir> <base-ref> [head-ref]    (head omitted = working tree incl. untracked)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [repo, base, head] = process.argv.slice(2);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let diff;
if (head) {
	diff = git("diff", `${base}..${head}`, "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json", ":(exclude).kimchi");
} else {
	diff = git("diff", base, "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json");
	for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
		diff += `\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(path.join(repo, f), "utf8").split("\n").map((l) => "+" + l).join("\n");
	}
}
const stat = head ? git("diff", "--stat", `${base}..${head}`) : git("diff", "--stat", base);
const JUDGE = process.env.JUDGE ?? "gemini";
const MAX = JUDGE === "groq" ? 17000 : 400000; // groq: ~5K tokens of diff to fit 8K/min
const clipped = diff.length > MAX ? diff.slice(0, MAX) + `\n[diff cut: ${diff.length - MAX} more chars]` : diff;

const prompt = `You are grading a code change to a kombucha brewing web app (React + Hono + Postgres/drizzle).
The task was:
"Starter is made via an F1 brewed with the dedicated starter recipe, seeded from existing starter liquid, then
stored in the fridge. So making more takes a full F1 cycle. Build a feature that tracks how much starter I have,
plans brewing more when stock runs low, and notifies me in time."

Answer each rubric question from the diff only. If the diff is cut and you cannot see the answer, say "unknown".
1. stock_tracked: is there a persisted starter stock quantity?
2. consumes_on_batch: does starting a batch (F1) deduct starter from stock?
3. starter_batch_consumes_starter: does starting a STARTER batch also deduct starter (it is seeded from starter)?
4. starter_batch_adds_stock: does finishing a starter batch add to stock?
5. lead_time_warning: does the warning account for the time a new starter batch takes (warn a cycle ahead), rather than only a fixed low threshold?
6. notifies_in_app: is the low-stock state surfaced to the user in the UI?
7. migration_safety: are schema changes a NEW migration rather than edits to an existing migration file?

Reply with ONLY JSON:
{"stock_tracked":"yes|no|unknown","consumes_on_batch":"...","starter_batch_consumes_starter":"...","starter_batch_adds_stock":"...",
 "lead_time_warning":"...","notifies_in_app":"...","migration_safety":"...","grade":"A|B|C|D|F","rationale":"2-3 sentences"}

## diff --stat
${stat}

## diff
${clipped}`;

const endpoint = JUDGE === "groq"
	? { url: "https://api.groq.com/openai/v1/chat/completions", key: process.env.GROQ_API_KEY, model: "openai/gpt-oss-120b" }
	: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: process.env.GEMINI_API_KEY, model: "gemini-3.5-flash" };
const res = await fetch(endpoint.url, {
	method: "POST",
	headers: { Authorization: `Bearer ${endpoint.key}`, "Content-Type": "application/json", "User-Agent": "scoby/0.1" },
	body: JSON.stringify({ model: endpoint.model, temperature: 0, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
});
const data = await res.json();
if (!res.ok) {
	console.error(JSON.stringify(data).slice(0, 400));
	process.exit(1);
}
const text = data.choices[0].message.content ?? "";
const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
const verdict = { ...JSON.parse(json), judge: endpoint.model, diffChars: diff.length, diffClipped: diff.length > MAX, promptTokens: data.usage?.prompt_tokens };
console.log(JSON.stringify(verdict, null, 2));
