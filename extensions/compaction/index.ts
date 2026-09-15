// scoby compaction — pi glue around the pure shaper.
//
//   context                  -> shape the messages for THIS request under the current budget
//   before_provider_request  -> measure what actually goes out (payload size, fixed overhead)
//   message_end              -> calibrate chars/token from real usage; write one scoby-budget entry
//   session_before_compact   -> cancel pi's threshold compaction (the shaper already bounds requests)
//   recall tool              -> restore exact tool output that a stub replaced, from the session file
//
// The budget follows the router: whatever connection the session is on right now decides it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RouterConfig } from "../router/core.ts";
import type { RouterHandle } from "../router/index.ts";
import { shape, type FoldBlock, type Msg, type ShapeReport } from "./shaper.ts";
import { foldPrompt, selectFold, serializeRun, summaryBudget } from "./fold.ts";

const BUDGET_ENTRY = "scoby-budget";
const FOLD_ENTRY = "scoby-fold";
const DEFAULT_CPT = 3.6; // measured on this repo's code: 260K chars -> 72K tokens
const DEFAULT_FIXED = 3000; // system prompt + tool schemas, until the first request measures it

export interface CompactionHandle {
	budget(ctx: ExtensionContext): number;
	charsPerToken(provider: string): number;
}

export function setupCompaction(pi: ExtensionAPI, cfg: RouterConfig, router: RouterHandle | undefined): CompactionHandle {
	pi.registerFlag("budget", { description: "scoby: input-token budget per request (overrides config)", type: "string" });

	const cpt = new Map<string, number>(); // provider -> calibrated chars per token
	let fixedTokens = DEFAULT_FIXED;
	let last: { report: ShapeReport; budget: number; shapedChars: number; payloadChars?: number; provider: string } | undefined;
	let folds: FoldBlock[] = [];
	let foldsSeen = -1;
	let lastInput: Msg[] | undefined; // unshaped context of the latest request — what a fold looks at
	let folding = false;

	const providerOf = (ctx: ExtensionContext) => ctx.model?.provider ?? "unknown";
	const charsPerToken = (provider: string) => cpt.get(provider) ?? DEFAULT_CPT;

	function budget(ctx: ExtensionContext): number {
		const flag = Number(pi.getFlag("budget"));
		if (Number.isFinite(flag) && flag > 0) return flag;
		const conn = router?.current() ? cfg.connections[router.current()!.connection] : undefined;
		if (conn?.maxRequestTokens) return conn.maxRequestTokens;
		if (cfg.compaction?.defaultBudget) return cfg.compaction.defaultBudget;
		return Math.floor(((ctx.model as any)?.contextWindow ?? 64000) * 0.5);
	}

	function loadFolds(ctx: ExtensionContext): FoldBlock[] {
		const entries = ctx.sessionManager.getEntries();
		if (entries.length === foldsSeen) return folds;
		foldsSeen = entries.length;
		folds = entries
			.filter((e: any) => e.type === "custom" && e.customType === FOLD_ENTRY)
			.map((e: any) => e.data as FoldBlock);
		return folds;
	}

	pi.on("context", async (event, ctx) => {
		const provider = providerOf(ctx);
		const b = budget(ctx);
		const messages = event.messages as unknown as Msg[];
		lastInput = messages;
		const { messages: shaped, report } = shape(messages, {
			available: Math.max(500, b - fixedTokens),
			charsPerToken: charsPerToken(provider),
			recentShare: cfg.compaction?.recentShare ?? 0.5,
			folds: loadFolds(ctx),
		});
		last = { report, budget: b, shapedChars: JSON.stringify(shaped).length, provider };
		if (shaped === messages) return; // untouched: keep the exact prefix
		return { messages: shaped as any };
	});

	pi.on("before_provider_request", (event) => {
		if (!last) return;
		const payloadChars = JSON.stringify(event.payload ?? {}).length;
		last.payloadChars = payloadChars;
		// everything that isn't our messages is fixed overhead: system prompt, tool schemas, framing
		const fixedChars = Math.max(0, payloadChars - last.shapedChars);
		fixedTokens = Math.ceil(fixedChars / charsPerToken(last.provider));
	});

	pi.on("message_end", async (event: any, ctx) => {
		const m = event.message;
		if (!m || m.role !== "assistant" || !last) return;
		const u = m.usage ?? {};
		const actualInput = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		const before = charsPerToken(last.provider);
		if (actualInput > 200 && last.payloadChars) {
			// exponential moving average, so one odd response doesn't swing the estimate
			const observed = last.payloadChars / actualInput;
			cpt.set(last.provider, Number((before * 0.7 + observed * 0.3).toFixed(3)));
		}
		const { elided, ...report } = last.report;
		pi.appendEntry(BUDGET_ENTRY, {
			model: `${ctx.model?.provider}/${ctx.model?.id}`,
			budget: last.budget,
			fixedTokens,
			...report,
			elidedCount: elided.length,
			payloadChars: last.payloadChars,
			estimatedInput: last.payloadChars ? Math.ceil(last.payloadChars / before) : undefined,
			actualInput: actualInput || undefined,
			output: u.output,
			charsPerToken: charsPerToken(last.provider),
			stopReason: m.stopReason,
		});
	});

	// Fold between turns (the paper: compress between task steps, not mid-step), only when
	// enough old content sits outside the recent zone. One block per fold, never re-folded.
	pi.on("turn_end", async (_event, ctx) => {
		if (folding || !lastInput || cfg.compaction?.fold === false) return;
		// only under pressure: if the last request fit the budget, a fold would change nothing the
		// model sees (the shaper leaves under-budget requests alone) and would just spend quota
		if (!last || last.report.before <= last.report.available) return;
		const provider = providerOf(ctx);
		const available = Math.max(500, budget(ctx) - fixedTokens);
		const candidate = selectFold(lastInput, {
			available,
			charsPerToken: charsPerToken(provider),
			recentShare: cfg.compaction?.recentShare ?? 0.5,
			gateShare: cfg.compaction?.foldGateShare ?? 0.25,
			folds: loadFolds(ctx),
		});
		if (!candidate) return;

		// the compactor role if configured, else the planner's model, else the session model
		const target = router?.targetFor("compactor") ?? router?.targetFor("planner") ?? router?.current();
		const model: any = target ? ctx.modelRegistry.find(target.provider, target.modelId) : ctx.model;
		if (!model) return;
		folding = true;
		const started = Date.now();
		const maxSummary = summaryBudget(available);
		try {
			const response: any = await (ctx.modelRegistry as any).complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: foldPrompt(serializeRun(candidate.msgs), maxSummary) }], timestamp: Date.now() }] },
				{ maxTokens: Math.max(2048, maxSummary * 3), signal: ctx.signal },
			);
			const summary = (response.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
			if (response.stopReason === "error" || !summary) throw new Error(response.errorMessage ?? "empty summary");
			const block: FoldBlock = { id: `fold-${started}`, summary, covers: candidate.covers };
			pi.appendEntry(FOLD_ENTRY, block);
			pi.appendEntry(BUDGET_ENTRY, {
				event: "fold", model: `${model.provider}/${model.id}`, units: candidate.msgs.length,
				tokensIn: candidate.tokens, summaryChars: summary.length, usage: response.usage, ms: Date.now() - started,
			});
			foldsSeen = -1; // reload folds on the next request
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (target) router?.markFailed(target.raw, message);
			pi.appendEntry(BUDGET_ENTRY, { event: "fold_failed", model: `${model.provider}/${model.id}`, error: message.slice(0, 300) });
			// no fold is fine: the shaper still stubs and drops to stay in budget
		} finally {
			folding = false;
		}
	});

	pi.on("session_before_compact", async (event: any) => {
		if (cfg.compaction?.cancelNativeCompaction === false) return;
		// the shaper keeps every request inside the budget; a threshold compaction would only
		// re-summarize history we still have verbatim in the session file
		if (event.reason === "threshold") return { cancel: true };
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: "Restore the exact output of an earlier tool call that was elided from context. Pass the ref quoted in a [scoby: ...] stub.",
		promptSnippet: "recall: restore elided tool output by its ref",
		promptGuidelines: ["Use recall with the ref from a [scoby: ...] stub when you need the exact earlier tool output; re-running a cheap tool is also fine."],
		parameters: Type.Object({
			ref: Type.String({ description: "the ref from the stub, e.g. call_abc123" }),
			offset: Type.Optional(Type.Number({ description: "character offset to continue from" })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
			const entry: any = ctx.sessionManager
				.getEntries()
				.find((e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === params.ref);
			if (!entry) return { content: [{ type: "text", text: `recall: no tool output with ref "${params.ref}"` }], isError: true, details: {} };
			const text = (entry.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			// hand back at most ~30% of the budget in one go, so a recall can't blow the next request
			const max = Math.floor(0.3 * budget(ctx) * charsPerToken(providerOf(ctx)));
			const start = Math.max(0, params.offset ?? 0);
			const slice = text.slice(start, start + max);
			const more = start + max < text.length ? `\n[scoby: ${text.length - start - max} more chars — recall("${params.ref}", offset=${start + max})]` : "";
			pi.appendEntry(BUDGET_ENTRY, { event: "recall", ref: params.ref, chars: slice.length });
			return { content: [{ type: "text", text: slice + more }], details: { ref: params.ref, offset: start, chars: slice.length } };
		},
	});

	return { budget, charsPerToken };
}
