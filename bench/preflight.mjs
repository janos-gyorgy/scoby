// Is the builder model usable right now? One small tool-call request; exit 0 = go, 1 = skip.
const model = process.argv[2] ?? "nvidia/nemotron-3-super-120b-a12b";
const body = {
  model, max_tokens: 64, temperature: 0,
  tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
  messages: [{ role: "user", content: "Read package.json with the tool." }],
};
const started = Date.now();
try {
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json", "User-Agent": "scoby/0.1" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const ok = res.ok && Boolean(data.choices?.[0]?.message?.tool_calls?.length);
  console.log(`${model}: ${res.status} ${((Date.now() - started) / 1000).toFixed(1)}s toolcall=${ok} ${ok ? "" : JSON.stringify(data).slice(0, 200)}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(`${model}: ${e.name} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(1);
}
