// an agent that says it is done every time; records whether the gate errors reached it
import http from "node:http"; import fs from "node:fs";
http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ sawGateErrors: b.includes("TS2339") }) + "\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "m", object: "chat.completion.chunk", created: 0, model: "agent-model" };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "All done." } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 3, total_tokens: 903 } })}\n\n`);
  res.end("data: [DONE]\n\n"); }); }).listen(18185, "127.0.0.1", () => console.log("listening"));
