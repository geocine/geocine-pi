// Smoke test for the web provider registry behind web_fetch / web_search.
// Run: node --experimental-strip-types scripts/smoke-web.mjs
// builtin is tested live (network); tinyfish runs live only when a key is
// present, otherwise its selection/error paths are exercised.
import { registerWebTools } from "../extensions/models/web.ts";
import { PROVIDERS, resolveWebProvider } from "../lib/web-providers/index.ts";
import { tinyFishApiKey } from "../lib/web-providers/tinyfish.ts";

const tools = {};
registerWebTools({ registerTool: (t) => (tools[t.name] = t) });
if (!tools.web_fetch || !tools.web_search) throw new Error("web tools did not register");

console.log("providers:", PROVIDERS.map((p) => `${p.id}(available=${p.available()})`).join(", "));
console.log("auto resolves to:", resolveWebProvider(undefined).id);
console.log("auto with empty cfg:", resolveWebProvider({}).id);
try {
	resolveWebProvider({ provider: "nope" });
	console.log("FAIL: unknown provider accepted");
} catch (e) {
	console.log("unknown provider rejected:", e.message);
}
if (!tinyFishApiKey()) {
	try {
		resolveWebProvider({ provider: "tinyfish" });
		console.log("FAIL: unavailable pin accepted");
	} catch (e) {
		console.log("pinned-but-keyless rejected:", e.message);
	}
}

async function run(tool, label, params) {
	console.log(`\n===== ${label} =====`);
	try {
		const result = await tools[tool].execute("smoke", params, undefined, undefined, { cwd: process.cwd() });
		const text = result.content[0].text;
		console.log(text.length > 700 ? `${text.slice(0, 700)}…` : text);
		console.log("details:", JSON.stringify(result.details).slice(0, 300));
	} catch (error) {
		console.log("ERROR:", error.message);
	}
}

await run("web_search", "search (live)", { query: "llama.cpp context checkpoints" });
await run("web_search", "search with domain filter (live)", { query: "napi-rs", allowed_domains: ["github.com"] });
await run("web_fetch", "fetch (live)", { url: "https://example.com", prompt: "what is this page for" });
if (tinyFishApiKey()) {
	console.log("\nTINYFISH KEY PRESENT — the calls above used tinyfish");
} else {
	console.log("\nno TinyFish key — the calls above used builtin");
}
