// Failover probe: does pi's agent-level retry pick up a model that an extension
// switched to after a 429? If yes, a quota-aware router is just "on 429, setModel(next)".
//
// FAILOVER_MODE=off     -> register providers only (baseline: expect retries on flaky, then error)
// FAILOVER_MODE=switch  -> on 429 from flaky, setModel(good) inside after_provider_response
//                          (finding: this hook never fired for openai-completions — not even on 429)
// FAILOVER_MODE=msgend  -> on an assistant message_end with a 429 error, setModel(good)
//                          (it fires ~2s before pi's agent-level retry starts the next turn)
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const port = process.env.MOCK_PORT ?? "18181";
const logPath = process.env.PROBE_LOG ?? "probe.log";
const mode = process.env.FAILOVER_MODE ?? "switch";
// where to fail over to: "provider/model-id" (model ids may contain slashes, e.g. groq/openai/gpt-oss-120b)
const target = process.env.FAILOVER_TARGET ?? "good/good-model";
const [targetProvider, ...rest] = target.split("/");
const targetModel = rest.join("/");
const log = (line: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
	maxTokens: 1024,
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider("flaky", {
		baseUrl: `http://127.0.0.1:${port}/flaky/v1`,
		apiKey: "mock",
		api: "openai-completions",
		models: [model("flaky-model")],
	});
	pi.registerProvider("good", {
		baseUrl: `http://127.0.0.1:${port}/good/v1`,
		apiKey: "mock",
		api: "openai-completions",
		models: [model("good-model")],
	});

	pi.on("after_provider_response", async (event, ctx) => {
		log(`after_provider_response status=${event.status} model=${ctx.model?.provider}/${ctx.model?.id}`);
		if (mode !== "switch" || event.status !== 429 || ctx.model?.provider !== "flaky") return;
		const next = ctx.modelRegistry.find("good", "good-model");
		const ok = next ? await pi.setModel(next) : false;
		log(`switched to good/good-model ok=${ok}`);
	});

	pi.on("turn_start", async (_e, ctx) => log(`turn_start model=${ctx.model?.provider}/${ctx.model?.id}`));
	pi.on("message_end", async (e: any, ctx) => {
		const m = e.message ?? {};
		log(`message_end role=${m.role} stop=${m.stopReason ?? ""} err=${(m.errorMessage ?? "").slice(0, 80)} model=${ctx.model?.provider}/${ctx.model?.id}`);
		if (mode !== "msgend" || m.role !== "assistant" || m.stopReason !== "error") return;
		if (!/^429\b/.test(m.errorMessage ?? "") || ctx.model?.provider !== "flaky") return;
		const next = ctx.modelRegistry.find(targetProvider, targetModel);
		const ok = next ? await pi.setModel(next) : false;
		// Gotcha found live: the old model's thinking level rides along. flaky-model is
		// non-reasoning, which Gemini 3.8 Flash receives as MINIMAL -> 400. The router must
		// pick a level the new model accepts.
		const level = process.env.FAILOVER_THINKING;
		if (ok && level) pi.setThinkingLevel(level as any);
		log(`msgend: switched to ${target} ok=${ok} thinking=${pi.getThinkingLevel()}`);
	});
	pi.on("agent_end", async (_e, ctx) => log(`agent_end model=${ctx.model?.provider}/${ctx.model?.id}`));
}
