// Ferment — pi glue for the phase/step engine.
//
//   before_agent_start -> plan the goal (planner role) before the model touches the repo
//   context       -> append the current step's brief to every request (context only: it never
//                    enters the session log, so it costs nothing to carry)
//   agent_end     -> the model stopped: mark the step done, run gates at a phase boundary, judge
//                    the phase, then trigger the next step
//
// The engine decides; the model only executes the step in front of it. State is rebuilt from
// `scoby-ferment` session entries, so a resumed session continues where it stopped.
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "../router/core.ts";
import type { RouterHandle } from "../router/index.ts";
import { errorLines, newErrors, type GateRun } from "../guard/gates.ts";
import { apply, initial, next, planMatchesGoal, stepBrief, type Event, type PlanInput, type State } from "./core.ts";

const ENTRY = "scoby-ferment";

const PLANNER_PROMPT = `You plan a coding task for an agent that will execute it one step at a time.
The repository is described first; THE GOAL comes last — plan for that goal and nothing else.
Reply with ONLY a JSON object:
{"goal":"the goal restated in one sentence, in your own words","criteria":["..."],"assumptions":["..."],"phases":[{"title":"...","steps":[{"title":"...","detail":"what to change, which files, how to verify"}]}]}
- 2-4 phases, 2-5 steps each; each step must be doable in one focused session.
- Model the whole data flow the goal implies, including second-order effects (what consumes and what produces the same resource).
- Nobody can answer questions: state assumptions explicitly instead of asking.
- Follow the repo's existing stack and conventions (shown below). Do not introduce a different storage
  mechanism, framework or pattern when the repo already has one.`;

const JUDGE_PROMPT = `You are an independent judge. You did not write this code.
Grade the phase against the goal and the phase's steps, from the diff.
Reply with ONLY JSON: {"grade":"A|B|C|D|F","rationale":"2-3 sentences","fix":"concrete changes needed if D or F, else empty"}
D or F means the phase does not do what it claims, or breaks something. Style nits are not a D.`;

export function setupFerment(pi: ExtensionAPI, cfg: RouterConfig, router: RouterHandle | undefined) {
	if (!cfg.ferment?.enabled) return;
	const gates = cfg.ferment.gates ?? cfg.finish?.gates ?? [];
	let state: State | undefined;
	let baseline: GateRun[] | undefined;
	let busy = false;

	const record = (event: Event) => {
		state = apply(state!, event);
		pi.appendEntry(ENTRY, event as any);
	};

	const runGates = (cwd: string): GateRun[] =>
		gates.map((cmd) => {
			const [bin, ...args] = cmd.split(/\s+/);
			const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
			return { cmd, code: r.status ?? 1, lines: errorLines(`${r.stdout ?? ""}\n${r.stderr ?? ""}`) };
		});

	const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).stdout ?? "";

	async function ask(ctx: ExtensionContext, role: string, prompt: string, maxTokens: number): Promise<string> {
		const target = router?.targetFor(role) ?? router?.current();
		const model: any = target ? ctx.modelRegistry.find(target.provider, target.modelId) : ctx.model;
		if (!model) throw new Error(`no model for role ${role}`);
		const res: any = await (ctx.modelRegistry as any).complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens, signal: ctx.signal },
		);
		if (res.stopReason === "error") throw new Error(res.errorMessage ?? "model error");
		return (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	}

	function parseJSON<T>(text: string): T {
		const i = text.indexOf("{"), j = text.lastIndexOf("}");
		if (i < 0 || j <= i) throw new Error(`no JSON in reply: ${text.slice(0, 120)}`);
		return JSON.parse(text.slice(i, j + 1)) as T;
	}

	// Rebuild state from the session (resume) and baseline the gates.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === ENTRY);
		const goal = (ctx.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message?.role === "user") as any)?.message;
		if (entries.length) {
			state = entries.reduce((s: State, e: any) => apply(s, e.data as Event), initial(textOf(goal)));
		}
		baseline = runGates(ctx.cwd);
		pi.appendEntry(ENTRY + "-meta", { event: "baseline", gates: baseline.map((g) => ({ cmd: g.cmd, code: g.code, errors: g.lines.length })) });
	});

	// Plan before the model's first call. The goal comes from the event, NOT the session: at
	// agent_start the prompt is not in the session entries yet, so both ferment runs (r4, r5) planned
	// with an EMPTY goal — r4 invented "store stock in a JSON file", r5 "add a notes field".
	pi.on("before_agent_start", async (event: any, ctx) => {
		if (state) return;
		const goal = String(event.prompt ?? "").trim();
		if (!goal) {
			pi.appendEntry(ENTRY + "-meta", { event: "no_goal" });
			return;
		}
		state = initial(goal);
		try {
			// repo context first, the goal LAST: with the goal on top and ~8K chars of repo after it,
			// the r5 planner lost the task and planned an unrelated "notes" feature
			const prompt = (extra = "") => `${PLANNER_PROMPT}\n\n${repoContext(ctx)}\n\n## THE GOAL (plan for exactly this)\n${goal}${extra}`;
			let plan = parseJSON<PlanInput & { goal?: string }>(await ask(ctx, "planner", prompt(), 4096));
			let check = planMatchesGoal(goal, plan);
			if (!check.ok) {
				pi.appendEntry(ENTRY + "-meta", { event: "plan_off_goal", restated: plan.goal, shared: check.shared });
				plan = parseJSON<PlanInput & { goal?: string }>(await ask(ctx, "planner", prompt(
					`\n\nYour previous plan restated the goal as "${plan.goal ?? "?"}" — that is not the goal above. Plan again, for the goal above.`,
				), 4096));
				check = planMatchesGoal(goal, plan);
			}
			if (!check.ok) {
				// refusing beats building the wrong feature faithfully for an hour
				state = apply(state!, { type: "failed", reason: `plan does not match the goal (restated as: ${plan.goal ?? "?"})` });
				pi.appendEntry(ENTRY, { type: "failed", reason: "plan does not match the goal" } as any);
				return;
			}
			record({ type: "planned", plan });
			const first = next(state!);
			if (first.kind === "activate_phase") record({ type: "phase_activated", phaseId: first.phaseId });
			const step = next(state!);
			if (step.kind === "run_step") record({ type: "step_started", phaseId: step.phaseId, stepId: step.stepId });
		} catch (e) {
			// planning failed: leave ferment off rather than block the run
			pi.appendEntry(ENTRY + "-meta", { event: "plan_failed", error: String(e).slice(0, 300) });
			state = undefined;
		}
	});

	// Every request carries the current step (context only — not stored in the session).
	pi.on("context", async (event, _ctx) => {
		if (!state || state.status !== "running") return;
		const a = next(state);
		if (a.kind !== "run_step") return;
		const messages = [...(event.messages as any[]), {
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: stepBrief(state, a.phaseId, a.stepId, a.resume) }],
		}];
		return { messages: messages as any };
	});

	// The model stopped talking: advance the engine.
	pi.on("agent_end", async (event: any, ctx) => {
		if (!state || state.status !== "running" || busy) return;
		const last = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
		if (!last || last.stopReason !== "stop") return; // errors belong to the router
		busy = true;
		try {
			const a = next(state);
			if (a.kind === "run_step") {
				record({ type: "step_finished", phaseId: a.phaseId, stepId: a.stepId, summary: textOf(last).slice(0, 400) });
			}
			await advance(ctx);
		} finally {
			busy = false;
		}
	});

	/** Run engine actions that need no model turn, then trigger the next step (or stop). */
	async function advance(ctx: ExtensionContext) {
		for (let i = 0; i < 12; i++) {
			const a = next(state!);
			switch (a.kind) {
				case "activate_phase":
					record({ type: "phase_activated", phaseId: a.phaseId });
					break;
				case "gate": {
					const fresh = newErrors(baseline ?? [], runGates(ctx.cwd));
					if (fresh.length) {
						const report = fresh.map((g) => `$ ${g.cmd}\n${g.lines.slice(0, 20).join("\n")}`).join("\n\n");
						record({ type: "gate_failed", phaseId: a.phaseId, report });
					} else record({ type: "gate_passed", phaseId: a.phaseId });
					break;
				}
				case "judge": {
					const phase = state!.phases.find((p) => p.id === a.phaseId)!;
					const diff = git(ctx.cwd, "diff", "HEAD") + git(ctx.cwd, "status", "--short");
					const steps = phase.steps.map((s) => `- ${s.id} ${s.title}: ${s.summary ?? ""}`).join("\n");
					try {
						const verdict = parseJSON<{ grade: string; rationale?: string; fix?: string }>(
							await ask(ctx, "judge", `${JUDGE_PROMPT}\n\n## Goal\n${state!.goal}\n\n## Phase ${phase.id} — ${phase.title}\n${steps}\n\n## diff\n${diff.slice(0, 120000)}`, 2048),
						);
						record({ type: "phase_graded", phaseId: a.phaseId, grade: verdict.grade, rationale: verdict.rationale, fix: verdict.fix });
					} catch (e) {
						// a judge that cannot answer must not stall the run: pass the phase, note it
						pi.appendEntry(ENTRY + "-meta", { event: "judge_failed", phaseId: a.phaseId, error: String(e).slice(0, 200) });
						record({ type: "phase_graded", phaseId: a.phaseId, grade: "C", rationale: "judge unavailable" });
					}
					break;
				}
				case "run_step":
					record({ type: "step_started", phaseId: a.phaseId, stepId: a.stepId });
					pi.sendMessage(
						{ customType: ENTRY, content: `[scoby] Next: ${a.stepId}. The step brief is in your context.`, display: true },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					return;
				case "complete":
					record({ type: "completed", summary: state!.phases.map((p) => `${p.id}:${p.grade ?? "?"}`).join(" ") });
					return;
				case "fail":
					record({ type: "failed", reason: a.reason });
					return;
				case "done":
					return;
			}
		}
	}

	pi.registerCommand("ferment", {
		description: "scoby: show the ferment plan and where the run is",
		handler: async (_args, ctx) => {
			if (!state) return ctx.ui.notify("scoby: no ferment in this session", "info");
			const lines = state.phases.map((p) => `${p.id} ${p.title} [${p.status}${p.grade ? " " + p.grade : ""}]\n` + p.steps.map((s) => `   ${s.id} ${s.title} [${s.status}]`).join("\n"));
			ctx.ui.notify(`ferment ${state.status}\n${lines.join("\n")}`, "info");
		},
	});
}

/**
 * What the repo looks like, for the planner. Without this it plans against an imagined project: in
 * ferment-32k-r4 it chose "store stock in a JSON file" for a Postgres/drizzle app.
 */
function repoContext(ctx: ExtensionContext): string {
	const read = (p: string) => {
		try {
			return require("node:fs").readFileSync(require("node:path").join(ctx.cwd, p), "utf8") as string;
		} catch {
			return "";
		}
	};
	const notes = (read("CLAUDE.md") || read("AGENTS.md")).slice(0, 6000);
	const files = spawnSync("git", ["ls-files"], { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).stdout ?? "";
	const tracked = files.split("\n").filter((f) => f && !/^(node_modules|dist)\//.test(f)).slice(0, 400).join("\n");
	const pkg = read("package.json").slice(0, 2000);
	return [
		notes ? `## Repo notes (CLAUDE.md / AGENTS.md)\n${notes}` : "",
		pkg ? `## package.json\n${pkg}` : "",
		`## Tracked files\n${tracked}`,
	].filter(Boolean).join("\n\n");
}

function textOf(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	return (c ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}
