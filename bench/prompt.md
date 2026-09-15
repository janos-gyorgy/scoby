- Work ONLY on the current branch. Never commit, never push.
- Do NOT read or modify .env files or anything under helm/. No new secrets or env vars unless strictly needed; if needed, .env.example only.
- No new runtime dependencies unless you state why an existing one can't do it.
- Nobody can answer questions during this run: when something is ambiguous, state your assumption briefly and continue.
- When done: run `npx tsc --noEmit -p tsconfig.app.json`, `npx tsc --noEmit -p server/tsconfig.json` and `npx vite build`, fix what they surface (the frontend typecheck already has one known error in src/components/ui/use-toast.ts — leave that one), then summarize the diff. Do not start dev servers.

## The feature

To brew kombucha you need a healthy amount of starter liquid ready. Starter is
made via the standard process — an F1 brewed with the dedicated starter recipe,
seeded from existing starter liquid — then stored in the fridge. So making more
takes a full F1 cycle.

Build a feature that tracks how much starter I have, plans brewing more when
stock runs low, and notifies me in time.
