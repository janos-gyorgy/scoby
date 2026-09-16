import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, assertPlanShape, initial, MAX_STEP_STARTS, next, planMatchesGoal, stepBrief, type Event, type State } from "./core.ts";

const plan = {
	criteria: ["stock is tracked"],
	assumptions: ["starter is measured in litres"],
	phases: [
		{ title: "backend", steps: [{ title: "migration", detail: "add columns" }, { title: "routes" }] },
		{ title: "frontend", steps: [{ title: "page" }] },
	],
};
const planned = () => apply(initial("track starter stock"), { type: "planned", plan });

/** Drive the machine the way the glue does: answer each action with the event it produces. */
function drive(state: State, answer: (a: ReturnType<typeof next>) => Event | undefined, max = 40): State {
	let s = state;
	for (let i = 0; i < max; i++) {
		const a = next(s);
		const e = answer(a);
		if (!e) return s;
		s = apply(s, e);
	}
	throw new Error("did not settle");
}

test("plan first, then phases and steps in order, gate and judge between phases", () => {
	const seen: string[] = [];
	const s = drive(planned(), (a) => {
		seen.push(a.kind === "run_step" ? a.stepId : a.kind);
		switch (a.kind) {
			case "activate_phase": return { type: "phase_activated", phaseId: a.phaseId };
			case "run_step": return { type: "step_started", phaseId: a.phaseId, stepId: a.stepId };
			case "gate": return { type: "gate_passed", phaseId: a.phaseId };
			case "judge": return { type: "phase_graded", phaseId: a.phaseId, grade: "B" };
			case "complete": return { type: "completed", summary: "done" };
			default: return undefined;
		}
	}, 60);
	// a step that is started but never finished is retried, then the stuck guard fires
	assert.deepEqual(seen.slice(0, 4), ["activate_phase", "step-1.1", "step-1.1", "step-1.1"]);
	assert.equal(seen[4], "fail");
	assert.equal(s.status, "running"); // the fail action is returned; the glue decides to record it
});

test("without step_finished the run never completes, however many gates pass", () => {
	const s = drive(planned(), (a) => {
		switch (a.kind) {
			case "activate_phase": return { type: "phase_activated", phaseId: a.phaseId };
			case "run_step": return { type: "step_started", phaseId: a.phaseId, stepId: a.stepId };
			case "gate": return { type: "gate_passed", phaseId: a.phaseId };
			case "judge": return { type: "phase_graded", phaseId: a.phaseId, grade: "A" };
			case "complete": return { type: "completed", summary: "all done" };
			default: return undefined;
		}
	});
	assert.equal(s.status, "running"); // steps never finished, so it cannot complete
});

test("a finished step advances; the run completes only when all phases are graded", () => {
	let s = planned();
	for (let i = 0; i < 30; i++) {
		const a = next(s);
		if (a.kind === "done") break;
		if (a.kind === "activate_phase") s = apply(s, { type: "phase_activated", phaseId: a.phaseId });
		else if (a.kind === "run_step") {
			s = apply(s, { type: "step_started", phaseId: a.phaseId, stepId: a.stepId });
			s = apply(s, { type: "step_finished", phaseId: a.phaseId, stepId: a.stepId, summary: `did ${a.stepId}` });
		} else if (a.kind === "gate") s = apply(s, { type: "gate_passed", phaseId: a.phaseId });
		else if (a.kind === "judge") s = apply(s, { type: "phase_graded", phaseId: a.phaseId, grade: "B" });
		else if (a.kind === "complete") s = apply(s, { type: "completed", summary: "shipped" });
	}
	assert.equal(s.status, "complete");
	assert.deepEqual(s.phases.map((p) => [p.status, p.grade]), [["completed", "B"], ["completed", "B"]]);
});

test("a red gate adds a fix step and runs the gate again", () => {
	let s = planned();
	s = apply(s, { type: "phase_activated", phaseId: "phase-1" });
	for (const id of ["step-1.1", "step-1.2"]) {
		s = apply(s, { type: "step_started", phaseId: "phase-1", stepId: id });
		s = apply(s, { type: "step_finished", phaseId: "phase-1", stepId: id });
	}
	assert.equal(next(s).kind, "gate");
	s = apply(s, { type: "gate_failed", phaseId: "phase-1", report: "TS2339 ..." });
	const a = next(s);
	assert.equal(a.kind, "run_step");
	assert.match((a as any).stepId, /fix/);
});

test("a D grade buys exactly one fix round, then the phase completes", () => {
	let s = planned();
	s = apply(s, { type: "phase_activated", phaseId: "phase-1" });
	for (const id of ["step-1.1", "step-1.2"]) {
		s = apply(s, { type: "step_started", phaseId: "phase-1", stepId: id });
		s = apply(s, { type: "step_finished", phaseId: "phase-1", stepId: id });
	}
	s = apply(s, { type: "gate_passed", phaseId: "phase-1" });
	s = apply(s, { type: "phase_graded", phaseId: "phase-1", grade: "D", fix: "wire the deduction" });
	assert.match((next(s) as any).stepId, /fix/); // one fix step
	const fix = s.phases[0].steps.at(-1)!;
	s = apply(s, { type: "step_started", phaseId: "phase-1", stepId: fix.id });
	s = apply(s, { type: "step_finished", phaseId: "phase-1", stepId: fix.id });
	s = apply(s, { type: "gate_passed", phaseId: "phase-1" });
	s = apply(s, { type: "phase_graded", phaseId: "phase-1", grade: "D" });
	assert.equal(s.phases[0].status, "completed"); // second D stands
});

test("stuck-step guard", () => {
	let s = planned();
	s = apply(s, { type: "phase_activated", phaseId: "phase-1" });
	for (let i = 0; i < MAX_STEP_STARTS; i++) s = apply(s, { type: "step_started", phaseId: "phase-1", stepId: "step-1.1" });
	assert.equal(next(s).kind, "fail");
});

test("stepBrief carries goal, plan with statuses, and only the current step's detail", () => {
	let s = planned();
	s = apply(s, { type: "phase_activated", phaseId: "phase-1" });
	s = apply(s, { type: "step_started", phaseId: "phase-1", stepId: "step-1.1" });
	const brief = stepBrief(s, "phase-1", "step-1.1", false);
	assert.match(brief, /track starter stock/);
	assert.match(brief, /YOUR CURRENT STEP: step-1.1 — migration/);
	assert.match(brief, /add columns/);
	assert.match(brief, /phase-2 frontend \[planned\]/);
	assert.match(brief, /Do ONLY this step/);
});

test("planMatchesGoal rejects the real ferment-32k-r5 plan and accepts an on-goal one", () => {
	const goal = `To brew kombucha you need a healthy amount of starter liquid ready. Starter is made via the standard
process — an F1 brewed with the dedicated starter recipe, seeded from existing starter liquid — then stored in the
fridge. So making more takes a full F1 cycle. Build a feature that tracks how much starter I have, plans brewing
more when stock runs low, and notifies me in time.`;
	const wrong = {
		criteria: ["Fermentation log entries can include optional free-form notes", "Notes field is persisted in the database and visible in the UI"],
		phases: [
			{ title: "Backend: Add notes column and verify API handling", steps: [{ title: "Create database migration for notes column" }, { title: "Verify API handles notes field" }] },
			{ title: "Frontend: Update types, validation, and UI", steps: [{ title: "Add notes field to log entry form" }] },
		],
	};
	const right = {
		goal: "Track starter liquid stock, plan brewing more starter before it runs low, and notify in time.",
		criteria: ["starter stock is tracked in litres", "starting an F1 batch consumes starter"],
		phases: [{ title: "Stock tracking", steps: [{ title: "Add starter stock column", detail: "migration + schema" }] }],
	};
	assert.equal(planMatchesGoal(goal, wrong).ok, false, JSON.stringify(planMatchesGoal(goal, wrong).shared));
	assert.equal(planMatchesGoal(goal, right).ok, true, JSON.stringify(planMatchesGoal(goal, right).shared));
});

test("assertPlanShape: a phase without steps (ferment-32k-r8) is a readable rejection, not a TypeError", () => {
	const r8like = { phases: [{ title: "Backend", tasks: ["add column"] }] };
	assert.throws(() => assertPlanShape(r8like), /has no steps array/);
	assert.throws(() => assertPlanShape({ phases: [] }), /no phases/);
	assert.throws(() => assertPlanShape({ phases: [{ title: "x", steps: [{ detail: "no title" }] }] }), /step 1 has no title/);
	assert.doesNotThrow(() => assertPlanShape({ phases: [{ title: "x", steps: [{ title: "y" }] }] }));
	// and the goal check never crashes on a malformed plan
	assert.doesNotThrow(() => planMatchesGoal("track starter stock", r8like as any));
});
