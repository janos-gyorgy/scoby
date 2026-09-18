// Ferment — pi glue for the phase/step engine.
//
// Interactive (pi TUI / RPC), the flow János asked for:
//   1. you type what you want          -> one choice: "Plan & build" or "Just answer" (chat stays chat)
//   2. you get a plan                   -> Approve / Change… (one sentence, re-plan) / Cancel
//   3. it builds on a scoby/<goal> branch, progress above the editor, ntfy on your phone
//   4. models gone? it waits inside pi and resumes by itself
// Print mode (bench): no dialogs — the prompt is the goal, the plan is accepted, and a supervisor
// (bench/patient.sh) resumes the session after outages.
//
//   before_agent_start -> choose, plan, approve (or catch up a resumed run)
//   context            -> append the current step's brief to every request (context only)
//   agent_end          -> step done -> gates / judge / next step; errors -> wait for capacity
//
// State lives in `scoby-ferment` session entries; the latest `planned` event starts the current run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "../router/core.ts";
import type { RouterHandle } from "../router/index.ts";
import { errorLines, newErrors, type GateRun } from "../guard/gates.ts";
import { makeNotifier, type Notification } from "../notify/ntfy.ts";
import { clearLock, readLock, refusal, repoRoot, writeLock } from "./lock.ts";
import {
	apply, assertPlanShape, initial, latestRun, next, planMatchesGoal, renderPlan, renderProgress, stepBrief,
	type Event, type PlanInput, type State,
} from "./core.ts";

const ENTRY = "scoby-ferment";
const META = ENTRY + "-meta";
const WIDGET = "scoby";
const BUILD = "Plan & build";
const CHAT = "Just answer";
const APPROVE = "Approve";
const CHANGE = "Change…";
const CANCEL = "Cancel";

const PLANNER_PROMPT = `You plan a coding task for an agent that will execute it one step at a time.
The repository is described first; THE GOAL comes last — plan for that goal and nothing else.
Reply with ONLY a JSON object:
{"goal":"the goal restated in one sentence, in your own words","criteria":["..."],"assumptions":["..."],"phases":[{"title":"...","steps":[{"title":"...","detail":"what to change, which files, how to verify"}]}]}
- 2-4 phases, 2-5 steps each; each step must be doable in one focused session.
- Model the whole data flow the goal implies, including second-order effects (what consumes and what produces the same resource).
- State assumptions explicitly; a human reviews the plan before any code is written.
- Follow the repo's existing stack and conventions (shown below). Do not introduce a different storage
  mechanism, framework or pattern when the repo already has one.`;

const JSON_ONLY = "IMPORTANT: your previous reply was not a JSON object. Output ONLY the JSON object — no reasoning, no prose, no code fence.";

const JUDGE_PROMPT = `You are an independent judge. You did not write this code.
Grade the phase against the goal and the phase's steps, from the diff.
Reply with ONLY JSON: {"grade":"A|B|C|D|F","rationale":"2-3 sentences","fix":"concrete changes needed if D or F, else empty"}
D or F means the phase does not do what it claims, or breaks something. Style nits are not a D.`;

type Plan = PlanInput & { goal?: string };

export function setupFerment(pi: ExtensionAPI, cfg: RouterConfig, router: RouterHandle | undefined) {
	if (!cfg.ferment?.enabled) return;
	const fc = cfg.ferment;
	const gates = fc.gates ?? cfg.finish?.gates ?? [];
	const waitIntervalMs = (fc.waitIntervalSeconds ?? 600) * 1000;
	const waitNotifyAfterMs = (fc.waitNotifyAfterSeconds ?? 1800) * 1000;

	let state: State | undefined;
	let baseline: GateRun[] | undefined;
	let busy = false;
	// Print mode: stop WITHOUT recording a failure (no model now); the supervisor resumes the session.
	let deferred = false;
	// Interactive: the prompt that started this agent run must not reach the model (cancel, waiting…).
	let skipTurn = false;
	let waiting: { since: number; timer: ReturnType<typeof setInterval>; notified: boolean } | undefined;

	const isUnavailable = (e: unknown) => /unavailable after \d+ attempts/.test(String(e));
	const interactive = (ctx: ExtensionContext) => ctx.hasUI;
	const notify = makeNotifier(cfg.notify, (error) => pi.appendEntry(META, { event: "notify_failed", error }));
	const push = (n: Notification) => void notify({ ...n, tags: n.tags ?? ["seedling"] });

	const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

	const runGates = (cwd: string): GateRun[] =>
		gates.map((cmd) => {
			const [bin, ...args] = cmd.split(/\s+/);
			const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
			return { cmd, code: r.status ?? 1, lines: errorLines(`${r.stdout ?? ""}\n${r.stderr ?? ""}`) };
		});

	function showProgress(ctx: ExtensionContext, note?: string) {
		if (!interactive(ctx)) return;
		ctx.ui.setWidget(WIDGET, state ? renderProgress(state, note) : undefined);
	}

	// One build per repo: the lock names the session that owns the run in progress (lock.ts).
	const sessionFile = (ctx: ExtensionContext): string => (ctx.sessionManager as any).getSessionFile?.() ?? "";
	function holdLock(ctx: ExtensionContext) {
		if (!state) return;
		const root = repoRoot(ctx.cwd);
		if (state.status !== "running") return clearLock(root);
		const a = next(state);
		const prev = readLock(root);
		const mine = prev?.sessionFile === sessionFile(ctx) ? prev : undefined;
		writeLock(root, {
			sessionFile: sessionFile(ctx), pid: process.pid, goal: state.goal,
			startedAt: mine?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
			step: a.kind === "run_step" ? a.stepId : undefined,
		});
	}
	/** Refuses a NEW build while another session's run is in progress here. */
	function locked(ctx: ExtensionContext): boolean {
		const why = refusal(readLock(repoRoot(ctx.cwd)), sessionFile(ctx));
		if (!why) return false;
		pi.appendEntry(META, { event: "locked", by: readLock(repoRoot(ctx.cwd))?.sessionFile });
		if (interactive(ctx)) ctx.ui.notify(why, "warning");
		else {
			process.stderr.write(why + "\n");
			deferred = true;
		}
		return true;
	}

	/** Every engine event goes through here: state, session entry, panel, the lock, and the phone. */
	function record(ctx: ExtensionContext, event: Event) {
		state = apply(state!, event);
		pi.appendEntry(ENTRY, event as any);
		holdLock(ctx);
		showProgress(ctx);
		const title = state.goal.split("\n")[0].slice(0, 80);
		if (event.type === "phase_graded") {
			const phase = state.phases.find((p) => p.id === event.phaseId)!;
			const stillBad = (event.grade === "D" || event.grade === "F") && phase.status === "completed";
			push(stillBad
				? { title: `scoby needs you — ${phase.title} still graded ${event.grade}`, message: `${title}\n${event.rationale ?? ""}`, priority: "high", tags: ["warning"] }
				: { title: `scoby: ${phase.title} — ${event.grade}`, message: `${title}\n${event.rationale ?? ""}`, tags: ["white_check_mark"] });
		}
		if (event.type === "failed") push({ title: "scoby needs you — the run stopped", message: `${title}\n${event.reason}`, priority: "high", tags: ["rotating_light"] });
		if (event.type === "completed") {
			const stat = git(ctx.cwd, "diff", "--shortstat").stdout.trim();
			const untracked = git(ctx.cwd, "ls-files", "--others", "--exclude-standard").stdout.split("\n").filter(Boolean).length;
			push({ title: "scoby finished", message: `${title}\nGrades: ${event.summary}\n${stat || "no tracked changes"}; ${untracked} new file(s)`, tags: ["tada"] });
		}
	}

	/**
	 * One-shot call for the planner/judge roles, with the router's failover: every target in the
	 * role's chain, a few rounds with backoff. A reply that fails `validate` is re-asked with a
	 * JSON-only reminder (r7: a reasoning model answered in prose) without cooling the provider.
	 */
	async function ask(ctx: ExtensionContext, role: string, prompt: string, maxTokens: number, validate?: (text: string) => void, rounds = 3): Promise<string> {
		const chain = router?.chainFor(role).length ? router.chainFor(role) : router?.current() ? [router.current()!] : [];
		const errors: string[] = [];
		for (let round = 0; round < rounds; round++) {
			for (const target of chain) {
				const model: any = ctx.modelRegistry.find(target.provider, target.modelId);
				if (!model) continue;
				try {
					const res: any = await (ctx.modelRegistry as any).complete(
						model,
						{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
						{ maxTokens, signal: ctx.signal },
					);
					if (res.stopReason === "error") throw new Error(res.errorMessage ?? "model error");
					const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					if (!text.trim()) throw new Error("empty reply");
					try {
						validate?.(text);
					} catch (bad) {
						errors.push(`${target.raw}: unusable reply (${(bad as Error).message.slice(0, 80)})`);
						prompt = prompt.includes(JSON_ONLY) ? prompt : `${prompt}\n\n${JSON_ONLY}`;
						continue;
					}
					return text;
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					errors.push(`${target.raw}: ${message.slice(0, 120)}`);
					router?.markFailed(target.raw, message);
				}
			}
			if (ctx.signal?.aborted || round === rounds - 1) break;
			const scale = Number(process.env.SCOBY_BACKOFF_SCALE ?? 1); // tests shrink the waits
			await new Promise((r) => setTimeout(r, [10_000, 30_000, 60_000][round] * scale));
		}
		throw new Error(`${role} unavailable after ${errors.length} attempts: ${errors.slice(-3).join(" | ")}`);
	}

	function parseJSON<T>(text: string): T {
		const i = text.indexOf("{"), j = text.lastIndexOf("}");
		if (i < 0 || j <= i) throw new Error(`no JSON in reply: ${text.slice(0, 120)}`);
		return JSON.parse(text.slice(i, j + 1)) as T;
	}

	/** One plan from the planner, checked for shape and for matching the goal. */
	async function draftPlan(ctx: ExtensionContext, goal: string, feedback: { plan: Plan; ask: string }[]): Promise<Plan> {
		const revisions = feedback.map((f, i) =>
			`\n\n## Revision request ${i + 1}\nFor this earlier plan:\n${JSON.stringify(f.plan)}\nthe user asked: "${f.ask}". Apply it in the new plan.`).join("");
		const prompt = (extra = "") => `${PLANNER_PROMPT}\n\n${repoContext(ctx.cwd)}\n\n## THE GOAL (plan for exactly this)\n${goal}${revisions}${extra}`;
		const isPlan = (t: string) => assertPlanShape(parseJSON(t)); // r8: a phase without steps
		let plan = parseJSON<Plan>(await ask(ctx, "planner", prompt(), 8192, isPlan));
		let check = planMatchesGoal(goal, plan);
		if (!check.ok) {
			pi.appendEntry(META, { event: "plan_off_goal", restated: plan.goal, shared: check.shared });
			plan = parseJSON<Plan>(await ask(ctx, "planner", prompt(`\n\nYour previous plan restated the goal as "${plan.goal ?? "?"}" — that is not the goal above. Plan again, for the goal above.`), 8192, isPlan));
			check = planMatchesGoal(goal, plan);
			if (!check.ok) throw new Error(`plan does not match the goal (restated as: ${plan.goal ?? "?"})`);
		}
		return plan;
	}

	/** Plan, let the human approve or change it, then start the run. Returns false if nothing starts. */
	async function planAndStart(ctx: ExtensionContext, goal: string): Promise<boolean> {
		if (locked(ctx)) return false; // before spending a planner call
		const feedback: { plan: Plan; ask: string }[] = [];
		for (let round = 1; round <= 6; round++) {
			let plan: Plan;
			try {
				if (interactive(ctx)) ctx.ui.setWidget(WIDGET, [`scoby — planning${round > 1 ? ` revision ${round}` : ""}…`]);
				plan = await draftPlan(ctx, goal, feedback);
			} catch (e) {
				if (isUnavailable(e)) {
					pi.appendEntry(META, { event: "plan_deferred", error: String(e).slice(0, 300) });
					if (interactive(ctx)) startWaiting(ctx, { kind: "plan", goal });
					else deferred = true;
					return false;
				}
				pi.appendEntry(META, { event: "plan_failed", error: String(e).slice(0, 300) });
				if (interactive(ctx)) {
					ctx.ui.setWidget(WIDGET, undefined);
					ctx.ui.notify(`scoby: planning failed — ${String(e).slice(0, 200)}`, "error");
				} else {
					state = apply(initial(goal), { type: "failed", reason: `planning failed: ${String(e).slice(0, 200)}` });
					pi.appendEntry(ENTRY, { type: "failed", reason: "planning failed" } as any);
				}
				return false;
			}

			if (interactive(ctx)) {
				pi.appendEntry(META, { event: "plan_draft", round, plan });
				ctx.ui.setWidget(WIDGET, renderPlan(plan, round));
				push({ title: "scoby: plan ready — waiting for you", message: `${plan.goal ?? goal}\n${plan.phases.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}`, priority: "high", tags: ["memo"] });
				const choice = await ctx.ui.select("scoby: build this plan?", [APPROVE, CHANGE, CANCEL]);
				if (choice === CHANGE) {
					const change = (await ctx.ui.input("What should change?", "e.g. starting a starter batch consumes starter too"))?.trim();
					if (change) {
						feedback.push({ plan, ask: change });
						pi.appendEntry(META, { event: "plan_feedback", round, feedback: change });
					}
					continue;
				}
				if (choice !== APPROVE) {
					ctx.ui.setWidget(WIDGET, undefined);
					ctx.ui.notify("scoby: plan cancelled", "info");
					pi.appendEntry(META, { event: "plan_cancelled", round });
					return false;
				}
			}

			if (interactive(ctx) && fc.branch !== false) ensureBranch(ctx, plan.goal ?? goal);
			state = initial(goal);
			record(ctx, { type: "planned", plan, goal });
			const first = next(state!);
			if (first.kind === "activate_phase") record(ctx, { type: "phase_activated", phaseId: first.phaseId });
			const step = next(state!);
			if (step.kind === "run_step") record(ctx, { type: "step_started", phaseId: step.phaseId, stepId: step.stepId });
			return true;
		}
		if (interactive(ctx)) ctx.ui.notify("scoby: too many plan revisions — start again with a sharper request", "warning");
		return false;
	}

	/** Work on a scoby/<goal> branch so the human's branch stays untouched. */
	function ensureBranch(ctx: ExtensionContext, goal: string) {
		const head = git(ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD");
		if (head.status !== 0) return pi.appendEntry(META, { event: "branch_skipped", why: "not a git repo" });
		if (head.stdout.trim().startsWith("scoby/")) return;
		const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "build";
		const name = `scoby/${slug}-${new Date().toISOString().slice(0, 10)}`;
		const made = git(ctx.cwd, "checkout", "-b", name);
		const ok = made.status === 0 || git(ctx.cwd, "checkout", name).status === 0;
		pi.appendEntry(META, { event: ok ? "branch" : "branch_failed", name, from: head.stdout.trim(), error: made.stderr.slice(0, 200) });
		ctx.ui.notify(ok ? `scoby: working on branch ${name}` : `scoby: could not create ${name} — building on ${head.stdout.trim()}`, ok ? "info" : "warning");
	}

	/** Interactive only: no model right now — probe on a timer, then resume or re-plan. */
	type WaitFor = { kind: "resume" } | { kind: "plan"; goal: string };
	function startWaiting(ctx: ExtensionContext, what: WaitFor) {
		if (waiting) return;
		const since = Date.now();
		showProgress(ctx, "waiting for models");
		if (!state) ctx.ui.setWidget(WIDGET, ["scoby — no model available, waiting to plan…"]);
		pi.appendEntry(META, { event: "waiting", for: what.kind });
		const timer = setInterval(async () => {
			if (!waiting || busy) return;
			if (!waiting.notified && Date.now() - since >= waitNotifyAfterMs) {
				waiting.notified = true;
				push({ title: "scoby: waiting for model capacity", message: `No builder model has answered for ${Math.round((Date.now() - since) / 60000)} min. I'll carry on when one does.`, priority: "low", tags: ["hourglass"] });
			}
			busy = true;
			try {
				await ask(ctx, "builder", "Reply with the single word OK.", 16, undefined, 1);
			} catch {
				busy = false;
				return; // still down
			}
			busy = false;
			clearInterval(timer);
			waiting = undefined;
			pi.appendEntry(META, { event: "capacity_back", waitedSeconds: Math.round((Date.now() - since) / 1000) });
			if (what.kind === "plan") {
				if (await planAndStart(ctx, what.goal)) kick("Models are back and the plan is approved — starting.");
			} else {
				showProgress(ctx);
				kick("Models are back — continuing where the run stopped.");
			}
		}, waitIntervalMs);
		waiting = { since, timer, notified: false };
	}

	/** Start a model turn from outside a user prompt; the step brief rides along via `context`. */
	function kick(text: string) {
		pi.sendMessage({ customType: ENTRY, content: `[scoby] ${text}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	pi.on("session_start", async (_event, ctx) => {
		const events = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === ENTRY).map((e: any) => e.data as Event);
		const firstUser = (ctx.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message?.role === "user") as any)?.message;
		state = latestRun(events, textOf(firstUser));
		baseline = runGates(ctx.cwd);
		pi.appendEntry(META, { event: "baseline", gates: baseline.map((g) => ({ cmd: g.cmd, code: g.code, errors: g.lines.length })) });
		if (state?.status === "running") {
			// resuming: take the lock (a run from before the lock existed has none yet); another live
			// session's lock is only reported — the human chose to resume this one
			const other = readLock(repoRoot(ctx.cwd));
			if (other && other.sessionFile !== sessionFile(ctx)) {
				pi.appendEntry(META, { event: "lock_conflict", by: other.sessionFile, pid: other.pid });
				if (interactive(ctx)) ctx.ui.notify(`scoby: another session also has a build here (${other.sessionFile}); this one takes over`, "warning");
			}
			holdLock(ctx);
			showProgress(ctx, "resumed");
		}
	});

	// The lock stays on shutdown while the run is in progress: that is what makes an interrupted
	// build visible to the next session (the owner resumes with --session, or drops it).
	pi.on("session_shutdown", async () => {
		if (waiting) clearInterval(waiting.timer);
		waiting = undefined;
	});

	pi.on("before_agent_start", async (event: any, ctx) => {
		skipTurn = false;
		if (waiting) {
			// the human typed while we wait: let it through as chat, the build stays paused
			return;
		}
		if (state?.status === "running") {
			// a resumed run: let the engine catch up (gate, judge, next phase) before the model's turn
			await advance(ctx, false);
			return;
		}
		const prompt = String(event.prompt ?? "").trim();

		if (interactive(ctx)) {
			if (!prompt || prompt.startsWith("[scoby]")) return;
			const choice = await ctx.ui.select("scoby", [BUILD, CHAT]);
			if (choice !== BUILD) return; // plain chat, nothing else happens
			state = undefined; // a finished run in this session doesn't block a new one
			if (!(await planAndStart(ctx, prompt))) skipTurn = true;
			return;
		}

		// print mode: the session's FIRST prompt is the goal — a resume says "Continue the task",
		// which must never become the goal; on a fresh session the prompt isn't stored yet (r4/r5)
		if (state) {
			deferred = true; // complete or genuinely failed: nothing for the model to do
			return;
		}
		const firstUser = (ctx.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message?.role === "user") as any)?.message;
		const goal = (textOf(firstUser) || prompt).trim();
		if (!goal) return void pi.appendEntry(META, { event: "no_goal" });
		await planAndStart(ctx, goal);
	});

	// A run that must not happen must not degrade into a plain agent loop (r6).
	const mustStop = (ctx: ExtensionContext) =>
		skipTurn || (interactive(ctx) ? false : deferred || state?.status === "failed" || state?.status === "complete");
	pi.on("agent_start", async (_event, ctx) => {
		if (mustStop(ctx)) ctx.abort();
	});
	pi.on("tool_call", async (_event, ctx) => {
		if (mustStop(ctx)) return { block: true, reason: "scoby: this turn was stopped", terminate: true };
	});

	pi.on("context", async (event) => {
		if (!state || state.status !== "running" || waiting) return;
		const a = next(state);
		if (a.kind !== "run_step") return;
		const messages = [...(event.messages as any[]), {
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: stepBrief(state, a.phaseId, a.stepId, a.resume) }],
		}];
		return { messages: messages as any };
	});

	pi.on("agent_end", async (event: any, ctx) => {
		if (!state || state.status !== "running" || busy || skipTurn) return;
		const last = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
		if (!last) return;
		if (last.stopReason === "error" || last.stopReason === "aborted") {
			// the router couldn't save this turn: interactive waits and resumes by itself
			if (interactive(ctx) && last.stopReason === "error") startWaiting(ctx, { kind: "resume" });
			return;
		}
		if (last.stopReason !== "stop") return;
		busy = true;
		try {
			const a = next(state);
			if (a.kind === "run_step") record(ctx, { type: "step_finished", phaseId: a.phaseId, stepId: a.stepId, summary: textOf(last).slice(0, 400) });
			await advance(ctx);
		} finally {
			busy = false;
		}
	});

	/** Engine actions that need no model turn, then trigger the next step (or stop). */
	async function advance(ctx: ExtensionContext, trigger = true) {
		for (let i = 0; i < 12; i++) {
			const a = next(state!);
			switch (a.kind) {
				case "activate_phase":
					record(ctx, { type: "phase_activated", phaseId: a.phaseId });
					break;
				case "gate": {
					showProgress(ctx, "running checks");
					const fresh = newErrors(baseline ?? [], runGates(ctx.cwd));
					if (fresh.length) {
						const report = fresh.map((g) => `$ ${g.cmd}\n${g.lines.slice(0, 20).join("\n")}`).join("\n\n");
						record(ctx, { type: "gate_failed", phaseId: a.phaseId, report });
					} else record(ctx, { type: "gate_passed", phaseId: a.phaseId });
					break;
				}
				case "judge": {
					showProgress(ctx, "judging");
					const phase = state!.phases.find((p) => p.id === a.phaseId)!;
					const diff = git(ctx.cwd, "diff", "HEAD").stdout + git(ctx.cwd, "status", "--short").stdout;
					const steps = phase.steps.map((s) => `- ${s.id} ${s.title}: ${s.summary ?? ""}`).join("\n");
					try {
						const verdict = parseJSON<{ grade: string; rationale?: string; fix?: string }>(
							await ask(ctx, "judge", `${JUDGE_PROMPT}\n\n## Goal\n${state!.goal}\n\n## Phase ${phase.id} — ${phase.title}\n${steps}\n\n## diff\n${diff.slice(0, 120000)}`, 4096,
								(t) => { if (!/^[ABCDF]$/i.test(String(parseJSON<{ grade: string }>(t).grade ?? "").trim())) throw new Error("no grade"); }),
						);
						record(ctx, { type: "phase_graded", phaseId: a.phaseId, grade: verdict.grade, rationale: verdict.rationale, fix: verdict.fix });
					} catch (e) {
						pi.appendEntry(META, { event: isUnavailable(e) ? "judge_deferred" : "judge_failed", phaseId: a.phaseId, error: String(e).slice(0, 200) });
						if (isUnavailable(e)) {
							// no fake grade: wait (interactive) or stop for the supervisor (print), judge again after
							if (interactive(ctx)) startWaiting(ctx, { kind: "resume" });
							else {
								deferred = true;
								ctx.abort();
							}
							return;
						}
						record(ctx, { type: "phase_graded", phaseId: a.phaseId, grade: "C", rationale: "judge could not produce a grade" });
					}
					break;
				}
				case "run_step":
					// a step already running (resumed session) is not a new start — the stuck guard counts starts
					if (!a.resume) record(ctx, { type: "step_started", phaseId: a.phaseId, stepId: a.stepId });
					if (!trigger) return; // the run is starting anyway: the brief rides on its requests
					kick(`Next: ${a.stepId}. The step brief is in your context.`);
					return;
				case "complete":
					record(ctx, { type: "completed", summary: state!.phases.map((p) => `${p.id}:${p.grade ?? "?"}`).join(" ") });
					if (interactive(ctx)) ctx.ui.notify("scoby: build finished — review the branch", "info");
					return;
				case "fail":
					record(ctx, { type: "failed", reason: a.reason });
					return;
				case "done":
					return;
			}
		}
	}

	pi.registerCommand("ferment", {
		description: "scoby: show the plan and where the current build is (/ferment unlock drops another session's interrupted build)",
		handler: async (args, ctx) => {
			if (String(args ?? "").trim() === "unlock") {
				const root = repoRoot(ctx.cwd);
				const held = readLock(root);
				if (!held) return ctx.ui.notify("scoby: no build lock in this repo", "info");
				if (held.sessionFile === sessionFile(ctx) && state?.status === "running") return ctx.ui.notify("scoby: that lock is this session's own running build", "warning");
				clearLock(root);
				pi.appendEntry(META, { event: "unlocked", by: held.sessionFile, step: held.step });
				return ctx.ui.notify(`scoby: dropped the lock held by ${held.sessionFile}${held.step ? ` (was at ${held.step})` : ""}; its changes are still in the working tree`, "info");
			}
			if (!state) return ctx.ui.notify(waiting ? "scoby: waiting for models to plan" : "scoby: no build in this session", "info");
			ctx.ui.notify(renderProgress(state, waiting ? "waiting for models" : undefined).join("\n"), "info");
		},
	});
}

/**
 * What the repo looks like, for the planner. Without this it plans against an imagined project: in
 * ferment-32k-r4 it chose "store stock in a JSON file" for a Postgres/drizzle app.
 */
function repoContext(cwd: string): string {
	const read = (p: string) => {
		try {
			return fs.readFileSync(path.join(cwd, p), "utf8");
		} catch {
			return "";
		}
	};
	const notes = (read("CLAUDE.md") || read("AGENTS.md")).slice(0, 6000);
	const files = spawnSync("git", ["ls-files"], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).stdout ?? "";
	const tracked = files.split("\n").filter((f) => f && !/^(node_modules|dist)\//.test(f)).slice(0, 400).join("\n");
	const pkg = read("package.json").slice(0, 2000);
	return [
		notes ? `## Repo notes (CLAUDE.md / AGENTS.md)\n${notes}` : "",
		pkg ? `## package.json\n${pkg}` : "",
		tracked ? `## Tracked files\n${tracked}` : "",
	].filter(Boolean).join("\n\n");
}

function textOf(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	return (c ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}
