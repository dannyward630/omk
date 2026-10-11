import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Spec 055: moving the ignore-file helpers out of package-manager.ts into core/ignore-rules.ts
// must not add modules to the skill startup path (6 bundled skills, `omk -p` workers). The only new
// file on that path is ignore-rules.ts itself; everything it imports must already be imported by
// package-manager.ts, and its `ignore` import is type-only, so the package is not evaluated by it.
const loads = vi.hoisted(() => ({ ignore: 0 }));

vi.mock("ignore", async (importOriginal) => {
	loads.ignore++;
	return importOriginal();
});

const srcCore = new URL("../../src/core/", import.meta.url);

/** Module specifiers a file imports at runtime (`import type` lines are erased and skipped). */
function valueImports(file: string): string[] {
	const source = readFileSync(new URL(file, srcCore), "utf8");
	const specifiers: string[] = [];
	for (const match of source.matchAll(/^import\s+(type\s+)?[\s\S]*?\sfrom\s+"([^"]+)";/gm)) {
		if (!match[1]) specifiers.push(match[2] ?? "");
	}
	return specifiers;
}

describe("spec 055: skill startup module set", () => {
	it("ignore-rules.ts imports only modules package-manager.ts already imports", () => {
		const ignoreRules = valueImports("ignore-rules.ts");
		const packageManager = new Set(valueImports("package-manager.ts"));

		expect(ignoreRules.sort()).toEqual(["node:fs", "node:path"]);
		for (const specifier of ignoreRules) expect(packageManager.has(specifier), specifier).toBe(true);
		expect(packageManager.has("./ignore-rules.ts")).toBe(true);
		// No local imports, so ignore-rules.ts brings no transitive project modules with it.
		expect(ignoreRules.filter((specifier) => specifier.startsWith("."))).toEqual([]);
	});

	it("loading ignore-rules.ts does not evaluate the ignore package; package-manager.ts evaluates it once", async () => {
		await import("../../src/core/ignore-rules.ts");
		expect(loads.ignore).toBe(0);
		await import("../../src/core/package-manager.ts");
		expect(loads.ignore).toBe(1);
	});
});
