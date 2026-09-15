// Router core — pure logic, no pi imports, so it tests without a model or a network.
//
// Vocabulary (same idea as Kimchi's role routing):
//   connection  an inference endpoint: a built-in pi provider (with its key in env) or a
//               custom OpenAI-compatible base URL
//   target      "connection/model-id[:thinking]" — one concrete model on one connection
//   role        an ordered list of targets; the first healthy one serves, the rest are
//               the failover chain

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export interface ModelConfig {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface ConnectionConfig {
	/** Use a pi built-in provider ("groq", "google", "openrouter", ...). Its key comes from pi's usual env var. */
	provider?: string;
	/** Or define a custom OpenAI-compatible endpoint; it is registered under the connection's name. */
	baseUrl?: string;
	api?: string;
	apiKeyEnv?: string;
	models?: ModelConfig[];
	/** compaction: max input tokens per request on this connection */
	maxRequestTokens?: number;
}

export interface RouterConfig {
	connections: Record<string, ConnectionConfig>;
	roles: Record<string, string[]>;
	defaultRole?: string;
	compaction?: {
		/** input-token budget per request when the connection sets none (default: half the model's context window) */
		defaultBudget?: number;
		/** share of the budget kept verbatim as the recent zone (default 0.5) */
		recentShare?: number;
		/** false = leave pi's own compaction alone (default: scoby cancels threshold compaction) */
		cancelNativeCompaction?: boolean;
		/** false = never fold (stubs/drops only) */
		fold?: boolean;
		/** fold when old unfolded content reaches this share of the per-request budget (default 0.25) */
		foldGateShare?: number;
	};
	failover?: {
		/** seconds a target sits out after a rate limit / overload (default 60) */
		cooldownSeconds?: number;
		/** seconds a target sits out after an auth/billing failure (default 1800) */
		authCooldownSeconds?: number;
	};
}

export interface Target {
	raw: string;
	connection: string;
	/** the pi provider name to look the model up under */
	provider: string;
	modelId: string;
	thinking?: Level;
}

export function parseTarget(raw: string, connections: Record<string, ConnectionConfig>): Target {
	let spec = raw.trim();
	let thinking: Level | undefined;
	const colon = spec.lastIndexOf(":");
	// only a known level counts as a suffix — model ids can legitimately contain ':'
	if (colon > 0 && (LEVELS as readonly string[]).includes(spec.slice(colon + 1))) {
		thinking = spec.slice(colon + 1) as Level;
		spec = spec.slice(0, colon);
	}
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) throw new Error(`target "${raw}": expected connection/model-id`);
	const connection = spec.slice(0, slash);
	const conn = connections[connection];
	if (!conn) throw new Error(`target "${raw}": unknown connection "${connection}"`);
	return { raw, connection, provider: conn.provider ?? connection, modelId: spec.slice(slash + 1), thinking };
}

/** Returns a list of problems; empty means the config is usable. */
export function validateConfig(cfg: RouterConfig): string[] {
	const errors: string[] = [];
	if (!cfg || typeof cfg !== "object") return ["config is not an object"];
	for (const [name, c] of Object.entries(cfg.connections ?? {})) {
		if (!c.provider && !c.baseUrl) errors.push(`connection "${name}": needs "provider" (built-in) or "baseUrl" (custom)`);
		if (c.provider && c.baseUrl) errors.push(`connection "${name}": use "provider" or "baseUrl", not both`);
		if (c.baseUrl && !(c.models && c.models.length)) errors.push(`connection "${name}": a custom endpoint needs "models"`);
	}
	const roles = Object.entries(cfg.roles ?? {});
	if (roles.length === 0) errors.push(`no roles defined`);
	for (const [role, targets] of roles) {
		if (!Array.isArray(targets) || targets.length === 0) {
			errors.push(`role "${role}": needs at least one target`);
			continue;
		}
		for (const t of targets) {
			try {
				parseTarget(t, cfg.connections ?? {});
			} catch (e) {
				errors.push(`role "${role}": ${(e as Error).message}`);
			}
		}
	}
	if (cfg.defaultRole && !cfg.roles?.[cfg.defaultRole]) errors.push(`defaultRole "${cfg.defaultRole}" is not a role`);
	return errors;
}

export type ErrorKind = "rate_limit" | "overloaded" | "auth" | "network" | "provider_error" | "other";

export interface Classified {
	kind: ErrorKind;
	status?: number;
	failover: boolean;
}

// Real error strings seen from pi, not guessed:
//   mock/Groq-style:  429: {"message":"rate limited (mock)","type":"rate_limit"}
//   Gemini via pi:    {"error":{"message":"{\n  \"error\": {\n    \"code\": 503, ... high demand ...
export function classifyError(message: string): Classified {
	const msg = message ?? "";
	const leading = msg.match(/^\s*(\d{3})\b/);
	const embedded = msg.match(/\\?"code\\?"\s*:\s*(\d{3})/);
	const status = leading ? Number(leading[1]) : embedded ? Number(embedded[1]) : undefined;

	if (status === 429 || /rate.?limit|too many requests|quota|RESOURCE_EXHAUSTED/i.test(msg))
		return { kind: "rate_limit", status: status ?? 429, failover: true };
	if ((status !== undefined && status >= 500) || /high demand|overloaded|UNAVAILABLE|temporarily/i.test(msg))
		return { kind: "overloaded", status, failover: true };
	// a dead/unfunded key on one connection shouldn't stop the run: sit it out for longer
	if (status === 401 || status === 402 || status === 403 || /payment required|invalid api key|unauthori[sz]ed/i.test(msg))
		return { kind: "auth", status, failover: true };
	if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket|fetch failed|network/i.test(msg)) return { kind: "network", status, failover: true };
	// An explicit 4xx is usually OUR bug (e.g. a thinking level the model rejects) — failing over would hide it.
	if (status !== undefined && status >= 400 && status < 500) return { kind: "other", status, failover: false };
	// No status and no known wording: a provider-side crash leaking through (seen live on NIM gpt-oss-20b
	// mid-run: "list index out of range"). Not our request's fault — try the next target.
	return { kind: "provider_error", status, failover: true };
}

export class Router {
	private cooldownUntil = new Map<string, number>();
	private readonly cfg: RouterConfig;

	constructor(cfg: RouterConfig) {
		this.cfg = cfg;
	}

	targets(role: string): Target[] {
		const list = this.cfg.roles[role];
		if (!list) throw new Error(`unknown role "${role}"`);
		return list.map((t) => parseTarget(t, this.cfg.connections));
	}

	coolingUntil(raw: string): number {
		return this.cooldownUntil.get(raw) ?? 0;
	}

	/** First target in the role that isn't cooling down. If every one is, the one that recovers soonest. */
	pick(role: string, now: number, exclude: string[] = []): Target {
		const all = this.targets(role);
		const candidates = all.filter((t) => !exclude.includes(t.raw));
		const pool = candidates.length ? candidates : all;
		const healthy = pool.find((t) => this.coolingUntil(t.raw) <= now);
		if (healthy) return healthy;
		return [...pool].sort((a, b) => this.coolingUntil(a.raw) - this.coolingUntil(b.raw))[0];
	}

	markFailed(raw: string, kind: ErrorKind, now: number): number {
		const f = this.cfg.failover ?? {};
		const seconds = kind === "auth" ? (f.authCooldownSeconds ?? 1800) : (f.cooldownSeconds ?? 60);
		const until = now + seconds * 1000;
		this.cooldownUntil.set(raw, until);
		return until;
	}

	markHealthy(raw: string): void {
		this.cooldownUntil.delete(raw);
	}

	/**
	 * Thinking level for a target. An explicit ":level" wins. Otherwise reasoning models get
	 * "low" and others "off" — never inherit the previous model's level (found live: a
	 * non-reasoning model's level reached Gemini 3.8 Flash as MINIMAL and got a 400).
	 */
	static thinkingFor(target: Target, modelReasons: boolean): Level {
		if (target.thinking) return target.thinking;
		return modelReasons ? "low" : "off";
	}
}
