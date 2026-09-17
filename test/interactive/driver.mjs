// A scripted human, speaking pi's RPC protocol: request -> "Plan & build" -> "Change…" + one sentence
// -> (builder goes down) "Approve" -> scoby waits, comes back by itself, finishes -> a plain question
// answered as chat. A mock ntfy server records every push.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [root, work, sessions, agentDir, downFlag] = process.argv.slice(2);
const pushes = [];
const ntfy = http.createServer((req, res) => {
	let b = ""; req.on("data", (c) => (b += c));
	req.on("end", () => { pushes.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.end("{}"); });
}).listen(18187, "127.0.0.1");

const pi = spawn(path.join(root, "node_modules/.bin/pi"), ["--mode", "rpc", "--session-dir", sessions, "-e", path.join(root, "extensions/scoby/index.ts")], {
	cwd: work,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", SCOBY_CONFIG: path.join(work, "..", "scoby.json"), NTFY_TOKEN: "test-token", SCOBY_BACKOFF_SCALE: "0.01" },
	stdio: ["pipe", "pipe", "pipe"],
});
const send = (o) => pi.stdin.write(JSON.stringify(o) + "\n");
const seen = { selects: [], inputs: 0, widgets: [], notifies: [] };
let approvals = 0, finished = false, chatAnswered = false, phase = "build";

// strict JSONL: split on \n only (the docs warn readline also splits on U+2028/9)
let buf = "";
pi.stdout.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).replace(/\r$/, "");
		buf = buf.slice(i + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
pi.stderr.on("data", () => {});

function handle(m) {
	if (m.type === "extension_ui_request") {
		if (m.method === "select") {
			seen.selects.push(m.title);
			if (m.title === "scoby") return send({ type: "extension_ui_response", id: m.id, value: phase === "build" ? "Plan & build" : "Just answer" });
			if (m.title.startsWith("scoby: build this plan")) {
				approvals++;
				if (approvals === 1) return send({ type: "extension_ui_response", id: m.id, value: "Change…" });
				fs.writeFileSync(downFlag, ""); // the builder goes down right as the build starts
				return send({ type: "extension_ui_response", id: m.id, value: "Approve" });
			}
		}
		if (m.method === "input") {
			seen.inputs++;
			return send({ type: "extension_ui_response", id: m.id, value: "starting a starter batch consumes starter too" });
		}
		if (m.method === "setWidget" && m.widgetLines) {
			const text = m.widgetLines.join("\n");
			seen.widgets.push(text);
			if (text.includes("waiting for models") && fs.existsSync(downFlag)) setTimeout(() => fs.rmSync(downFlag, { force: true }), 1500);
		}
		if (m.method === "notify") {
			seen.notifies.push(m.message);
			if (m.message.includes("build finished")) finished = true;
		}
		return;
	}
	if (m.type === "agent_end" && phase === "chat") chatAnswered = true;
}

send({ type: "prompt", message: "Track how much starter I have and warn me before it runs out." });
const started = Date.now();
const tick = setInterval(() => {
	if (phase === "build" && finished) {
		phase = "chat";
		setTimeout(() => send({ type: "prompt", message: "what is a scoby, briefly?" }), 500);
	}
	if ((phase === "chat" && chatAnswered) || Date.now() - started > 180_000) {
		clearInterval(tick);
		pi.kill();
		ntfy.close();
		const branch = spawnSync("git", ["branch", "--show-current"], { cwd: work, encoding: "utf8" }).stdout.trim();
		fs.writeFileSync(path.join(work, "..", "result.json"), JSON.stringify({ seen, pushes, branch, finished, chatAnswered, seconds: Math.round((Date.now() - started) / 1000) }, null, 1));
		process.exit(0);
	}
}, 250);
