// Fold — pure parts. A fold replaces a contiguous run of old units (outside the recent zone)
// with one model-written summary block, exactly once: blocks are never re-summarized, so early
// work is not eroded round after round (the billion-context paper's retention argument; pi's
// native compaction re-summarizes the previous summary every time).
import { estimateTokens, toUnits, type FoldBlock, type Msg } from "./shaper.ts";

export interface FoldSelectOptions {
	available: number;
	charsPerToken: number;
	recentShare?: number;
	/** fold when the foldable run is at least this share of `available` (default 0.25) */
	gateShare?: number;
	folds: FoldBlock[];
}

export interface FoldCandidate {
	msgs: Msg[];
	covers: number[];
	tokens: number;
}

/** The oldest contiguous run of unfolded, non-user units that sits before the recent zone. */
export function selectFold(messages: Msg[], opts: FoldSelectOptions): FoldCandidate | undefined {
	const tok = (m: Msg) => estimateTokens(m, opts.charsPerToken);
	const covered = new Set(opts.folds.flatMap((f) => f.covers));
	const units = toUnits(messages);

	// recent zone: same rule as the shaper — contiguous from the end, newest unit always in
	const recentBudget = (opts.recentShare ?? 0.5) * opts.available;
	let recentStart = units.length;
	let recent = 0;
	for (let i = units.length - 1; i >= 0; i--) {
		const size = units[i].msgs.reduce((s, m) => s + tok(m), 0);
		if (i !== units.length - 1 && recent + size > recentBudget) break;
		recentStart = i;
		recent += size;
	}

	const run: Msg[] = [];
	for (let i = 0; i < recentStart; i++) {
		const u = units[i];
		const isCovered = u.msgs.every((m) => covered.has(m.timestamp));
		// user messages stay verbatim (task, later instructions); they end a run
		if (u.kind === "user" || u.kind === "other") {
			if (run.length) break;
			continue;
		}
		if (isCovered) {
			if (run.length) break;
			continue;
		}
		run.push(...u.msgs);
	}
	const tokens = run.reduce((s, m) => s + tok(m), 0);
	if (!run.length || tokens < (opts.gateShare ?? 0.25) * opts.available) return undefined;
	return { msgs: run, covers: run.map((m) => m.timestamp), tokens };
}

function textOf(content: Msg["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/** Plain-text transcript of the run, with the refs recall() needs. */
export function serializeRun(msgs: Msg[], maxChars = 400_000): string {
	const lines: string[] = [];
	for (const m of msgs) {
		if (m.role === "assistant") {
			const text = textOf(m.content).trim();
			if (text) lines.push(`ASSISTANT: ${text}`);
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b.type === "toolCall") lines.push(`CALL ${b.id} ${b.name}(${JSON.stringify(b.arguments ?? {}).slice(0, 400)})`);
			}
		} else if (m.role === "toolResult") {
			lines.push(`RESULT ${m.toolCallId} (${m.toolName}${m.isError ? ", error" : ""}):\n${textOf(m.content)}`);
		} else {
			lines.push(`${m.role.toUpperCase()}: ${textOf(m.content)}`);
		}
	}
	const all = lines.join("\n\n");
	return all.length > maxChars ? all.slice(0, maxChars) + "\n[transcript cut]" : all;
}

// The doctrine, adapted from the billion-context paper's KEEP/DROP rules to a small budget.
export function foldPrompt(transcript: string, maxSummaryTokens: number): string {
	return `You are compressing part of a coding agent's working history. The agent will continue the task
with your summary INSTEAD of this transcript, so write what it needs to keep working — not a narrative.

KEEP, verbatim where it matters:
- file paths (with line numbers when known), function/type names, signatures and load-bearing code lines
- exact error messages and their causes
- decisions WITH their rationale, and approaches that were tried and rejected (with the lesson)
- exact values: config keys, column names, URLs, commands that worked
- the current state: what is done, what is half-done, what comes next
- the CALL ids of tool results worth restoring later, as (ref <id>) — the agent can recall(<id>) for exact output

DROP: verbose logs once their result is captured, duplicate reads, directory listings, the step-by-step journey.

Write terse markdown bullets, at most ~${maxSummaryTokens} tokens. No preamble.

<transcript>
${transcript}
</transcript>`;
}

export function summaryBudget(available: number): number {
	return Math.max(300, Math.min(1500, Math.floor(available * 0.08)));
}
