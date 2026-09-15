// Finish guard — pure parts. A "done" only counts when the configured gates show no NEW errors
// compared to the baseline taken at session start (the repo may already be red: Brew Buddy's
// frontend typecheck has one known error). The Kimchi-trial lesson as code: a typecheck that
// blocks "done" until it passes, instead of a rule asking the model to remember.

/** Error lines with tsc-style (line,col) positions stripped — positions move when code is edited. */
export function errorLines(output: string): string[] {
	const set = new Set<string>();
	for (const line of output.split("\n")) {
		if (/\berror\b/i.test(line)) set.add(line.replace(/\(\d+,\d+\)/g, "").trim());
	}
	return [...set].sort();
}

export interface GateRun {
	cmd: string;
	code: number;
	lines: string[];
}

/** New errors per gate: lines not in the baseline; a red gate with no error lines counts if it was green before. */
export function newErrors(baseline: GateRun[], now: GateRun[]): { cmd: string; lines: string[] }[] {
	const out: { cmd: string; lines: string[] }[] = [];
	for (const g of now) {
		if (g.code === 0) continue;
		const base = baseline.find((b) => b.cmd === g.cmd);
		const known = new Set(base?.lines ?? []);
		const fresh = g.lines.filter((l) => !known.has(l));
		if (fresh.length) out.push({ cmd: g.cmd, lines: fresh });
		else if (!g.lines.length && (!base || base.code === 0)) out.push({ cmd: g.cmd, lines: [`exit ${g.code} (no error lines)`] });
	}
	return out;
}
