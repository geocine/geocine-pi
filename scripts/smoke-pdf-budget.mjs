// Budget/omission smoke for pdf-reader: 3-page generated PDF + project
// config with a tiny pdf.maxChars. Run from scripts/smoke-pdf-budget.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pdfReader from "../extensions/pdf-reader.ts";

// --- build a minimal 3-page PDF with correct xref offsets ---
function buildPdf(pageTexts) {
	const objects = [];
	const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
	objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
	objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`);
	pageTexts.forEach((text, i) => {
		const pageNum = 3 + i * 2;
		const contentNum = pageNum + 1;
		objects.push(
			`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${3 + pageTexts.length * 2} 0 R >> >> >>\nendobj\n`,
		);
		const lines = text.map((t, j) => `BT /F1 12 Tf 72 ${700 - j * 20} Td (${t}) Tj ET`).join("\n");
		objects.push(`${contentNum} 0 obj\n<< /Length ${lines.length} >>\nstream\n${lines}\nendstream\nendobj\n`);
	});
	objects.push(`${3 + pageTexts.length * 2} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
	let pdf = "%PDF-1.4\n";
	const offsets = [];
	for (const obj of objects) {
		offsets.push(pdf.length);
		pdf += obj;
	}
	const xrefStart = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geocine-pdf-smoke-"));
// Varied natural sentences: repetitive synthetic lines trip pdf-inspector's
// (correct) garbled-text-layer heuristic and get flagged needsOcr.
const sentences = [
	"The quick brown fox jumps over the lazy dog near the river bank.",
	"Quarterly revenue grew by twelve percent compared with the prior year.",
	"Engineers reviewed the design and approved the updated schematic today.",
	"A gentle rain fell over the valley as the survey team packed their gear.",
	"The committee will reconvene next Thursday to finalize the budget draft.",
	"Local farmers reported an early harvest thanks to the warm spring weather.",
	"New safety protocols reduced incident rates across all three facilities.",
	"The museum unveiled a restored mural dating back to the early century.",
];
const pages = [sentences, sentences.map((s) => `Second page: ${s}`), sentences.map((s) => `Third page: ${s}`)];
fs.writeFileSync(path.join(dir, "three-pages.pdf"), buildPdf(pages));
fs.mkdirSync(path.join(dir, ".pi"));
fs.writeFileSync(path.join(dir, ".pi", "geocine.json"), JSON.stringify({ pdf: { maxChars: 600, maxSearchMatches: 3 } }));

const tools = {};
pdfReader({ registerTool: (t) => (tools[t.name] = t) });
const ctx = { cwd: dir };

async function run(label, params) {
	console.log(`\n===== ${label} =====`);
	try {
		const result = await tools.read_pdf.execute("smoke", params, undefined, undefined, ctx);
		console.log(result.content[0].text);
		console.log("details:", JSON.stringify(result.details));
	} catch (error) {
		console.log("ERROR:", error.message);
	}
}

await run("full read under tiny budget (expect omitted pages)", { path: "three-pages.pdf" });
await run("follow-up read of omitted pages", { path: "three-pages.pdf", pages: "2-3" });
await run("range to end", { path: "three-pages.pdf", pages: "2-" });
await run("search capped at 3 matches", { path: "three-pages.pdf", search: "line \\d" });
await run("search scoped to pages", { path: "three-pages.pdf", pages: "3", search: "budget" });

fs.rmSync(dir, { recursive: true, force: true });
