import { test } from "node:test";
import assert from "node:assert/strict";
import { foldPrompt, selectFold, serializeRun } from "./fold.ts";
import type { Msg } from "./shaper.ts";

let clock = 1;
const user = (t: string): Msg => ({ role: "user", content: t, timestamp: clock++ });
const call = (id: string, name: string, args: any): Msg => ({ role: "assistant", timestamp: clock++, content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, name: string, n: number): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, isError: false, timestamp: clock++, content: [{ type: "text", text: "r".repeat(n) }] });

function session(): Msg[] {
	clock = 1;
	return [
		user("task"),
		call("c1", "read", { path: "a.ts" }), result("c1", "read", 4000),
		call("c2", "read", { path: "b.ts" }), result("c2", "read", 4000),
		call("c3", "bash", { command: "ls" }), result("c3", "bash", 4000),
		user("later instruction"),
		call("c4", "read", { path: "c.ts" }), result("c4", "read", 4000),
		call("c5", "edit", { path: "c.ts" }), result("c5", "edit", 200),
	];
}

test("selects the oldest contiguous unfolded run before the recent zone, stopping at a user message", () => {
	const s = session();
	const c = selectFold(s, { available: 3000, charsPerToken: 4, folds: [], gateShare: 0.25 })!;
	assert.ok(c);
	assert.deepEqual(c.msgs.map((m) => m.toolCallId ?? "call"), ["call", "c1", "call", "c2", "call", "c3"]);
	assert.ok(!c.msgs.some((m) => m.role === "user"));
});

test("below the gate: nothing to fold", () => {
	const s = session();
	assert.equal(selectFold(s, { available: 100_000, charsPerToken: 4, folds: [], recentShare: 0.05, gateShare: 0.25 }), undefined);
});

test("already-folded units are skipped: the next fold starts after them", () => {
	const s = session();
	const first = selectFold(s, { available: 3000, charsPerToken: 4, folds: [] })!;
	const next = selectFold(s, { available: 3000, charsPerToken: 4, folds: [{ id: "f1", summary: "x", covers: first.covers }] });
	// c1..c3 folded; c4 is in the recent zone; nothing else foldable
	assert.equal(next, undefined);
});

test("transcript carries the refs recall needs, and the prompt asks to keep them", () => {
	const s = session();
	const text = serializeRun(s.slice(1, 5));
	assert.match(text, /CALL c1 read\(\{"path":"a.ts"\}\)/);
	assert.match(text, /RESULT c1 \(read\):/);
	assert.match(foldPrompt(text, 800), /recall\(<id>\)/);
});
