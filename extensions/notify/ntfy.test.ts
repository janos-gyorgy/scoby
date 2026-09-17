import { test } from "node:test";
import assert from "node:assert/strict";
import { ntfyRequest } from "./ntfy.ts";

test("ntfy request: JSON to the server root, bearer token, numeric priority", () => {
	const { url, init } = ntfyRequest({ url: "https://ntfy.hippotion.com/", topic: "scoby" },
		{ title: "Plan ready — waiting for you", message: "3 phases", priority: "high", tags: ["memo"] }, "tok");
	assert.equal(url, "https://ntfy.hippotion.com");
	assert.equal((init.headers as any).Authorization, "Bearer tok");
	const body = JSON.parse(init.body as string);
	assert.deepEqual(body, { topic: "scoby", title: "Plan ready — waiting for you", message: "3 phases", priority: 4, tags: ["memo"] });
});
