import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLines, newErrors } from "./gates.ts";

const baselineTsc = `src/components/ui/use-toast.ts(1,33): error TS2307: Cannot find module '@/hooks/use-toast' or its corresponding type declarations.`;

test("errorLines strips positions so edits don't make old errors look new", () => {
	assert.deepEqual(errorLines(baselineTsc), [`src/components/ui/use-toast.ts: error TS2307: Cannot find module '@/hooks/use-toast' or its corresponding type declarations.`]);
});

test("only errors missing from the baseline count — the ones seen in the first real bench run", () => {
	const base = [{ cmd: "tsc app", code: 2, lines: errorLines(baselineTsc) }, { cmd: "tsc server", code: 0, lines: [] }];
	const now = [
		{ cmd: "tsc app", code: 2, lines: errorLines(baselineTsc.replace("(1,33)", "(2,40)") + `\nsrc/pages/Starter.tsx(12,9): error TS2339: Property 'is_starter_recipe' does not exist on type 'Recipe'.`) },
		{ cmd: "tsc server", code: 0, lines: [] },
	];
	assert.deepEqual(newErrors(base, now), [{ cmd: "tsc app", lines: [`src/pages/Starter.tsx: error TS2339: Property 'is_starter_recipe' does not exist on type 'Recipe'.`] }]);
});

test("a gate that turns red without error lines still counts, unless it was already red", () => {
	assert.equal(newErrors([{ cmd: "build", code: 0, lines: [] }], [{ cmd: "build", code: 1, lines: [] }]).length, 1);
	assert.equal(newErrors([{ cmd: "build", code: 1, lines: [] }], [{ cmd: "build", code: 1, lines: [] }]).length, 0);
});
