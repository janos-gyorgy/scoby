# scoby

A free Kimchi: the shape of a plan-build-judge coding agent, running on free-tier inference
APIs. Built as extensions for [pi](https://github.com/earendil-works/pi), the coding-agent SDK
Kimchi itself is built on.

You define inference connections (Gemini, Groq, NVIDIA NIM, any OpenAI-compatible endpoint),
map roles (planner / builder / judge / compactor) to ordered chains of models, and scoby:

- **fails over** when a free tier says no (429, 5xx, dead key, network), and comes back to the
  preferred model when it recovers;
- keeps **every request under a per-request token budget** (free tiers bind tokens per minute,
  not context windows), by shaping the context before each call instead of summarising the
  session after the fact;
- runs a goal as a **plan you approve**, then phases of steps with gates and an independent judge,
  on a `scoby/<goal>` branch;
- **waits out outages** and resumes the same session, for hours or days if needed;
- tells your phone via **ntfy** when the plan is ready, a phase is graded, or it needs you.

Personal project, blog material. **No maintenance promised.** It works on my machine, on the free
tiers as they were in September 2026; those change weekly.

## Install

Needs Node ≥ 22.19 (pi's requirement) and git.

```
git clone https://github.com/janos-gyorgy/scoby ~/git/scoby
cd ~/git/scoby && npm install
mkdir -p ~/.config/scoby
cp scoby.example.json ~/.config/scoby/config.json     # then edit: your connections, your roles
ln -s ~/git/scoby/bin/scoby ~/.local/bin/scoby         # and bin/scoby-run
```

Keys are read from the environment: `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY` (or whatever
`apiKeyEnv` names), `NTFY_TOKEN`. `bin/scoby` also sources `~/.config/scoby/env` if it exists
(`KEY=value` lines, keep it mode 600).

## Using it

```
cd ~/git/some-repo
scoby
```

1. Type what you want built. scoby asks once: **Plan & build** or **Just answer** (chat stays chat).
2. A plan appears above the editor: **Approve**, **Change…** (one sentence → a revised plan), or **Cancel**.
   This checkpoint is the most valuable part. Both my real builds had a plan step that was wrong
   (a CSS animation for a canvas-drawn label); the judge caught what the plan missed once, a human
   catches it before any code exists.
3. It builds on a new `scoby/<goal>` branch, one step at a time. Between phases: your gate commands
   (typecheck, build, tests) must show no *new* errors, then an independent judge grades the diff
   A–F; D or F buys one fix step.
4. If every model is down, it waits inside pi and carries on by itself when one answers.
5. Your phone (ntfy): plan ready, phase grades, "needs you", long waits, finished.

`/ferment` shows the plan and where the build is. `/role`, `/router` show and switch models.

**Unattended** (no terminal, plan accepted as is):

```
cd ~/git/some-repo
scoby-run "add ntfy notifications when a run ends"   # start; waits out outages, resumes, until done
scoby-run                                           # resume the build this repo's lock names
scoby-run --session ~/.pi/agent/sessions/.../x.jsonl # resume one you started in the TUI
```

**One build per repo.** A build in progress leaves `.scoby/lock.json` in the repo (kept out of git
via `.git/info/exclude`). A second scoby in the same repo refuses to plan and prints the resume
command, the worktree alternative, and `/ferment unlock`. The lock survives a dropped SSH session
on purpose: an interrupted build is still a build.

## Config

`~/.config/scoby/config.json` is the base; a `.scoby.json` in the repo lays over it (top-level keys
replace; `compaction`, `ferment`, `finish`, `notify`, `failover`, `policy` merge one level deep), so
a repo can carry just its gates:

```json
{ "finish": { "gates": ["npx tsc --noEmit", "npx vite build --outDir /tmp/scoby-dist"] } }
```

`SCOBY_CONFIG=<file>` replaces both (bench and tests use it). See `scoby.example.json`.

| Key | What |
|---|---|
| `connections.<name>` | `{"provider": "google"}` (a pi built-in, key from its usual env var) **or** `{"baseUrl", "apiKeyEnv", "models": [{id, contextWindow, maxTokens, reasoning}]}`; optional `maxRequestTokens` = this connection's per-request budget |
| `roles.<role>` | ordered targets `connection/model-id[:thinking]`; first healthy serves, the rest fail over. Roles used: `builder` (the session), `planner`, `judge`, `compactor` |
| `defaultRole` | which role the session starts on (`builder`) |
| `compaction` | `defaultBudget` (input tokens per request when the connection sets none; else half the model's window), `recentShare` (0.5), `fold` (true), `foldGateShare` (0.25), `cancelNativeCompaction` (true) |
| `ferment` | `enabled`, `gates` (default: `finish.gates`), `branch` (true), `waitIntervalSeconds` (600), `waitNotifyAfterSeconds` (1800) |
| `finish` | `gates` (commands, no shell), `requireChanges`, `maxNudges` — the finish guard when ferment is off |
| `failover` | `cooldownSeconds` (60), `authCooldownSeconds` (1800) |
| `notify` | `url`, `topic`, `tokenEnv` (`NTFY_TOKEN`) |
| `policy.repoContentLeavesMachine` | must be `true`: an acknowledgement that the repo goes to third-party APIs |

## How it works

**Router** (`extensions/router`). pi retries a failed turn itself (2s/4s/8s). When an assistant
message ends in a retryable error, the router cools the target down and switches the session
model *before* that retry, so the retry lands on the next target; on the next turn it moves back to
the role's preferred model if it is healthy again. Gemini 3 rejects unsigned tool calls in the
history after a hand-off from another model, so the router patches Google's placeholder
signature on the wire.

| Error | Failover? |
|---|---|
| 429, "rate limit", "quota", RESOURCE_EXHAUSTED | yes, cooldown |
| 5xx, "high demand", UNAVAILABLE, provider crash text | yes, cooldown |
| 401 / 402 / 403, payment required | yes, long cooldown |
| network errors | yes |
| 400 and other explicit 4xx | **no**: usually a config bug (e.g. a thinking level the model rejects); hiding it would be worse |

**Budget-first compaction** (`extensions/compaction`). Before every request the shaper fits the
messages under `0.95 × budget / scale − fixed overhead`, in this order, stopping as soon as it fits:
fold blocks replace what they cover → duplicate file reads drop → old tool output becomes a stub
with a `recall` ref → old assistant prose trims → oldest units drop. The first user message, the last
user message and a recent zone (`recentShare`) are never touched; tool calls are never edited.
`scale` is real input tokens ÷ our estimate, a moving average **per model** (three NIM models
under one scale let 17 requests through over budget). Between turns, under pressure, a fold
summarises old content once (never re-summarised, the billion-context-pi doctrine: keep paths,
signatures, exact errors, decisions with rationale; drop logs once used and dead ends). pi's own
threshold compaction is cancelled. Every request writes a `scoby-budget` entry to the session with
the estimate, the real usage and what was elided.

**Ferment** (`extensions/ferment`). A pure state machine (`core.ts`, tested without pi): plan →
phases → steps → gate → judge → next phase → complete. The model only ever sees the current step's
brief, appended to the context of every request. A step restarted three times is stuck; gates red
three times in a phase end the run; a poor grade buys one fix round. Planner and judge calls walk
the role's chain with backoff; an unparseable reply is re-asked with a JSON-only reminder; a
malformed plan is re-asked, never crashed on. Everything is `scoby-ferment` entries in the session
file, which is why a run resumes from any interruption.

**Notify** (`extensions/notify`): ntfy JSON publish with a bearer token.

## What it built

Both on NVIDIA NIM's free tier, DeepSeek V4 Flash as builder, Gemini 3.5 Flash (free) as planner and judge, 32K input budget.

| Build | Time | Requests | Grades | Notes |
|---|---|---|---|---|
| crowded (a private canvas site): make the Bash star magenta with a subtle pulse (canvas app) | 31 min | 31, 0 errors | D → fix → A, A, A | plan approved in the TUI; judge caught that only the label was coloured, not the star; the fix step fixed it |
| [corvid](https://github.com/janos-gyorgy/corvid): ntfy push when a bird run ends, in the chassis + rookery | 113 min | 70, 0 errors, max 30.4K of 32K | A, A, A | unattended via `scoby-run`; judge and gates missed that JSON posted to a topic URL arrives as plain text — a test against the real server found it; a second `scoby-run` with that finding as the goal fixed it (50 min, 43 requests, A, A, A), verified on the phone |

Bench (`bench/`), the Kimchi trial task on a Brew Buddy clone, 11 steps: budgets held (max 15.7K of
16K, 30.4K of 32K); the patient run survived 7 provider outages over 8 invocations and finished
11/11 steps; the internal judge graded it A while an external judge gave C — a judge anchored to
the plan inherits the plan's blind spots, which is why the human plan checkpoint exists.

## Known limits

- **Not a sandbox.** See the threat model below.
- Free tiers are non-stationary: Groq free is 8K tokens/min on every coding model (one-shot judge
  only), Gemini free is ~20 requests/day, NIM capacity comes and goes by the hour, NIM gpt-oss-20b
  emits garbled tool names. Chains and budgets are per connection for that reason.
- Print mode (`scoby-run`) accepts the plan as is. The approval loop is interactive only.
- Cooldowns live in memory, per pi process.
- pi's `after_provider_response` hook does not fire on a 429; detection uses `message_end`.
- pi is pinned exactly (`0.85.1`): an extension runs with full Node privileges, and pi's extension
  API moves daily. Upgrade deliberately, run `npm run test:all` after.
- `pi -p` reads piped stdin: scripts close it (`< /dev/null`).

## Tests

```
npm test                 # pure cores: router, shaper, fold, gates, ferment engine, lock, ntfy
npm run test:all         # + e2e through pi against mock providers: failover, resume, compaction
                         #   (3 budgets), finish guard, ferment, plan failover, patient resume,
                         #   repo lock, and a scripted human over pi's RPC mode (plan, change, approve,
                         #   outage, resume, chat)
```

## Threat model (read before pointing this at anything you care about)

scoby runs pi, and pi's `bash` tool runs real commands **as you**. The bench scripts set a temporary
`HOME` and unset `KUBECONFIG`, which hides default credential paths; **it is not a sandbox**: the
process is your user, so absolute paths (`/home/you/.kube/config`, `~/.ssh/*`) are still readable.

- **Provider keys live in the agent's environment.** Any command the model runs can read them. Treat
  keys used with scoby as disposable and rotate them after unattended runs.
- **Repo content leaves the machine.** Files, diffs and tool output go to whichever third-party APIs
  you configure; free tiers may use that data to improve their products. scoby refuses to start
  unless the config says `{"policy":{"repoContentLeavesMachine":true}}`: an acknowledgement, not a
  protection. Use it on repos you would be willing to publish.
- **Repo content is untrusted input.** File contents, tool output and model-written fold summaries
  re-enter the context. scoby labels those blocks as data and tells the model not to follow
  instructions found inside them; prompts are a mitigation, not a guarantee.
- **Gates are commands you configure**, run as you, in the repo the model just edited.

Real containment (a container with only the repo mounted, no host home, keys scoped to it) is not
built. Until then: throwaway clone or worktree, review the diff before it goes anywhere.

## Layout

```
extensions/scoby      entry: composes router + ferment + compaction (+ finish guard when ferment is off)
extensions/router     connections, roles, failover, recovery, Gemini signature patch
extensions/compaction shaper (pure), fold (pure), pi glue, recall tool
extensions/ferment    engine (pure), lock (pure), pi glue: plan approval, steps, gates, judge, waiting
extensions/guard      gate parsing + finish guard
extensions/notify     ntfy
bin/                  scoby (pi + extension), scoby-run (unattended)
bench/                the Kimchi-trial benchmark: fresh clone, budget sweep, patient supervisor, judge
test/                 e2e suites against mock providers
```

MIT.
