// Three fake endpoints, each failing the way a real free tier did:
//   /ratelimited  429 (Groq/NIM style)
//   /busy         503 with Gemini's "high demand" body shape
//   /good         streams an answer naming the model that served it
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_PORT ?? 18182);
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
			fs.appendFileSync(logPath, `${req.url.split("/")[1]} model=${model}\n`);

			if (req.url.startsWith("/ratelimited/")) {
				res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
				return res.end(JSON.stringify({ error: { message: "rate limited (mock)", type: "rate_limit" } }));
			}
			if (req.url.startsWith("/busy/")) {
				res.writeHead(503, { "content-type": "application/json" });
				return res.end(JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand. (mock)", status: "UNAVAILABLE" } }));
			}
			if (req.url.startsWith("/glitch/")) {
				// 200 + an error object in the stream: how NIM surfaced "list index out of range" mid-run
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ error: { message: "list index out of range", type: "internal" } })}\n\n`);
				return res.end("data: [DONE]\n\n");
			}
			if (req.url.startsWith("/good/")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
				const base = { id: "mock", object: "chat.completion.chunk", created: 0, model };
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `ROUTED-OK served by ${model}` } }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
				return res.end("data: [DONE]\n\n");
			}
			res.writeHead(404);
			res.end();
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
