// Three endpoints on one port: /plan (planner), /agent (the builder), /judge.
// The agent does exactly one tool call per step, then says the step is done.
import http from "node:http";
import fs from "node:fs";

const port = 18186;
const log = process.env.MOCK_LOG ?? "requests.jsonl";
const worked = new Set();
const sse = (res, model, content, toolCall) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "m", object: "chat.completion.chunk", created: 0, model };
  const delta = toolCall
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${worked.size}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: toolCall }) } }] }
    : { role: "assistant", content };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510 } })}\n\n`);
  res.end("data: [DONE]\n\n");
};

http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body);
    if (req.url.startsWith("/plan-busy/")) {
      fs.appendFileSync(log, JSON.stringify({ kind: "plan-busy" }) + "\n");
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: 503, message: "Service temporarily overloaded (mock)" } }));
    }
    if (req.url.startsWith("/plan-chatty/")) {
      const reminded = body.includes("Output ONLY the JSON object");
      fs.appendFileSync(log, JSON.stringify({ kind: "plan-chatty", reminded }) + "\n");
      if (!reminded) return sse(res, payload.model, "We are given a goal: track starter. Let me think about the phases step by step...");
      req.url = "/plan/v1/chat/completions"; // fall through to the good planner's answer
    }
    if (req.url.startsWith("/plan/")) {
      // both real ferment runs planned with an EMPTY goal and this mock never noticed — now it checks
      fs.appendFileSync(log, JSON.stringify({ kind: "plan", sawGoal: body.includes("warn me before it runs out") }) + "\n");
      return sse(res, payload.model, JSON.stringify({
        goal: "Track how much starter there is and warn before it runs out",
        criteria: ["starter stock tracked", "warn before starter runs out"], assumptions: ["litres"],
        phases: [{ title: "backend", steps: [{ title: "migration", detail: "add a column" }, { title: "route", detail: "expose it" }] },
                 { title: "frontend", steps: [{ title: "page", detail: "show it" }] }],
      }));
    }
    if (req.url.startsWith("/judge/")) {
      fs.appendFileSync(log, JSON.stringify({ kind: "judge", sawDiff: body.includes("## diff") }) + "\n");
      return sse(res, payload.model, JSON.stringify({ grade: "B", rationale: "fine", fix: "" }));
    }
    const text = JSON.stringify(payload.messages ?? []);
    const step = (text.match(/YOUR CURRENT STEP: (step-[\d.]+)/) || [])[1] ?? "none";
    fs.appendFileSync(log, JSON.stringify({ kind: "agent", step, brief: text.includes("Do ONLY this step") }) + "\n");
    if (!worked.has(step)) { worked.add(step); return sse(res, payload.model, null, `echo working on ${step} >> steps.txt`); }
    return sse(res, payload.model, `${step} done`);
  });
}).listen(port, "127.0.0.1", () => console.log("listening"));
