// Push notifications through ntfy (homelab: https://ntfy.hippotion.com, token auth, topic "scoby").
// JSON publishing to the server root, so titles with non-ASCII text don't need header encoding.
// Fire-and-forget: a notification that can't be sent is recorded and never blocks the run.

export interface NotifyConfig {
	/** base URL, e.g. https://ntfy.hippotion.com */
	url?: string;
	topic?: string;
	/** env var holding the publish token (default NTFY_TOKEN) */
	tokenEnv?: string;
}

export type Priority = "min" | "low" | "default" | "high" | "urgent";
const PRIORITY: Record<Priority, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

export interface Notification {
	title: string;
	message: string;
	priority?: Priority;
	tags?: string[];
}

export function ntfyRequest(cfg: NotifyConfig, n: Notification, token: string | undefined) {
	return {
		url: cfg.url!.replace(/\/+$/, ""),
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({
				topic: cfg.topic ?? "scoby",
				title: n.title.slice(0, 200),
				message: n.message.slice(0, 3500),
				priority: PRIORITY[n.priority ?? "default"],
				tags: n.tags ?? [],
			}),
		},
	};
}

export function makeNotifier(cfg: NotifyConfig | undefined, onError: (e: string) => void) {
	if (!cfg?.url) return async (_n: Notification) => {};
	const token = process.env[cfg.tokenEnv ?? "NTFY_TOKEN"];
	return async (n: Notification) => {
		const { url, init } = ntfyRequest(cfg, n, token);
		try {
			const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
			if (!res.ok) onError(`ntfy ${res.status}: ${(await res.text()).slice(0, 120)}`);
		} catch (e) {
			onError(`ntfy: ${String(e).slice(0, 120)}`);
		}
	};
}
