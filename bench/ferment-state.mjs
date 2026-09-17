// Where is a ferment run? Reads the newest session in <out>/sessions.
//   node ferment-state.mjs <out>            -> prints: none | planning | running | complete | failed
//   node ferment-state.mjs <out> <phase>    -> writes <out>/status.json (phase = waiting|running|finished)
import fs from "node:fs";
import path from "node:path";

const [out, phase] = process.argv.slice(2);
const dir = path.join(out, "sessions");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)) : [];
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const entries = files[0] ? fs.readFileSync(files[0], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const ev = entries.filter((e) => e.type === "custom" && e.customType === "scoby-ferment").map((e) => e.data);
const meta = entries.filter((e) => e.type === "custom" && e.customType === "scoby-ferment-meta").map((e) => e.data);

let state = "none";
const steps = {};
let current = "";
for (const e of ev) {
	if (e.type === "planned") {
		state = "running";
		e.plan.phases.forEach((p, i) => p.steps.forEach((s, j) => (steps[`step-${i + 1}.${j + 1}`] = { title: s.title, status: "pending" })));
	}
	if (e.type === "step_started") { (steps[e.stepId] ??= { title: "fix", status: "pending" }).status = "running"; current = e.stepId; }
	if (e.type === "step_finished") steps[e.stepId] && (steps[e.stepId].status = "done");
	if (e.type === "completed") state = "complete";
	if (e.type === "failed") state = "failed";
}
if (state === "none" && meta.some((m) => m.event === "plan_deferred")) state = "planning";

if (!phase) {
	console.log(state);
} else {
	const prev = fs.existsSync(path.join(out, "status.json")) ? JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8")) : {};
	const now = new Date().toISOString();
	const status = {
		updated: now,
		supervisor: phase,
		waitingSince: phase === "waiting" ? (prev.supervisor === "waiting" ? prev.waitingSince : now) : undefined,
		invocations: Number(process.env.INVOCATION ?? prev.invocations ?? 0),
		ferment: state,
		currentStep: current ? `${current} ${steps[current]?.title ?? ""}` : undefined,
		steps: `${Object.values(steps).filter((s) => s.status === "done").length}/${Object.keys(steps).length} done`,
		grades: ev.filter((e) => e.type === "phase_graded").map((e) => `${e.phaseId}:${e.grade}`),
		lastDeferral: meta.filter((m) => /deferred/.test(m.event)).at(-1),
	};
	fs.writeFileSync(path.join(out, "status.json"), JSON.stringify(status, null, 2));
}
