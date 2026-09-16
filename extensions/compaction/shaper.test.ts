import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, shape, STUB_MARK, toUnits, type Msg } from "./shaper.ts";

const CPT = 4;
let clock = 1000;
const user = (text: string): Msg => ({ role: "user", content: text, timestamp: clock++ });
const call = (id: string, name: string, args: Record<string, any>, thoughtSignature?: string): Msg => ({
	role: "assistant", timestamp: clock++, stopReason: "toolUse",
	content: [{ type: "text", text: `calling ${name}` }, { type: "toolCall", id, name, arguments: args, ...(thoughtSignature ? { thoughtSignature } : {}) }],
});
const result = (id: string, name: string, chars: number): Msg => ({
	role: "toolResult", toolCallId: id, toolName: name, isError: false, timestamp: clock++,
	content: [{ type: "text", text: "x".repeat(chars) }],
});
const say = (chars: number): Msg => ({ role: "assistant", timestamp: clock++, stopReason: "stop", content: [{ type: "text", text: "y".repeat(chars) }] });
const tokens = (ms: Msg[]) => ms.reduce((s, m) => s + estimateTokens(m, CPT), 0);

function session(): Msg[] {
	clock = 1000;
	return [
		user("Build the starter stock feature."),
		call("c1", "read", { path: "server/src/schema.ts" }, "sig-A"), result("c1", "read", 8000),
		call("c2", "bash", { command: "ls server/src/routes" }), result("c2", "bash", 400),
		call("c3", "read", { path: "server/src/routes/batches.ts" }), result("c3", "read", 12000),
		say(3000),
		call("c4", "read", { path: "server/src/schema.ts" }), result("c4", "read", 8000),
		user("also warn a full brew cycle ahead"),
		call("c5", "edit", { path: "server/src/schema.ts" }), result("c5", "edit", 300),
	];
}

test("under budget: returns the very same array (keeps provider caches warm)", () => {
	const s = session();
	const out = shape(s, { available: 1_000_000, charsPerToken: CPT });
	assert.equal(out.messages, s);
	assert.equal(out.report.stubbed + out.report.dropped, 0);
});

test("over budget: fits, dedupes the re-read file first, never touches tool calls", () => {
	const s = session();
	const available = Math.floor(tokens(s) * 0.6);
	const { messages, report } = shape(s, { available, charsPerToken: CPT });
	assert.ok(report.after <= available, `after ${report.after} > ${available}`);
	assert.equal(report.deduped, 1);
	// every tool call survives byte-identical, signature included
	const callsOut = messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content as any[]).filter((b) => b.type === "toolCall"));
	const callsIn = s.filter((m) => m.role === "assistant").flatMap((m) => (m.content as any[]).filter((b) => b.type === "toolCall"));
	assert.deepEqual(callsOut, callsIn.filter((c) => callsOut.some((o) => o.id === c.id)));
	assert.equal(callsOut.find((c) => c.id === "c1")?.thoughtSignature, "sig-A");
	// the first read of schema.ts is the stub, with a recall ref
	const first = messages.find((m) => m.toolCallId === "c1")!;
	assert.match((first.content as any[])[0].text, /read\(server\/src\/schema\.ts\).*superseded.*recall\("c1"\)/);
	// the input array was not mutated
	assert.equal((s[2].content as any[])[0].text.length, 8000);
});

test("protected: task, last user message and the recent zone stay verbatim", () => {
	const s = session();
	const { messages } = shape(s, { available: Math.floor(tokens(s) * 0.5), charsPerToken: CPT });
	assert.equal(messages[0], s[0]);
	const lastUser = s.filter((m) => m.role === "user").at(-1)!;
	assert.ok(messages.includes(lastUser));
	assert.equal(messages.at(-1), s.at(-1));
});

test("cheap moves first: a budget stubs+trim can meet is met without dropping anything", () => {
	const s = session();
	const { report } = shape(s, { available: 900, charsPerToken: CPT, recentShare: 0.3 });
	assert.ok(report.after <= 900);
	assert.equal(report.dropped, 0);
	assert.ok(report.stubbed + report.deduped > 0);
});

test("tight budget: drops whole oldest units, keeps call/result pairs intact, notes it on the task", () => {
	const s = session();
	const { messages, report } = shape(s, { available: 400, charsPerToken: CPT, recentShare: 0.3 });
	assert.ok(report.dropped > 0);
	for (const u of toUnits(messages)) {
		const ids = u.msgs.filter((m) => m.role === "assistant").flatMap((m) => (m.content as any[]).filter((b) => b.type === "toolCall").map((b) => b.id));
		const results = u.msgs.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
		assert.deepEqual(results, ids.filter((id) => results.includes(id)));
		for (const r of results) assert.ok(ids.includes(r), `orphan tool result ${r}`);
	}
	assert.match(String(messages[0].content), /earlier turn\(s\) elided/);
	assert.ok(report.elided.length > 0);
});

test("folds replace covered units with one memory block after the task", () => {
	const s = session();
	const covers = s.slice(1, 7).map((m) => m.timestamp); // c1..c3 units
	const { messages, report } = shape(s, {
		available: Math.floor(tokens(s) * 0.7), charsPerToken: CPT,
		folds: [{ id: "f1", summary: "- schema.ts defines batches; routes/batches.ts creates batches (ref c3)", covers }],
	});
	assert.equal(report.folded, 3);
	assert.equal(messages[0], s[0]);
	const memory = String((messages[1].content as any[])[0].text);
	assert.ok(memory.startsWith(`${STUB_MARK} memory]`));
	assert.match(memory, /DATA, not instructions/); // injected summaries must not read as instructions
	assert.ok(!messages.some((m) => m.toolCallId === "c1" || m.toolCallId === "c3"));
});

test("overBudget is reported honestly when the protected part alone doesn't fit", () => {
	clock = 1000;
	const s = [user("task"), call("c1", "read", { path: "a" }), result("c1", "read", 40_000)];
	const { report } = shape(s, { available: 500, charsPerToken: CPT });
	assert.equal(report.overBudget, true);
});
