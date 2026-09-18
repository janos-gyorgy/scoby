// scoby router — a pi extension: user-defined connections, role → model chains,
// and failover when a free tier says no.
//
// How failover works (verified in test/failover): pi's own agent-level retry re-runs a
// failed turn after a short backoff. When an assistant message ends in a retryable error,
// we switch the session model *before* that retry starts, so the retry lands on the next
// target in the role's chain. No retry loop of our own.
//
// Config lookup: $SCOBY_CONFIG, then ./.scoby.json, then ~/.config/scoby/config.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { classifyError, mergeConfig, patchGeminiSignatures, Router, validateConfig, type RouterConfig, type Target } from "./core.ts";

const ENTRY = "scoby-router";

/** Global config, plus a repo-local overlay. SCOBY_CONFIG replaces both (tests, bench). */
export function findConfig(): { global?: string; local?: string } {
	if (process.env.SCOBY_CONFIG) return { global: process.env.SCOBY_CONFIG };
	const global = path.join(os.homedir(), ".config", "scoby", "config.json");
	const local = path.join(process.cwd(), ".scoby.json");
	return { global: fs.existsSync(global) ? global : undefined, local: fs.existsSync(local) ? local : undefined };
}

export function loadConfig(): { cfg: RouterConfig; configPath: string } | undefined {
	const found = findConfig();
	if (!found.global && !found.local) return undefined; // no config = no scoby; pi works as usual
	const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")) as RouterConfig;
	// a repo-local file alone is a full config; next to a global one it is an overlay
	const cfg = found.global && found.local ? mergeConfig(read(found.global), read(found.local)) : read((found.local ?? found.global)!);
	const configPath = [found.global, found.local].filter(Boolean).join(" + ");
	const problems = validateConfig(cfg);
	if (problems.length) {
		throw new Error(`scoby: invalid config ${configPath}:\n  - ${problems.join("\n  - ")}`);
	}
	return { cfg, configPath };
}

export interface RouterHandle {
	/** the target the session is routed to right now */
	current(): Target | undefined;
	role(): string;
	/** best healthy target for another role (e.g. "compactor") — does not touch the session model */
	targetFor(role: string): Target | undefined;
	/** the whole chain for a role, ready targets first, then the ones cooling down (soonest first) */
	chainFor(role: string): Target[];
	/** report a failure on a target used outside the session (e.g. a fold call) */
	markFailed(raw: string, errorMessage: string): void;
}

/** Standalone use: `pi -e extensions/router/index.ts`. The scoby entry composes it with compaction. */
export default function scobyRouter(pi: ExtensionAPI) {
	const loaded = loadConfig();
	if (loaded) setupRouter(pi, loaded.cfg, loaded.configPath);
}

export function setupRouter(pi: ExtensionAPI, cfg: RouterConfig, configPath: string): RouterHandle {
	// Custom connections become pi providers, registered under the connection's name.
	for (const [name, c] of Object.entries(cfg.connections)) {
		if (!c.baseUrl) continue;
		pi.registerProvider(name, {
			baseUrl: c.baseUrl,
			apiKey: c.apiKeyEnv ? `$${c.apiKeyEnv}` : "none",
			api: (c.api ?? "openai-completions") as any,
			models: (c.models ?? []).map((m) => ({
				id: m.id,
				name: m.id,
				reasoning: m.reasoning ?? false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 32000,
				maxTokens: m.maxTokens ?? 4096,
			})),
		});
	}

	pi.registerFlag("role", { description: "scoby: role to route this session through", type: "string" });

	const router = new Router(cfg);
	let role = cfg.defaultRole ?? Object.keys(cfg.roles)[0];
	let current: Target | undefined;

	const record = (event: string, data: Record<string, unknown>) => pi.appendEntry(ENTRY, { event, role, at: Date.now(), ...data });

	const status = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(ENTRY, current ? `${role} → ${current.raw}` : `${role} → (none)`);
	};

	/**
	 * Point the session at the best target for the role, skipping ones that can't be used
	 * right now (unknown model, missing key). Returns the target now active, or undefined.
	 */
	async function select(ctx: ExtensionContext, reason: string, exclude: string[] = []): Promise<Target | undefined> {
		const tried = new Set<string>(exclude);
		const chain = router.targets(role);
		for (let i = 0; i < chain.length; i++) {
			const now = Date.now();
			const target = router.pick(role, now, [...tried]);
			if (tried.has(target.raw)) break; // pick fell back to an excluded one: nothing else left
			tried.add(target.raw);

			const model = ctx.modelRegistry.find(target.provider, target.modelId);
			if (!model) {
				router.markFailed(target.raw, "auth", now);
				record("unusable", { target: target.raw, why: "model not in registry" });
				continue;
			}
			if (!(await pi.setModel(model))) {
				router.markFailed(target.raw, "auth", now);
				record("unusable", { target: target.raw, why: "no API key for provider" });
				continue;
			}
			const level = Router.thinkingFor(target, Boolean((model as any).reasoning));
			pi.setThinkingLevel(level);
			current = target;
			record("select", { target: target.raw, thinking: pi.getThinkingLevel(), reason });
			status(ctx);
			return target;
		}
		current = undefined;
		record("exhausted", { reason });
		if (ctx.hasUI) ctx.ui.notify(`scoby: no usable target left in role "${role}"`, "error");
		status(ctx);
		return undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		const flagRole = pi.getFlag("role");
		if (typeof flagRole === "string" && flagRole) {
			if (!cfg.roles[flagRole]) throw new Error(`scoby: --role "${flagRole}" is not in ${configPath}`);
			role = flagRole;
		}
		await select(ctx, "session start");
	});

	// Cross-model history into Gemini: sign the unsigned tool calls on the wire (see core.ts).
	pi.on("before_provider_request", (event) => {
		const patched = patchGeminiSignatures(event.payload);
		if (patched) record("gemini_signatures", { target: current?.raw, patched });
	});

	// Return to the preferred target between turns once its cooldown is over.
	pi.on("turn_start", async (_event, ctx) => {
		if (!current) return;
		const preferred = router.recoverTo(role, current.raw, Date.now());
		if (preferred) await select(ctx, `recovered: ${preferred.raw} is out of cooldown`);
	});

	pi.on("message_end", async (event: any, ctx) => {
		const m = event.message;
		if (!m || m.role !== "assistant") return;

		if (m.stopReason !== "error") {
			if (current) router.markHealthy(current.raw);
			return;
		}
		const verdict = classifyError(m.errorMessage ?? "");
		const failedRaw = current?.raw;
		if (!verdict.failover || !failedRaw) {
			record("error_no_failover", { target: failedRaw, kind: verdict.kind, status: verdict.status, error: String(m.errorMessage ?? "").slice(0, 300) });
			return;
		}
		const until = router.markFailed(failedRaw, verdict.kind, Date.now());
		record("failed", { target: failedRaw, kind: verdict.kind, status: verdict.status, coolUntil: until });

		const next = await select(ctx, `${verdict.kind}${verdict.status ? " " + verdict.status : ""} on ${failedRaw}`, [failedRaw]);
		if (ctx.hasUI && next) ctx.ui.notify(`scoby: ${failedRaw} → ${next.raw} (${verdict.kind})`, "warning");
	});

	// pi only auto-retries errors on its own pattern list (overloaded, 429, 5xx, network...).
	// A failover-worthy error outside that list ends the run even though we already switched
	// the model. So at agent_end — before pi decides to stop — queue a follow-up that resumes
	// the task on the new target. (agent_settled is too late: in print mode the session is
	// already being torn down there; found in test/router/run-glitch.sh.)
	const MAX_RESUMES = 5;
	let resumes = 0;
	pi.on("agent_end", async (event: any) => {
		const lastMsg = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
		if (!lastMsg || lastMsg.stopReason !== "error") return;
		if (isRetryableAssistantError(lastMsg)) return; // pi retries this itself, on the model we already switched to
		const verdict = classifyError(lastMsg.errorMessage ?? "");
		if (!verdict.failover || !current) return;
		if (router.coolingUntil(current.raw) > Date.now()) return; // nothing healthy to resume on
		if (resumes >= MAX_RESUMES) {
			record("resume_cap", { target: current.raw, resumes });
			return;
		}
		resumes++;
		record("resume", { target: current.raw, after: verdict.kind, resumes });
		pi.sendMessage(
			{
				customType: "scoby-resume",
				content: `[scoby] The previous model failed mid-task (${verdict.kind}); you are now on ${current.raw}. Continue the task from where it stopped — do not start over.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	pi.registerCommand("role", {
		description: "scoby: show or switch the routing role",
		getArgumentCompletions: (prefix: string) => {
			const items = Object.keys(cfg.roles).filter((r) => r.startsWith(prefix)).map((r) => ({ value: r, label: r }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const wanted = args.trim();
			if (!wanted) {
				ctx.ui.notify(`role: ${role} → ${current?.raw ?? "(none)"}  (roles: ${Object.keys(cfg.roles).join(", ")})`, "info");
				return;
			}
			if (!cfg.roles[wanted]) {
				ctx.ui.notify(`scoby: no role "${wanted}"`, "error");
				return;
			}
			role = wanted;
			await select(ctx, "role switch");
		},
	});

	pi.registerCommand("router", {
		description: "scoby: show each target in the current role and whether it is cooling down",
		handler: async (_args, ctx) => {
			const now = Date.now();
			const lines = router.targets(role).map((t) => {
				const until = router.coolingUntil(t.raw);
				const state = until > now ? `cooling ${Math.ceil((until - now) / 1000)}s` : "ready";
				return `${t.raw === current?.raw ? "▶" : " "} ${t.raw}  [${state}]`;
			});
			ctx.ui.notify(`role ${role}\n${lines.join("\n")}`, "info");
		},
	});

	return {
		current: () => current,
		role: () => role,
		targetFor: (r: string) => (cfg.roles[r] ? router.pick(r, Date.now()) : undefined),
		chainFor: (r: string) => {
			if (!cfg.roles[r]) return [];
			const now = Date.now();
			return [...router.targets(r)].sort((a, b) => Math.max(0, router.coolingUntil(a.raw) - now) - Math.max(0, router.coolingUntil(b.raw) - now));
		},
		markFailed: (raw: string, errorMessage: string) => {
			const verdict = classifyError(errorMessage);
			if (verdict.failover) router.markFailed(raw, verdict.kind, Date.now());
		},
	};
}
