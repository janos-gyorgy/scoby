// Summarize one bench run: requests and tokens per request (from scoby-budget entries and
// assistant usage), shaping activity, recalls, router events, gates, diff size.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const out = process.argv[2];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const entries = walk(path.join(out, "sessions")).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));

const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
const budget = entries.filter((e) => e.type === "custom" && e.customType === "scoby-budget" && !e.data.event);
const recalls = entries.filter((e) => e.type === "custom" && e.customType === "scoby-budget" && e.data.event === "recall");
const router = entries.filter((e) => e.type === "custom" && e.customType === "scoby-router").map((e) => e.data);
const compactions = entries.filter((e) => e.type === "compaction");
const inputs = assistants.map((a) => (a.message.usage?.input ?? 0) + (a.message.usage?.cacheRead ?? 0) + (a.message.usage?.cacheWrite ?? 0)).filter((x) => x > 0);
const sorted = [...inputs].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const toolCalls = assistants.flatMap((a) => (a.message.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name));
const errors = assistants.filter((a) => a.message.stopReason === "error").map((a) => String(a.message.errorMessage ?? "").slice(0, 120));

function gate(cmd, args) {
	try {
		execFileSync(cmd, args, { cwd: path.join(out, "repo"), stdio: "pipe", timeout: 300000 });
		return { ok: true, errors: [] };
	} catch (e) {
		const text = String(e.stdout ?? "") + String(e.stderr ?? "");
		return { ok: false, errors: [...new Set(text.split("\n").filter((l) => /error/i.test(l)).map((l) => l.replace(/\(\d+,\d+\)/, "").trim()))] };
	}
}
const known = /use-toast\.ts: error TS2307/;
const gates = {
	tscApp: gate("npx", ["tsc", "--noEmit", "-p", "tsconfig.app.json"]),
	tscServer: gate("npx", ["tsc", "--noEmit", "-p", "server/tsconfig.json"]),
	viteBuild: gate("npx", ["vite", "build", "--outDir", "/tmp/claude-1000/bench-vite-" + path.basename(out)]),
};
const newErrors = Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.errors.filter((l) => !known.test(l))]));
const diffstat = execFileSync("git", ["-C", path.join(out, "repo"), "diff", "--shortstat", "HEAD"], { encoding: "utf8" }).trim()
	+ " | untracked: " + execFileSync("git", ["-C", path.join(out, "repo"), "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
const [exitCode, seconds] = fs.readFileSync(path.join(out, "exit"), "utf8").trim().split(" ").map(Number);

const report = {
	label: path.basename(out), exitCode, minutes: +(seconds / 60).toFixed(1),
	requests: assistants.length, errors: errors.length,
	inputTokens: { total: sum(inputs), p50: pct(0.5), p95: pct(0.95), max: sorted.at(-1) },
	outputTokens: sum(assistants.map((a) => a.message.usage?.output ?? 0)),
	shaping: {
		budget: budget[0]?.data.budget, shapedRequests: budget.filter((b) => b.data.before > b.data.after).length,
		overBudget: budget.filter((b) => b.data.overBudget).length,
		stubbed: sum(budget.map((b) => b.data.stubbed ?? 0)), dropped: sum(budget.map((b) => b.data.dropped ?? 0)),
		fixedTokens: budget.at(-1)?.data.fixedTokens, charsPerToken: budget.at(-1)?.data.charsPerToken,
	},
	recalls: recalls.length, nativeCompactions: compactions.length,
	toolCalls: Object.fromEntries([...new Set(toolCalls)].map((t) => [t, toolCalls.filter((x) => x === t).length])),
	router: router.filter((r) => r.event !== "select" || r.reason !== "session start").map((r) => `${r.event} ${r.target ?? ""} ${r.kind ?? r.reason ?? ""}`.trim()),
	models: [...new Set(assistants.map((a) => a.message.model))],
	gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.ok ? "green" : `${newErrors[k].length} new error(s)`])),
	newErrors, diffstat, firstErrors: errors.slice(0, 3),
};
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
