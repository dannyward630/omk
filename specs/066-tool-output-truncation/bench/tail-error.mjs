// Spec 066 criterion 6 (measured): does an error at the END of a large MCP output survive into what the model sees?
// Shipped head+tail (`capMcpContent`) vs a head-only variant (`truncateHead`, byte prefix when line 1 is too long).
// Run: node specs/066-tool-output-truncation/bench/tail-error.mjs
import { capMcpContent } from "../../../packages/coding-agent/src/core/mcp/output-cap.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "../../../packages/coding-agent/src/core/tools/truncate.ts";

const seen = (text) =>
	capMcpContent([{ type: "text", text }], { sessionFile: undefined, cwd: ".", toolCallId: "t" })
		.filter((b, i) => b.type === "text" && i !== 1)
		.map((b) => b.text)
		.join("\n");
const headOnly = (text) => {
	const r = truncateHead(text);
	return r.firstLineExceedsLimit ? Buffer.from(text).subarray(0, DEFAULT_MAX_BYTES).toString() : r.content;
};
const ERROR = "ERROR: step 42 failed: connection refused (exit 1)";
const log = Array.from({ length: 8000 }, (_, i) => `log ${i} ${"x".repeat(40)}`).join("\n");
const cases = {
	"log 400KB, error last line": `${log}\n${ERROR}`,
	"log 400KB, error + 30-line stack at end": `${log}\n${ERROR}\n${Array.from({ length: 30 }, (_, i) => `    at frame${i} (file.js:${i})`).join("\n")}`,
	"log 400KB, error + 1500 lines of trailing noise": `${log}\n${ERROR}\n${Array.from({ length: 1500 }, (_, i) => `cleanup ${i}`).join("\n")}`,
	"json 400KB single line, error field last": `{"rows":[${Array.from({ length: 9000 }, (_, i) => `{"i":${i},"v":"${"x".repeat(30)}"}`).join(",")}],"error":"${ERROR}"}`,
	"log 400KB, error at first line": `${ERROR}\n${log}`,
	"log 400KB, error in the middle": `${log.slice(0, 200_000)}\n${ERROR}\n${log.slice(200_000)}`,
};
let ht = 0;
let ho = 0;
console.log("| case | head+tail (shipped) keeps error | head-only keeps error | head+tail bytes | head-only bytes |");
console.log("|---|---|---|---|---|");
for (const [name, text] of Object.entries(cases)) {
	const a = seen(text);
	const b = headOnly(text);
	ht += a.includes(ERROR) ? 1 : 0;
	ho += b.includes(ERROR) ? 1 : 0;
	console.log(`| ${name} | ${a.includes(ERROR) ? "yes" : "**no**"} | ${b.includes(ERROR) ? "yes" : "**no**"} | ${Buffer.byteLength(a)} | ${Buffer.byteLength(b)} |`);
}
console.log(`\ndetection rate: head+tail ${ht}/${Object.keys(cases).length}, head-only ${ho}/${Object.keys(cases).length}`);
