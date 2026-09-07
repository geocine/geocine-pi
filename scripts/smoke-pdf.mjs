// One-shot smoke test for extensions/pdf-reader.ts (not part of the plugin).
// Run: node --experimental-strip-types scripts/smoke-pdf.mjs <pdf...>
import pdfReader from "../extensions/pdf-reader.ts";

const tools = {};
pdfReader({ registerTool: (t) => (tools[t.name] = t) });
const tool = tools.read_pdf;
if (!tool) throw new Error("read_pdf did not register");
const ctx = { cwd: process.cwd() };

async function run(label, params) {
	console.log(`\n===== ${label} =====`);
	try {
		const result = await tool.execute("smoke", params, undefined, undefined, ctx);
		console.log(result.content[0].text);
		console.log("details:", JSON.stringify(result.details));
	} catch (error) {
		console.log("ERROR:", error.message);
	}
}

const fixtures = "D:/PL/pdf-inspector/tests/fixtures";
await run("text PDF, full read", { path: `${fixtures}/author_block_superscripts.pdf` });
await run("scanned PDF with native header", { path: `${fixtures}/scan_with_native_header_text.pdf` });
await run("page range", { path: `${fixtures}/hebrew_logical_order.pdf`, pages: "1" });
await run("bad page range", { path: `${fixtures}/hebrew_logical_order.pdf`, pages: "5-2" });
await run("out-of-range pages", { path: `${fixtures}/hebrew_logical_order.pdf`, pages: "99" });
await run("search hit", { path: `${fixtures}/author_block_superscripts.pdf`, search: "university|abstract|the" });
await run("search miss", { path: `${fixtures}/author_block_superscripts.pdf`, search: "zzz_nothing_zzz" });
await run("not a pdf", { path: "package.json" });
await run("missing file", { path: "no-such-file.pdf" });
