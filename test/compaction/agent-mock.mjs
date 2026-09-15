// A fake model that behaves like an agent: for the first N requests it asks to read
// big-<k>.txt, then it answers. It records the size of every request it receives, so the
// test can check what really went over the wire.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_PORT ?? 18184);
const turns = Number(process.env.MOCK_TURNS ?? 8);
const logPath = process.env.MOCK_LOG ?? "requests.jsonl";
let n = 0;

http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			n++;
			const payload = JSON.parse(body);
			const messages = payload.messages ?? [];
			const tools = (payload.tools ?? []).map((t) => t.function?.name);
			const stubs = messages.filter((m) => JSON.stringify(m.content ?? "").includes("[scoby:")).length;
			fs.appendFileSync(logPath, JSON.stringify({ n, bodyChars: body.length, messages: messages.length, stubs, tools }) + "\n");

			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			const base = { id: `mock-${n}`, object: "chat.completion.chunk", created: 0, model: payload.model };
			if (n <= turns) {
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `big-${n}.txt` }) } }] } }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: Math.round(body.length / 3.6), completion_tokens: 20, total_tokens: Math.round(body.length / 3.6) + 20 } });
			} else {
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "DONE reading" } }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.round(body.length / 3.6), completion_tokens: 3, total_tokens: Math.round(body.length / 3.6) + 3 } });
			}
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`agent mock listening on ${port}`));
