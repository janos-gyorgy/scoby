import { test } from "node:test";
import assert from "node:assert/strict";
import { BUBBLES, endCard, fmtK, gradeCard, isPoorGrade, JAR, planCard, shortModel, statusLine, welcomeLines } from "./render.ts";

const roles = [
	{ role: "builder", targets: [{ raw: "nim/deepseek-ai/deepseek-v4-flash-0731", cooling: false }, { raw: "nim/nvidia/nemotron-3-super-120b-a12b", cooling: true }] },
	{ role: "planner", targets: [{ raw: "gemini/gemini-3.5-flash", cooling: false }] },
];

test("welcome: jar beside the facts, every line fits 80 columns, no trailing spaces", () => {
	const lines = welcomeLines({ repo: "crowded", branch: "scoby/make-bash-magenta-2026-09-17", roles, budget: 32000, notify: true });
	assert.equal(lines.length, JAR.length);
	assert.match(lines[0], /scoby · a free Kimchi/);
	assert.match(lines[1], /crowded · scoby\/make-bash-magenta/);
	assert.match(lines[2], /builder\s+deepseek-v4-flash → nemotron-3-super-120b-a12b ⏸/);
	assert.match(lines[4], /budget 32K per request · ntfy on/);
	assert.match(lines[5], /Plan & build, or Just answer/);
	for (const l of lines) {
		assert.ok(l.length <= 80, `too wide: ${l}`);
		assert.ok(!/\s$/.test(l));
	}
});

test("welcome: a paused build here is the first thing you read after the roles", () => {
	const lines = welcomeLines({ repo: "crowded", roles, budget: 32000, notify: false, lock: { step: "step-2.3", goal: "make bash magenta\nmore" } });
	assert.ok(lines.some((l) => /⚠ a build is paused here at step-2\.3: "make bash magenta"/.test(l)));
	assert.ok(lines.some((l) => /\/ferment unlock/.test(l)));
	assert.ok(lines.length >= JAR.length);
});

test("welcome: a resumed run says where it is", () => {
	const lines = welcomeLines({ repo: "corvid", roles, budget: 32000, notify: true, resumed: { step: "step-1.2", done: 1, total: 8 } });
	assert.ok(lines.some((l) => /resumed: 1\/8 steps done, at step-1\.2/.test(l)));
});

test("status line: model, tokens against budget, step and grades", () => {
	assert.equal(statusLine({ role: "builder", model: "nim/deepseek-ai/deepseek-v4-flash-0731", usedTokens: 24145, budget: 32000, step: "step-2.3", grades: ["A", "D"] }), "builder → deepseek-v4-flash · 24K/32K · step-2.3 · A D");
	assert.equal(statusLine({ role: "builder", budget: 32000 }), "builder → ? · budget 32K");
	assert.equal(statusLine({ role: "builder", model: "groq/openai/gpt-oss-120b", budget: 8000, waiting: true, step: "step-1.1" }), "builder → gpt-oss-120b · budget 8.0K · waiting for models");
});

test("plan card numbers phases and steps; grade and end cards", () => {
	const plan = { goal: "Make Bash magenta", phases: [{ title: "Investigate", steps: [{ title: "Read data" }, { title: "Read renderer" }] }, { title: "Implement", steps: [{ title: "Flag" }] }] };
	assert.deepEqual(planCard(plan, "fallback"), ["plan · Make Bash magenta", "1. Investigate", "   1.1 Read data", "   1.2 Read renderer", "2. Implement", "   2.1 Flag"]);
	assert.deepEqual(gradeCard({ phaseId: "phase-1", grade: "D", rationale: " only the label changed " }, "Investigate"), ["phase 1 · Investigate — graded D", "only the label changed"]);
	assert.deepEqual(endCard({ type: "completed", summary: "phase-1:A phase-2:A" }), ["build finished · phase-1:A phase-2:A", "review the branch: git diff, then commit or discard"]);
	assert.deepEqual(endCard({ type: "failed", reason: "stuck on step-1.1" }), ["build stopped · stuck on step-1.1"]);
	assert.ok(isPoorGrade("D") && isPoorGrade("f") && !isPoorGrade("A"));
});

test("helpers", () => {
	assert.equal(fmtK(32000), "32K");
	assert.equal(fmtK(8000), "8.0K");
	assert.equal(fmtK(500), "500");
	assert.equal(shortModel("nim/deepseek-ai/deepseek-v4-flash-0731"), "deepseek-v4-flash");
	assert.equal(shortModel("gemini/gemini-3.5-flash"), "gemini-3.5-flash");
	assert.equal(BUBBLES.length, 6);
});
