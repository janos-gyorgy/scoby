import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { clearLock, lockPath, pidAlive, readLock, refusal, repoRoot, writeLock, type Lock } from "./lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scoby-lock-"));
const lock = (over: Partial<Lock> = {}): Lock => ({
	sessionFile: "/sessions/a.jsonl", pid: 999999, goal: "make bash magenta\nmore", startedAt: "2026-09-17T16:38:00Z",
	updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(), step: "step-2.3", ...over,
});

test("write, read, clear round-trip; the lock dir is excluded from git, not gitignored", () => {
	const root = tmp();
	spawnSync("git", ["init", "-q"], { cwd: root });
	writeLock(root, lock());
	assert.equal(readLock(root)?.step, "step-2.3");
	assert.match(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8"), /^\.scoby\/$/m);
	assert.ok(!fs.existsSync(path.join(root, ".gitignore")));
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
	assert.equal(status.trim(), "", "lock must not show up as untracked");
	clearLock(root);
	assert.equal(readLock(root), undefined);
	clearLock(root); // idempotent
});

test("no lock, or my own lock: no refusal", () => {
	assert.equal(refusal(undefined, "/sessions/a.jsonl"), undefined);
	assert.equal(refusal(lock(), "/sessions/a.jsonl"), undefined);
});

test("another session's lock refuses, naming the step, the session file and the way out", () => {
	const msg = refusal(lock(), "/sessions/b.jsonl")!;
	assert.match(msg, /already in progress/);
	assert.match(msg, /"make bash magenta"/);
	assert.match(msg, /at step-2\.3, interrupted, last active 5 min ago/);
	assert.match(msg, /scoby --session \/sessions\/a\.jsonl/);
	assert.match(msg, /worktree/);
	assert.match(msg, /\/ferment unlock/);
});

test("a live owner is reported as running", () => {
	const msg = refusal(lock({ pid: process.ppid }), "/sessions/b.jsonl")!;
	assert.match(msg, new RegExp(`running now \\(pid ${process.ppid}\\)`));
});

test("pidAlive: this process yes, an absurd pid no", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(2 ** 22 + 12345), false);
	assert.equal(pidAlive(0), false);
});

test("a corrupt lock file reads as no lock", () => {
	const root = tmp();
	fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
	fs.writeFileSync(lockPath(root), "{not json");
	assert.equal(readLock(root), undefined);
});

test("repoRoot: git toplevel inside a repo, the cwd outside", () => {
	const root = tmp();
	assert.equal(fs.realpathSync(repoRoot(root)), fs.realpathSync(root));
	spawnSync("git", ["init", "-q"], { cwd: root });
	const sub = path.join(root, "src", "deep");
	fs.mkdirSync(sub, { recursive: true });
	assert.equal(fs.realpathSync(repoRoot(sub)), fs.realpathSync(root));
});
