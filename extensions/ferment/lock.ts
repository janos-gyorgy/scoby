// Repo lock — one build per repo at a time.
//
// Found on 2026-09-17: a second scoby session started a new build in a repo where another session's
// build sat interrupted at step 2.3 (the SSH connection had dropped). Nothing noticed. The lock is a
// small JSON file in <repo>/.scoby/ that the owning session keeps current while its run is in
// progress and removes when the run ends. It outlives the process on purpose: an interrupted build
// is still a build, and the right move is to resume that session, not to start over on top of it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Lock {
	sessionFile: string;
	pid: number;
	goal: string;
	startedAt: string;
	updatedAt: string;
	/** the step running when the lock was last written */
	step?: string;
}

export const LOCK_DIR = ".scoby";
export const LOCK_FILE = "lock.json";

/** The repo root (git toplevel), or the cwd itself outside git. */
export function repoRoot(cwd: string): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

export const lockPath = (root: string) => path.join(root, LOCK_DIR, LOCK_FILE);

export function readLock(root: string): Lock | undefined {
	try {
		const lock = JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
		return lock && typeof lock.sessionFile === "string" ? (lock as Lock) : undefined;
	} catch {
		return undefined;
	}
}

export function writeLock(root: string, lock: Lock): void {
	fs.mkdirSync(path.join(root, LOCK_DIR), { recursive: true });
	excludeFromGit(root);
	fs.writeFileSync(lockPath(root), JSON.stringify(lock, null, 2) + "\n");
}

export function clearLock(root: string): void {
	try {
		fs.unlinkSync(lockPath(root));
	} catch {
		/* already gone */
	}
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM"; // exists, not ours
	}
}

/**
 * Why a new build may not start here, or undefined when it may. Only another session's lock
 * counts: the owning session resuming its own run is the normal path.
 */
export function refusal(lock: Lock | undefined, mySessionFile: string, now = Date.now()): string | undefined {
	if (!lock || lock.sessionFile === mySessionFile) return undefined;
	const live = pidAlive(lock.pid) && lock.pid !== process.pid;
	const since = Math.max(0, now - Date.parse(lock.updatedAt || lock.startedAt));
	const ago = since < 3_600_000 ? `${Math.round(since / 60_000)} min ago` : `${(since / 3_600_000).toFixed(1)} h ago`;
	return [
		`scoby: a build is already in progress in this repo — "${lock.goal.split("\n")[0].slice(0, 80)}"`,
		`  ${lock.step ? `at ${lock.step}, ` : ""}${live ? `running now (pid ${lock.pid})` : `interrupted, last active ${ago}`}`,
		`  continue it:      scoby --session ${lock.sessionFile}`,
		`  build elsewhere:  git worktree add ../<dir> && cd ../<dir> && scoby`,
		`  or drop it:       /ferment unlock   (deletes ${path.join(LOCK_DIR, LOCK_FILE)}; the half-done changes stay in the tree)`,
	].join("\n");
}

/** Keep the lock dir out of `git status` without touching the repo's own .gitignore. */
function excludeFromGit(root: string): void {
	const exclude = path.join(root, ".git", "info", "exclude");
	try {
		if (!fs.existsSync(path.join(root, ".git"))) return;
		const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
		if (current.split("\n").some((l) => l.trim() === `${LOCK_DIR}/` || l.trim() === LOCK_DIR)) return;
		fs.mkdirSync(path.dirname(exclude), { recursive: true });
		fs.appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}${LOCK_DIR}/\n`);
	} catch {
		/* a worktree or an odd .git layout: the lock still works, it just shows up as untracked */
	}
}
