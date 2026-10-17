/**
 * Installed-dependency integrity gate.
 *
 * Two failure modes have already cost this repository real debugging time, and
 * neither is visible to a typecheck or a test run:
 *
 * 1. A stale physical copy shadowing a workspace package. `packages/agent` once
 *    carried its own `node_modules/omk-ai@0.96.2` while the workspace was at
 *    0.97.0. Two copies of one module in a single process defeat every
 *    reference-identity check between them — in that instance an auth gate that
 *    asked `streamFn === streamSimple` silently stopped requiring credentials.
 *    `npm ls` reports this as `ELSPROBLEMS ... invalid`.
 *
 * 2. A dangling `.bin` symlink left behind when such a copy is removed. `npm ls`
 *    stays clean, but any `cp -a`/`cp -aL` over the tree fails on the broken
 *    link — which is how a packaging script running under `set -euo pipefail`
 *    aborted mid-run with no obvious cause.
 *
 * The two checks are independent: the first walks npm's own view of the tree,
 * the second walks the bin directories npm leaves on disk. Both must pass.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "scripts", "dep-tree-baseline.json");

/** Split an override key (`name` or `name@spec`) into its parts. Scoped names keep their leading `@`. */
function splitOverrideKey(key) {
	const at = key.indexOf("@", 1);
	return at === -1 ? { name: key, spec: undefined } : { name: key.slice(0, at), spec: key.slice(at + 1) };
}

/**
 * Whether an override key selects this installed package. Only a bare name or
 * an exact `name@version` counts; ranged selectors are not evaluated here, so
 * they never excuse a problem (the check stays strict rather than guessing).
 */
function overrideKeyMatches(key, name, version) {
	const parsed = splitOverrideKey(key);
	if (parsed.name !== name) return false;
	return parsed.spec === undefined || parsed.spec === version;
}

/**
 * The version a root `overrides` block forces on the package at `path`
 * (dependency names from the root, last entry is the package itself), or
 * undefined when no override applies. Follows npm's nesting: a rule nested
 * under an ancestor applies to that ancestor's subtree, the most deeply nested
 * matching rule wins, and an object's `"."` key overrides the ancestor itself.
 * `$`-references are not resolved and therefore never match.
 */
export function overrideVersionFor(overrides, path, version) {
	if (!overrides || typeof overrides !== "object" || path.length === 0) return undefined;
	const target = path[path.length - 1];
	const scopes = [overrides];
	for (const ancestor of path.slice(0, -1)) {
		const next = [];
		for (const scope of scopes) {
			for (const [key, value] of Object.entries(scope)) {
				if (value && typeof value === "object" && splitOverrideKey(key).name === ancestor) next.push(value);
			}
		}
		scopes.push(...next);
	}
	for (let index = scopes.length - 1; index >= 0; index -= 1) {
		for (const [key, value] of Object.entries(scopes[index])) {
			if (!overrideKeyMatches(key, target, version)) continue;
			const forced = typeof value === "string" ? value : value && typeof value === "object" ? value["."] : undefined;
			if (typeof forced === "string" && !forced.startsWith("$")) return forced;
		}
	}
	return undefined;
}

/**
 * Parse `npm ls --json` output into the problems npm itself reports.
 *
 * When npm's hidden lockfile is stale (a build that links workspace packages, or
 * vitest creating `node_modules/.vite-temp`), some npm versions re-read the tree
 * from disk without applying root `overrides` and flag an overridden package as
 * `invalid` against the range its parent declares. Such a problem is dropped
 * only when the root `package.json` override for that exact dependency path
 * forces precisely the installed version. Every other `invalid` still counts.
 */
export function parseTreeProblems(jsonText, overrides = {}) {
	let tree;
	try {
		tree = JSON.parse(jsonText);
	} catch {
		return ["npm ls did not return parseable JSON"];
	}
	const problems = [];
	const excused = new Set();
	const visit = (node, path) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node.problems)) {
			problems.push(...node.problems);
			if (node.invalid && path.length > 0 && overrideVersionFor(overrides, path, node.version) === node.version) {
				const prefix = `invalid: ${path[path.length - 1]}@${node.version} `;
				for (const problem of node.problems) if (problem.startsWith(prefix)) excused.add(problem);
			}
		}
		for (const [name, child] of Object.entries(node.dependencies ?? {})) visit(child, [...path, name]);
	};
	visit(tree, []);
	return [...new Set(problems)].filter((problem) => !excused.has(problem));
}

/** Root `package.json` overrides, or an empty object. */
export function readRootOverrides(root = repoRoot) {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
	} catch {
		return {};
	}
}

/** Bin directories npm materializes: the root one plus each workspace package's. */
export function binDirectories(root = repoRoot) {
	const candidates = [join(root, "node_modules", ".bin")];
	const packagesDir = join(root, "packages");
	if (existsSync(packagesDir)) {
		for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			candidates.push(join(packagesDir, entry.name, "node_modules", ".bin"));
		}
	}
	return candidates.filter((directory) => existsSync(directory));
}

/**
 * Symlinks in `directory` whose target does not resolve.
 *
 * `existsSync` follows symlinks, so a link that resolves to nothing reads as
 * absent here even though the entry itself is present in the listing.
 */
export function danglingLinks(directory) {
	const broken = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isSymbolicLink()) continue;
		const linkPath = join(directory, entry.name);
		if (existsSync(linkPath)) continue;
		broken.push({ path: linkPath, target: readlinkSync(linkPath) });
	}
	return broken;
}

/** Every dangling bin link across the workspace. */
export function collectDanglingBinLinks(root = repoRoot) {
	return binDirectories(root).flatMap((directory) => danglingLinks(directory));
}

/** Ask npm for its view of the tree. A non-zero exit still carries usable JSON. */
export function readTreeJson(root = repoRoot) {
	try {
		return execFileSync("npm", ["ls", "--all", "--json"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		// npm exits non-zero on ELSPROBLEMS but still prints the tree to stdout.
		if (typeof error?.stdout === "string" && error.stdout.length > 0) return error.stdout;
		throw error;
	}
}

export function readBaseline(path = baselinePath) {
	if (!existsSync(path)) return { problems: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return { problems: Array.isArray(parsed.problems) ? parsed.problems : [] };
	} catch {
		return { problems: [] };
	}
}

/**
 * Compare against the accepted set.
 *
 * Dangling bin links are never baselined: they are always a local install
 * artifact and always removable, so there is no legitimate steady state for
 * them. Tree problems can be pre-existing (a transitive range conflict inside
 * someone else's dependency), so those ratchet like the other gates here —
 * known entries hold, new ones fail, and a shrinking set asks to be tightened.
 */
export function evaluateTree(problems, dangling, baseline) {
	const accepted = new Set(baseline.problems);
	const current = new Set(problems);
	return {
		newProblems: problems.filter((problem) => !accepted.has(problem)),
		resolved: [...accepted].filter((problem) => !current.has(problem)),
		dangling,
	};
}

export function runCli(argv = [], root = repoRoot) {
	const problems = parseTreeProblems(readTreeJson(root), readRootOverrides(root));
	const dangling = collectDanglingBinLinks(root);

	if (argv.includes("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify({ problems: [...problems].sort() }, null, "\t")}\n`);
		console.log(`Dependency-tree baseline written: ${problems.length} accepted problem(s).`);
		return 0;
	}

	const { newProblems, resolved } = evaluateTree(problems, dangling, readBaseline());

	if (dangling.length > 0) {
		console.error(`Dangling bin symlinks (${dangling.length}):`);
		for (const link of dangling) console.error(`  ${link.path} -> ${link.target}`);
		console.error("\nThese break any `cp -a` over node_modules — a packaging script running");
		console.error("under `set -euo pipefail` aborts on them. Remove the link or reinstall.");
	}

	if (newProblems.length > 0) {
		console.error(`${dangling.length > 0 ? "\n" : ""}New dependency-tree problems (${newProblems.length}):`);
		for (const problem of newProblems) console.error(`  ${problem}`);
		console.error("\nA stale physical copy shadowing a workspace package breaks reference identity");
		console.error("between the two copies. Run `npm install` to rebuild the tree.");
	}

	if (dangling.length > 0 || newProblems.length > 0) return 1;

	if (resolved.length > 0) {
		console.log(`Dependency tree OK: ${resolved.length} baselined problem(s) resolved — run with --update to tighten.`);
		return 0;
	}

	console.log(`Dependency tree OK: no dangling bin links, ${problems.length} problem(s) held at baseline.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = runCli(process.argv.slice(2));
}
