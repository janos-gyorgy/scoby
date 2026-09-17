# scoby

A free Kimchi, as [pi](https://github.com/earendil-works/pi) extensions: define as many
inference connections as you like, map roles to ordered chains of models, and let the
session fail over when a free tier says no. Next up: budget-first compaction, so each
request fits the limits free tiers actually allow.

Personal project / blog material. **No maintenance promised.**

## Using it

```
cd ~/git/some-repo
scoby                      # = pi + the scoby extension, keys pulled from the cluster
```

1. Type what you want built. scoby asks once: **Plan & build** or **Just answer** (chat stays chat).
2. You get a plan above the editor: **Approve**, **Change…** (one sentence → a revised plan), or **Cancel**.
3. It builds on a new `scoby/<goal>` branch, one step at a time, with gates and an independent judge
   between phases. Progress sits above the editor; `/ferment` shows it too.
4. If every model is down, it waits inside pi and carries on by itself when one answers.
5. Your phone (ntfy topic `scoby`): plan ready, phase grades, "needs you", long waits, finished.

Config: `./.scoby.json` in the repo, else `~/.config/scoby/config.json` (see `scoby.example.json`).
Unattended runs without a terminal: `bench/patient.sh <label> <budget>` (waits out outages for days).

## Router

```
pi -e ./extensions/router/index.ts            # uses .scoby.json, $SCOBY_CONFIG, or ~/.config/scoby/config.json
pi -e ./extensions/router/index.ts --role planner
```

Config (see `scoby.example.json`):

- **connections**: either a pi built-in provider (`{"provider": "groq"}`; key from pi's usual
  env var, e.g. `GROQ_API_KEY`, `GEMINI_API_KEY`) or a custom OpenAI-compatible endpoint
  (`baseUrl`, `apiKeyEnv`, `models`).
- **roles**: ordered targets `connection/model-id[:thinking]`. The first healthy one serves;
  the rest are the failover chain.
- **failover**: `cooldownSeconds` after a rate limit/overload (default 60),
  `authCooldownSeconds` after a missing key / 401 / 402 / 403 (default 1800).

In the TUI: `/role [name]` shows or switches the role, `/router` shows each target and its
cooldown. Every decision is saved in the session as a `scoby-router` custom entry, with a reason.

### How failover works

pi already retries a failed turn (agent-level retry, backoff 2s/4s/8s). When an assistant
message ends in a retryable error, the router puts the failed target on cooldown and switches
the session model *before* that retry starts, so the retry lands on the next target.

| Error | Failover? |
|---|---|
| 429, "rate limit", "quota", RESOURCE_EXHAUSTED | yes, cooldown |
| 5xx, "high demand", UNAVAILABLE | yes, cooldown |
| 401 / 402 / 403, payment required | yes, long cooldown |
| network errors | yes |
| 400 and anything else | **no**, a 400 is usually a config bug (e.g. an unsupported thinking level); hiding it would be worse |

## Known limits (found while building)

- **Retry budget**: failover rides on pi's `retry.maxRetries` (default 3), so one turn can walk
  at most 4 targets. Raise it in `~/.pi/agent/settings.json` for longer chains.
- **Cooldowns live in memory**, per pi process, not shared across sessions.
- pi's `after_provider_response` hook **does not fire on a 429**, so detection uses
  `message_end` (`stopReason: "error"`) instead.
- A model switch **carries the previous thinking level** unless you set one: a non-reasoning
  model's level reached Gemini 3.8 Flash as MINIMAL and got a 400. The router always sets it:
  an explicit `:level`, else `low` for reasoning models and `off` for others.
- pi's model catalog knows context windows, not free-tier limits (Groq gpt-oss-120b: 131K
  window, but 8K tokens/minute free). That is what compaction has to solve.
- `pi -p` reads piped stdin: close it (`< /dev/null`) in scripts.

## Tests

```
npm test               # router core: parsing, validation, error classification, chain walking
npm run test:router    # e2e through the real extension: mock 429 -> 503 -> good, must PASS
npm run test:failover  # the original probe that proved message_end + setModel works
```

Needs Node >= 22.19.

## Threat model (read before pointing this at anything you care about)

scoby runs pi, and pi's `bash` tool runs real commands **as you**. The bench scripts set a temporary
`HOME` and unset `KUBECONFIG`, which hides default credential paths — **it is not a sandbox**: the
process is your user, so absolute paths (`/home/you/.kube/config`, `~/.ssh/*`) are still readable.

What that means in practice:

- **Provider keys live in the agent's environment.** Any command the model runs can read them. Treat
  keys used with scoby as disposable and rotate them after unattended runs.
- **Repo content leaves the machine.** Files, diffs and tool output go to whichever third-party APIs
  you configure; free tiers may use that data to improve their products. Scoby refuses to start
  unless the config says `{"policy":{"repoContentLeavesMachine":true}}` — that is an
  acknowledgement, not a protection.
- **Repo content is untrusted input.** File contents, tool output and model-written fold summaries
  re-enter the context. Scoby labels those blocks as data and tells the model not to follow
  instructions found inside them; prompts are a mitigation, not a guarantee.
- **pi is pinned exactly** (`0.85.1`) because an extension runs with full Node privileges; upgrade
  deliberately.

**Real containment** — a container with only the repo mounted, no host home, keys scoped to that
container — is not built yet. Until then, run scoby on repos you would be willing to publish, on a
throwaway clone or worktree, and review the diff before it goes anywhere.
