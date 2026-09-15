import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, parseTarget, Router, validateConfig, type RouterConfig } from "./core.ts";

const cfg: RouterConfig = {
	connections: {
		groq: { provider: "groq" },
		gemini: { provider: "google" },
		nim: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", models: [{ id: "moonshotai/kimi-k3" }] },
	},
	roles: {
		builder: ["gemini/gemini-3.8-flash:low", "groq/openai/gpt-oss-120b", "nim/moonshotai/kimi-k3"],
	},
	defaultRole: "builder",
	failover: { cooldownSeconds: 60 },
};

test("parseTarget: model ids with slashes, thinking suffix, built-in vs custom provider", () => {
	assert.deepEqual(parseTarget("groq/openai/gpt-oss-120b", cfg.connections), {
		raw: "groq/openai/gpt-oss-120b", connection: "groq", provider: "groq", modelId: "openai/gpt-oss-120b", thinking: undefined,
	});
	const g = parseTarget("gemini/gemini-3.8-flash:low", cfg.connections);
	assert.equal(g.provider, "google");
	assert.equal(g.thinking, "low");
	assert.equal(parseTarget("nim/moonshotai/kimi-k3", cfg.connections).provider, "nim");
	// ':' that isn't a thinking level stays part of the model id
	assert.equal(parseTarget("nim/llama3:8b", cfg.connections).modelId, "llama3:8b");
	assert.throws(() => parseTarget("nope/x", cfg.connections), /unknown connection/);
	assert.throws(() => parseTarget("groq", cfg.connections), /connection\/model-id/);
});

test("validateConfig catches the mistakes a user will actually make", () => {
	assert.deepEqual(validateConfig(cfg), []);
	const bad = validateConfig({
		connections: { a: {}, b: { baseUrl: "http://x" } },
		roles: { r: ["zzz/model"], empty: [] },
		defaultRole: "missing",
	});
	assert.equal(bad.length, 5, bad.join("\n"));
});

test("classifyError on the real strings seen from pi", () => {
	assert.deepEqual(classifyError(`429: {"message":"rate limited (mock)","type":"rate_limit"}`), { kind: "rate_limit", status: 429, failover: true });
	const gemini503 = `{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand.`;
	assert.equal(classifyError(gemini503).kind, "overloaded");
	assert.equal(classifyError(gemini503).status, 503);
	assert.equal(classifyError(`{"message":"Payment required to access this resource.","code":"payment_required"}`).kind, "auth");
	const thinking400 = `{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Thinking level MINIMAL is not supported`;
	assert.deepEqual(classifyError(thinking400), { kind: "other", status: 400, failover: false });
});

test("Router walks the chain, cools failed targets, and recovers", () => {
	const r = new Router(cfg);
	const t0 = 1_000_000;
	assert.equal(r.pick("builder", t0).raw, "gemini/gemini-3.8-flash:low");

	r.markFailed("gemini/gemini-3.8-flash:low", "overloaded", t0);
	assert.equal(r.pick("builder", t0).raw, "groq/openai/gpt-oss-120b");

	r.markFailed("groq/openai/gpt-oss-120b", "rate_limit", t0 + 1000);
	assert.equal(r.pick("builder", t0 + 1000).raw, "nim/moonshotai/kimi-k3");

	// everything cooling -> the one that recovers soonest, not a crash
	r.markFailed("nim/moonshotai/kimi-k3", "auth", t0 + 2000);
	assert.equal(r.pick("builder", t0 + 2000).raw, "gemini/gemini-3.8-flash:low");

	// cooldown over -> back to the preferred target
	assert.equal(r.pick("builder", t0 + 61_000).raw, "gemini/gemini-3.8-flash:low");
	// exclude = "not the one that just failed", even if its cooldown somehow lapsed
	assert.equal(r.pick("builder", t0 + 61_000, ["gemini/gemini-3.8-flash:low"]).raw, "groq/openai/gpt-oss-120b");
});

test("thinking level never inherits: explicit, else by reasoning capability", () => {
	const r = new Router(cfg);
	const [gemini, groq] = r.targets("builder");
	assert.equal(Router.thinkingFor(gemini, true), "low");
	assert.equal(Router.thinkingFor(groq, true), "low");
	assert.equal(Router.thinkingFor(groq, false), "off");
});
