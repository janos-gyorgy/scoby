// scoby — one entry point: router + budget-first compaction, sharing state.
// Without a config (see ../router/index.ts for the lookup) it does nothing and pi runs as usual.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, setupRouter } from "../router/index.ts";
import { setupCompaction } from "../compaction/index.ts";
import { setupGuard } from "../guard/index.ts";
import { setupFerment } from "../ferment/index.ts";
import { setupUi } from "../ui/index.ts";

export default function scoby(pi: ExtensionAPI) {
	const loaded = loadConfig();
	if (!loaded) return;
	const router = setupRouter(pi, loaded.cfg, loaded.configPath);
	// ferment first: it appends the step brief in a `context` hook, and compaction's hook (registered
	// after it) must see that brief so it counts against the budget. The other way round, the brief
	// rode on top of an already-fitted request — 8 requests went over budget in ferment-32k-r4.
	if (loaded.cfg.ferment?.enabled) setupFerment(pi, loaded.cfg, router);
	const compaction = setupCompaction(pi, loaded.cfg, router);
	// ferment owns the gates when it runs; the finish guard is the single-shot equivalent
	if (!loaded.cfg.ferment?.enabled) setupGuard(pi, loaded.cfg);
	// last: the UI reads the entries the modules above append
	setupUi(pi, loaded.cfg, router, compaction);
}
