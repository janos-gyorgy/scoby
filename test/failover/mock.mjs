// Two fake OpenAI-compatible endpoints on one port:
//   /flaky/v1/chat/completions -> always 429 with Retry-After: 1
//   /good/v1/chat/completions  -> streams a fixed answer
// Every hit is logged, so the test can see which provider served which attempt.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_PORT ?? 18181);
const logPath = process.env.MOCK_LOG ?? "mock-hits.log";

http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let model = "?";
			try {
				model = JSON.parse(body).model;
			} catch {}
			fs.appendFileSync(logPath, `${new Date().toISOString()} ${req.method} ${req.url} model=${model}\n`);

			if (req.url.startsWith("/flaky/")) {
				res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
				res.end(JSON.stringify({ error: { message: "rate limited (mock)", type: "rate_limit" } }));
				return;
			}
			if (req.url.startsWith("/good/")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
				const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model };
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "FAILOVER-OK " } }] });
				chunk({ ...base, choices: [{ index: 0, delta: { content: `served by ${model}` } }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
				res.end("data: [DONE]\n\n");
				return;
			}
			res.writeHead(404);
			res.end();
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
