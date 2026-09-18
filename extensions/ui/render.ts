// scoby UI — pure renderers. Plain strings in, lines out; colour is applied by the glue with pi's
// theme so these test without a terminal.

export interface RoleHealth {
	role: string;
	targets: { raw: string; cooling: boolean }[];
}

export interface WelcomeInfo {
	repo: string;
	branch?: string;
	roles: RoleHealth[];
	budget: number;
	notify: boolean;
	/** another session's build in progress here */
	lock?: { step?: string; goal: string };
	/** this session's own run, when resumed */
	resumed?: { step?: string; done: number; total: number };
}

export interface StatusInfo {
	role: string;
	model?: string;
	usedTokens?: number;
	budget: number;
	step?: string;
	grades?: string[];
	waiting?: boolean;
}

/** A jar with a scoby floating on top. Six lines, 12 columns — fits any terminal. */
export const JAR = [
	"  ╭────────╮ ",
	"  │ ≈≈≈≈≈≈ │ ",
	"  │≡≡≡≡≡≡≡≡│ ",
	"  │  °  .  │ ",
	"  │ .    ° │ ",
	"  ╰────────╯ ",
];

/** Fermentation bubbles for the working indicator. */
export const BUBBLES = ["·", "∘", "°", "○", "°", "∘"];

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));
export const shortModel = (raw: string) => raw.split("/").pop()!.replace(/-\d{4}$/, "");

/** Facts beside the jar; the first line is the title. Extra facts wrap below the jar. */
export function welcomeLines(info: WelcomeInfo): string[] {
	const facts: string[] = [];
	facts.push("scoby · a free Kimchi");
	facts.push(`${info.repo}${info.branch ? ` · ${info.branch}` : ""}`);
	for (const r of info.roles) {
		const chain = r.targets.map((t) => shortModel(t.raw) + (t.cooling ? " ⏸" : "")).join(" → "); // ⏸ = cooling down after a failure
		facts.push(`${r.role.padEnd(9)} ${chain}`);
	}
	facts.push(`budget ${fmtK(info.budget)} per request · ntfy ${info.notify ? "on" : "off"}`);
	if (info.lock) {
		facts.push(`⚠ a build is paused here${info.lock.step ? ` at ${info.lock.step}` : ""}: "${info.lock.goal.split("\n")[0].slice(0, 50)}"`);
		facts.push("  resume it with scoby --session <file>, or /ferment unlock");
	} else if (info.resumed) {
		facts.push(`resumed: ${info.resumed.done}/${info.resumed.total} steps done${info.resumed.step ? `, at ${info.resumed.step}` : ""} — type anything to continue`);
	} else {
		facts.push("type what you want; I ask once: Plan & build, or Just answer");
	}
	const lines: string[] = [];
	const rows = Math.max(JAR.length, facts.length);
	for (let i = 0; i < rows; i++) {
		lines.push(`${JAR[i] ?? " ".repeat(JAR[0].length)}  ${facts[i] ?? ""}`.replace(/\s+$/, ""));
	}
	return lines;
}

/** One line for pi's footer: where the session is right now. */
export function statusLine(s: StatusInfo): string {
	const parts = [`${s.role} → ${s.model ? shortModel(s.model) : "?"}`];
	if (s.usedTokens) parts.push(`${fmtK(s.usedTokens)}/${fmtK(s.budget)}`);
	else parts.push(`budget ${fmtK(s.budget)}`);
	if (s.waiting) parts.push("waiting for models");
	else if (s.step) parts.push(s.step);
	if (s.grades?.length) parts.push(s.grades.join(" "));
	return parts.join(" · ");
}

export interface PlanLike {
	goal?: string;
	phases: { title: string; steps: { title: string }[] }[];
}

/** The approved plan as a card that stays in the transcript. */
export function planCard(plan: PlanLike, goal: string): string[] {
	const lines = [`plan · ${(plan.goal ?? goal).split("\n")[0].slice(0, 100)}`];
	plan.phases.forEach((p, i) => {
		lines.push(`${i + 1}. ${p.title}`);
		p.steps.forEach((s, j) => lines.push(`   ${i + 1}.${j + 1} ${s.title}`));
	});
	return lines;
}

export function gradeCard(e: { phaseId: string; grade: string; rationale?: string }, phaseTitle?: string): string[] {
	const n = e.phaseId.replace(/^phase-/, "");
	const head = `phase ${n}${phaseTitle ? ` · ${phaseTitle}` : ""} — graded ${e.grade}`;
	return e.rationale ? [head, e.rationale.trim()] : [head];
}

export function endCard(e: { type: "completed"; summary?: string } | { type: "failed"; reason?: string }): string[] {
	if (e.type === "completed") return [`build finished · ${e.summary ?? ""}`.trim(), "review the branch: git diff, then commit or discard"];
	return [`build stopped · ${e.reason ?? "unknown reason"}`];
}

export const isPoorGrade = (g: string) => /^[DF]$/i.test(g.trim());
