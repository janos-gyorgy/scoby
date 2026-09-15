// Finish guard — pi glue. Baseline the gates at session start; when the agent ends a run with a
// normal stop, run the gates and, if they show new errors, send them back as a follow-up so the
// run continues. Capped, so a model that can't fix something doesn't loop forever.
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "../router/core.ts";
import { errorLines, newErrors, type GateRun } from "./gates.ts";

const ENTRY = "scoby-gate";

export function setupGuard(pi: ExtensionAPI, cfg: RouterConfig) {
	const gates = cfg.finish?.gates ?? [];
	if (!gates.length) return;
	const maxNudges = cfg.finish?.maxNudges ?? 3;
	let baseline: GateRun[] | undefined;
	let nudges = 0;

	const runGates = (cwd: string): GateRun[] =>
		gates.map((cmd) => {
			// no shell: argv split on spaces, like the Go v0 gates
			const [bin, ...args] = cmd.split(/\s+/);
			const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
			return { cmd, code: r.status ?? 1, lines: errorLines(`${r.stdout ?? ""}\n${r.stderr ?? ""}`) };
		});

	pi.on("session_start", async (_event, ctx) => {
		baseline = runGates(ctx.cwd);
		pi.appendEntry(ENTRY, { event: "baseline", gates: baseline.map((g) => ({ cmd: g.cmd, code: g.code, errors: g.lines.length })) });
	});

	pi.on("agent_end", async (event: any, ctx) => {
		if (!baseline) return;
		const lastMsg = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
		if (!lastMsg || lastMsg.stopReason !== "stop") return; // errors are the router's business
		const fresh = newErrors(baseline, runGates(ctx.cwd));
		pi.appendEntry(ENTRY, { event: "check", newErrors: fresh.reduce((n, g) => n + g.lines.length, 0), nudges });
		if (!fresh.length) return;
		if (nudges >= maxNudges) {
			pi.appendEntry(ENTRY, { event: "gave_up", nudges });
			return;
		}
		nudges++;
		const report = fresh.map((g) => `$ ${g.cmd}\n${g.lines.slice(0, 20).join("\n")}`).join("\n\n");
		pi.sendMessage(
			{
				customType: "scoby-gate",
				content: `[scoby] Not done yet: the gates show new errors compared to the start of this session. Fix them, then finish.\n\n${report}`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}
