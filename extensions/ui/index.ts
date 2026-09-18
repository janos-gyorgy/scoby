// scoby UI — what makes the pi TUI read as scoby.
//
//   session_start   welcome card in the transcript (once per session), terminal title, footer status
//   entry renderers plan / grade / finished cards for the ferment events, so the plan survives approval
//   footer status   role → model · tokens/budget · step · grades, refreshed on every request
//   working line    the current step's title and fermentation bubbles while the model works
//   /scoby          the welcome card again, as a dashboard
//
// Registered LAST in the scoby entry so its hooks see the entries the other modules append.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "../router/core.ts";
import type { RouterHandle } from "../router/index.ts";
import type { CompactionHandle } from "../compaction/index.ts";
import { latestRun, next, type Event, type State } from "../ferment/core.ts";
import { readLock, repoRoot } from "../ferment/lock.ts";
import { BUBBLES, endCard, gradeCard, isPoorGrade, planCard, statusLine, welcomeLines, type WelcomeInfo } from "./render.ts";

const WELCOME = "scoby-welcome";
const FERMENT = "scoby-ferment";
const STATUS = "scoby";

/** A pi-tui component without importing pi-tui (it is nested under pi, not resolvable from here). */
const block = (lines: string[]) => ({ render: () => lines, invalidate() {} });

export function setupUi(pi: ExtensionAPI, cfg: RouterConfig, router: RouterHandle | undefined, compaction: CompactionHandle | undefined) {
	let lastUsed: number | undefined;

	const branchOf = (cwd: string) => {
		const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
		return r.status === 0 ? r.stdout.trim() : undefined;
	};
	const fermentState = (ctx: ExtensionContext): State | undefined => {
		const events = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === FERMENT).map((e: any) => e.data as Event);
		return latestRun(events);
	};
	const budgetOf = (ctx: ExtensionContext) => compaction?.budget(ctx) ?? cfg.compaction?.defaultBudget ?? 0;

	function welcome(ctx: ExtensionContext): WelcomeInfo {
		const root = repoRoot(ctx.cwd);
		const lock = readLock(root);
		const mine = (ctx.sessionManager as any).getSessionFile?.() ?? "";
		const state = fermentState(ctx);
		const a = state?.status === "running" ? next(state) : undefined;
		const total = state?.phases.reduce((n, p) => n + p.steps.length, 0) ?? 0;
		const done = state?.phases.reduce((n, p) => n + p.steps.filter((s) => s.status === "done").length, 0) ?? 0;
		return {
			repo: path.basename(root),
			branch: branchOf(ctx.cwd),
			roles: router?.health() ?? [],
			budget: budgetOf(ctx),
			notify: Boolean(cfg.notify?.url && process.env[cfg.notify.tokenEnv ?? "NTFY_TOKEN"]),
			lock: lock && lock.sessionFile !== mine ? { step: lock.step, goal: lock.goal } : undefined,
			resumed: state?.status === "running" ? { step: a?.kind === "run_step" ? a.stepId : undefined, done, total } : undefined,
		};
	}

	function refreshStatus(ctx: ExtensionContext, waiting = false) {
		if (!ctx.hasUI) return;
		const state = fermentState(ctx);
		const a = state?.status === "running" ? next(state) : undefined;
		const current = router?.current();
		ctx.ui.setStatus("scoby-router", undefined); // the router's own footer line says less than this one
		ctx.ui.setStatus(STATUS, statusLine({
			role: router?.role() ?? cfg.defaultRole ?? "builder",
			model: current ? `${current.connection}/${current.modelId}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			usedTokens: lastUsed,
			budget: budgetOf(ctx),
			step: a?.kind === "run_step" ? a.stepId : state?.status === "complete" ? "done" : undefined,
			grades: state?.phases.map((p) => p.grade).filter(Boolean) as string[] | undefined,
			waiting,
		}));
	}

	// ── transcript cards ──────────────────────────────────────────────────────────
	pi.registerEntryRenderer(WELCOME, (entry: any, _opts: any, theme: any) => {
		const lines = welcomeLines(entry.data as WelcomeInfo);
		return block(lines.map((l, i) => {
			const jar = theme.fg("accent", l.slice(0, 13));
			const rest = l.slice(13);
			if (i === 0) return jar + theme.bold(theme.fg("accent", rest));
			if (rest.startsWith("⚠")) return jar + theme.fg("warning", rest);
			return jar + theme.fg(i === 1 ? "text" : "muted", rest);
		}));
	});

	pi.registerEntryRenderer(FERMENT, (entry: any, _opts: any, theme: any) => {
		const e = entry.data as Event;
		if (e.type === "planned") {
			const [head, ...rest] = planCard(e.plan as any, e.goal ?? "");
			return block([theme.bold(theme.fg("accent", head)), ...rest.map((l) => (l.startsWith("   ") ? theme.fg("muted", l) : theme.fg("text", l)))]);
		}
		if (e.type === "phase_graded") {
			const [head, ...rest] = gradeCard(e);
			const tone = isPoorGrade(e.grade) ? "error" : "success";
			return block([theme.bold(theme.fg(tone, head)), ...rest.map((l) => theme.fg("muted", l))]);
		}
		if (e.type === "completed" || e.type === "failed") {
			const [head, ...rest] = endCard(e as any);
			return block([theme.bold(theme.fg(e.type === "completed" ? "success" : "error", head)), ...rest.map((l) => theme.fg("muted", l))]);
		}
		if (e.type === "step_finished") return block([theme.fg("dim", `✓ ${e.stepId}${e.summary ? " · " + e.summary.split("\n")[0].slice(0, 90) : ""}`)]);
		if (e.type === "gate_failed") return block([theme.fg("warning", `gates red in ${e.phaseId} — fixing`)]);
		return block([]); // step_started, phase_activated, gate_passed: the widget shows these live
	});

	// ── hooks ─────────────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(`scoby · ${path.basename(repoRoot(ctx.cwd))}`);
		const seen = ctx.sessionManager.getEntries().some((e: any) => e.type === "custom" && e.customType === WELCOME);
		if (!seen) pi.appendEntry(WELCOME, welcome(ctx));
		ctx.ui.setWorkingIndicator({ frames: BUBBLES.map((b) => ctx.ui.theme.fg("accent", b)), intervalMs: 160 });
		refreshStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const state = fermentState(ctx);
		const a = state?.status === "running" ? next(state) : undefined;
		if (a?.kind === "run_step") {
			const step = state!.phases.flatMap((p) => p.steps).find((s) => s.id === a.stepId);
			ctx.ui.setWorkingMessage(`${a.stepId}${step ? " · " + step.title : ""}`);
		} else ctx.ui.setWorkingMessage();
		refreshStatus(ctx);
	});

	pi.on("message_end", async (event: any, ctx) => {
		if (!ctx.hasUI || event.message?.role !== "assistant") return;
		const u = event.message.usage ?? {};
		const used = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (used > 0) lastUsed = used;
		refreshStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
		refreshStatus(ctx);
	});

	pi.registerCommand("scoby", {
		description: "scoby: the dashboard — repo, roles and their health, budget, ntfy, build state",
		handler: async (_args, ctx) => {
			pi.appendEntry(WELCOME, welcome(ctx));
			refreshStatus(ctx);
		},
	});
}
