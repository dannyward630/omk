import { describe, expect, it } from "vitest";
import {
	createWorkerExtensionPlanner,
	createWorkerExtensionWarningState,
	readLoadedExtensions,
	resolveWorkerProvider,
	type WorkerLoadedExtension,
	workerExtensionArgs,
} from "./worker-extensions.ts";

const PREFIX = "omk subagent: OMK_WORKER_EXTENSIONS";

function ext(
	name: string,
	resolvedPath: string,
	overrides: Partial<WorkerLoadedExtension> = {},
): WorkerLoadedExtension {
	return {
		name,
		path: resolvedPath,
		resolvedPath,
		source: "local",
		scope: "user",
		origin: "top-level",
		providers: [],
		hooks: [],
		...overrides,
	};
}

const a = ext("a", "/home/u/.omk/agent/extensions/a.ts");
const b = ext("b", "/home/u/.omk/agent/extensions/b.ts");
const pkg = ext("@s/a", "/home/u/.omk/agent/npm/node_modules/@s/a/dist/index.js", {
	source: "npm:@s/a@1",
	origin: "package",
});
const dirIndex = ext("my-mcp-adapter", "/home/u/.omk/agent/extensions/my-mcp-adapter/index.ts");

function run(value: string | undefined, loaded: readonly WorkerLoadedExtension[] | null, workerProvider?: string) {
	const env: NodeJS.ProcessEnv = value === undefined ? {} : { OMK_WORKER_EXTENSIONS: value };
	return workerExtensionArgs({ env, loaded, workerProvider });
}

describe("workerExtensionArgs (spec 057)", () => {
	it("1. default: --no-extensions and no -e", () => {
		expect(run(undefined, [a, b])).toEqual({ args: ["--no-extensions"], warnings: [] });
		expect(run("  ", [a, b])).toEqual({ args: ["--no-extensions"], warnings: [] });
	});

	it("2. named opt-in forwards the absolute path; package and index.ts dir names resolve", () => {
		expect(run("a", [a, b])).toEqual({ args: ["--no-extensions", "-e", a.resolvedPath], warnings: [] });
		expect(run("@s/a", [a, pkg]).args).toEqual(["--no-extensions", "-e", pkg.resolvedPath]);
		expect(run("my-mcp-adapter", [a, dirIndex]).args).toEqual(["--no-extensions", "-e", dirIndex.resolvedPath]);
	});

	it("3. all: no --no-extensions, no -e", () => {
		expect(run("all", [a, b], "p")).toEqual({ args: [], warnings: [] });
		expect(run(" ALL ", [a])).toEqual({ args: [], warnings: [] });
	});

	it("4. the parent's own -e extension is not forwarded unless named or a provider owner", () => {
		const cli = ext("cli-ext", "/work/cli-ext.ts", { source: "cli", scope: "temporary" });
		expect(run(undefined, [a, cli]).args).toEqual(["--no-extensions"]);
		expect(run("a", [a, cli]).args).toEqual(["--no-extensions", "-e", a.resolvedPath]);
	});

	it("5. auto-forwards only the worker provider's owner, once", () => {
		const x = ext("x", "/ext/x.ts", { providers: ["p"] });
		expect(run(undefined, [a, x, b], "p")).toEqual({ args: ["--no-extensions", "-e", x.resolvedPath], warnings: [] });
		expect(run(undefined, [a, x, b], "openai").args).toEqual(["--no-extensions"]);
		expect(run(undefined, [a, x, b], undefined).args).toEqual(["--no-extensions"]);
		expect(run("x", [a, x, b], "p").args).toEqual(["--no-extensions", "-e", x.resolvedPath]);
		expect(run("a,x", [a, x, b], "p").args).toEqual(["--no-extensions", "-e", a.resolvedPath, "-e", x.resolvedPath]);
	});

	it("5b. a built-in provider override (baseUrl/headers only) is forwarded for that provider", () => {
		const proxy = ext("proxy", "/ext/proxy.ts", { providers: ["anthropic"] });
		const other = ext("other", "/ext/other.ts");
		const provider = resolveWorkerProvider("anthropic/claude-sonnet-4-5", undefined);
		expect(provider).toBe("anthropic");
		expect(run(undefined, [proxy, other], provider).args).toEqual(["--no-extensions", "-e", proxy.resolvedPath]);
	});

	it("6. package sources are never forwarded and warn once each; a Windows path is not a scheme", () => {
		const npmNamed = ext("npm:a", "/ext/odd.ts");
		const result = run("npm:a,git:github.com/o/a,https://example.com/a.git", [a, npmNamed]);
		expect(result.args).toEqual(["--no-extensions"]);
		expect(result.warnings).toHaveLength(3);
		for (const [index, entry] of ["npm:a", "git:github.com/o/a", "https://example.com/a.git"].entries()) {
			expect(result.warnings[index]).toContain(`"${entry}" is a package source`);
			expect(result.warnings[index]?.startsWith(PREFIX)).toBe(true);
		}

		const windows = ext("a", "C:\\x\\a.ts");
		expect(run("C:\\x\\a.ts", [windows])).toEqual({ args: ["--no-extensions", "-e", "C:\\x\\a.ts"], warnings: [] });
		expect(run("C:/x/other.ts", [windows]).warnings[0]).toContain("does not match any extension");
	});

	it("7. a name shared by two extensions forwards none; an absolute path picks one", () => {
		const a2 = ext("a", "/project/.omk/extensions/a.ts", { scope: "project" });
		const collided = run("a", [a, a2]);
		expect(collided.args).toEqual(["--no-extensions"]);
		expect(collided.warnings).toHaveLength(1);
		expect(collided.warnings[0]).toContain(a.resolvedPath);
		expect(collided.warnings[0]).toContain(a2.resolvedPath);
		expect(collided.warnings[0]).toContain("absolute path");
		expect(run(a2.resolvedPath, [a, a2])).toEqual({ args: ["--no-extensions", "-e", a2.resolvedPath], warnings: [] });
	});

	it("8. unknown names warn once; duplicates and whitespace are handled", () => {
		const unknown = run("nope", [a]);
		expect(unknown.args).toEqual(["--no-extensions"]);
		expect(unknown.warnings).toEqual([
			`${PREFIX}: "nope" does not match any extension loaded in this session; nothing forwarded`,
		]);
		const messy = run(" a , ,a,, nope ,nope", [a]);
		expect(messy.args).toEqual(["--no-extensions", "-e", a.resolvedPath]);
		expect(messy.warnings).toHaveLength(1);
	});

	it("9. a host without the internal accessor: empty list, default and all still apply, names warn once", () => {
		expect(readLoadedExtensions({ registerTool() {} })).toEqual([]);
		expect(readLoadedExtensions({ [Symbol.for("omk.internal.loadedExtensions")]: () => [a] })).toEqual([a]);
		expect(run(undefined, null)).toEqual({ args: ["--no-extensions"], warnings: [] });
		expect(run("all", null)).toEqual({ args: [], warnings: [] });
		const named = run("a,b", null, "p");
		expect(named.args).toEqual(["--no-extensions"]);
		expect(named.warnings).toHaveLength(1);
		expect(named.warnings[0]).toContain("a, b");

		const warnings: string[] = [];
		const planner = createWorkerExtensionPlanner(
			{},
			{
				env: { OMK_WORKER_EXTENSIONS: "a" },
				warn: (m) => warnings.push(m),
				state: createWorkerExtensionWarningState(),
			},
		);
		expect(planner.argsFor("p/m", undefined)).toEqual(["--no-extensions"]);
		expect(planner.argsFor("p/m", undefined)).toEqual(["--no-extensions"]);
		expect(warnings).toHaveLength(1);
	});

	it("10. warns once, on the first spawn, about a request-hook extension left behind", () => {
		const hdr = ext("hdr", "/ext/hdr.ts", { hooks: ["before_provider_request", "turn_end"] });
		const turnOnly = ext("turns", "/ext/turns.ts", { hooks: ["turn_end"] });
		const expected = `${PREFIX}: extension "hdr" changes provider requests (before_provider_request) and is not loaded in workers; set OMK_WORKER_EXTENSIONS=hdr to keep it`;

		const warnings: string[] = [];
		const omk = { [Symbol.for("omk.internal.loadedExtensions")]: () => [hdr, turnOnly] };
		const planner = createWorkerExtensionPlanner(omk, {
			env: {},
			warn: (m) => warnings.push(m),
			state: createWorkerExtensionWarningState(),
		});
		expect(planner.argsFor("openai/gpt", undefined)).toEqual(["--no-extensions"]);
		expect(warnings).toEqual([expected]);
		expect(planner.argsFor("openai/gpt", undefined)).toEqual(["--no-extensions"]);
		expect(warnings).toEqual([expected]);

		expect(run(undefined, [hdr, turnOnly]).warnings).toEqual([expected]);
		expect(
			workerExtensionArgs({ env: {}, loaded: [hdr], workerProvider: undefined, firstSpawn: false }).warnings,
		).toEqual([]);
		expect(run("hdr", [hdr, turnOnly])).toEqual({ args: ["--no-extensions", "-e", hdr.resolvedPath], warnings: [] });
		expect(run("all", [hdr, turnOnly]).warnings).toEqual([]);
		const owner = { ...hdr, providers: ["p"] };
		expect(run(undefined, [owner], "p")).toEqual({
			args: ["--no-extensions", "-e", owner.resolvedPath],
			warnings: [],
		});
		expect(run(undefined, [turnOnly]).warnings).toEqual([]);
	});
});

describe("resolveWorkerProvider (spec 057 R5)", () => {
	const registry = {
		getAll: () => [
			{ provider: "openrouter", id: "anthropic/claude-x" },
			{ provider: "mock", id: "m1" },
			{ provider: "a", id: "shared" },
			{ provider: "b", id: "shared" },
		],
	};

	it("resolves provider/id, canonical ids that contain a slash, and unique bare ids", () => {
		expect(resolveWorkerProvider(undefined, registry)).toBeUndefined();
		expect(resolveWorkerProvider("mock/m1", registry)).toBe("mock");
		expect(resolveWorkerProvider("openrouter/anthropic/claude-x", registry)).toBe("openrouter");
		expect(resolveWorkerProvider("unknown-provider/x", registry)).toBe("unknown-provider");
		expect(resolveWorkerProvider("m1", registry)).toBe("mock");
		expect(resolveWorkerProvider("shared", registry)).toBeUndefined();
		expect(resolveWorkerProvider("missing", registry)).toBeUndefined();
		expect(resolveWorkerProvider("m1", undefined)).toBeUndefined();
		expect(
			resolveWorkerProvider("mock/m1", {
				getAll: () => {
					throw new Error("registry not ready");
				},
			}),
		).toBe("mock");
	});
});
