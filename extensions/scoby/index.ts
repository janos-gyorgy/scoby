// scoby — one entry point: router + budget-first compaction, sharing state.
// Without a config (see ../router/index.ts for the lookup) it does nothing and pi runs as usual.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, setupRouter } from "../router/index.ts";
import { setupCompaction } from "../compaction/index.ts";
import { setupGuard } from "../guard/index.ts";

export default function scoby(pi: ExtensionAPI) {
	const loaded = loadConfig();
	if (!loaded) return;
	const router = setupRouter(pi, loaded.cfg, loaded.configPath);
	setupCompaction(pi, loaded.cfg, router);
	setupGuard(pi, loaded.cfg);
}
