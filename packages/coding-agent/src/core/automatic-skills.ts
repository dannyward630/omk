import { rankCorpus } from "../metacognition/retrieval.ts";
import { devinHarnessAutoApplyEnabled, isDevinProvider, selectDevinHarnessSkills } from "./devin-harness.ts";
import { routeDomain } from "./domain-router.ts";
import { grokHarnessAutoApplyEnabled, isGrokOAuthProvider, selectGrokHarnessSkills } from "./grok-harness.ts";
import { type SkillSelectionResult, selectSkills } from "./skill-selector.ts";
import type { Skill } from "./skills.ts";

const LANGUAGE_HINTS = [
	[/디버그|디버깅|버그|오류|고쳐|수정해/u, "debug bug fix errors"],
	[/프론트엔드|컴포넌트|화면|웹페이지|반응형/u, "frontend UI components"],
	[/백엔드|서버|엔드포인트/u, "backend API server"],
	[/파이썬/u, "python"],
	[/타입스크립트/u, "typescript"],
	[/러스트/u, "rust"],
	[/리팩터링|리팩토링|코드.*(?:작성|구현)|기능.*(?:추가|구현)/u, "programming implementation refactor"],
	[/문서.*작성|사용법|설명서/u, "documentation writing"],
	[/테스트|검증|회귀/u, "test verify regression"],
	[/보안|취약점/u, "security vulnerability audit"],
	[/계획|설계|요구사항/u, "plan architecture requirements"],
	[/검색|논문|조사/u, "research search"],
] as const;

/** Pure, provider-neutral routing. It grants guidance, never tool or execution authority. */
export function automaticSkills(
	query: string,
	inventory: readonly Skill[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): SkillSelectionResult {
	const task = query.slice(0, 4096).trim();
	const enabled = !["0", "false", "off", "no"].includes(env.OMK_AUTO_SKILLS?.trim().toLowerCase() ?? "");
	const seen = new Set<string>();
	const available = inventory.filter((skill) => {
		if (skill.disableModelInvocation || !skill.name || /\s|[\x00-\x1f\x7f-\x9f]/u.test(skill.name)) return false;
		const identity = skill.contentHash ?? skill.name;
		if (seen.has(identity) || seen.has(`name:${skill.name}`)) return false;
		seen.add(identity);
		seen.add(`name:${skill.name}`);
		return true;
	});
	if (!enabled || /^(?:[!/]|<skill\b)/u.test(task)) return selectSkills({ task: "", skills: [] });
	const hints: string[] = LANGUAGE_HINTS.filter(([pattern]) => pattern.test(task)).map(([, hint]) => hint);
	const domain = routeDomain({ task });
	if (hints.length === 0 && domain.confidence !== "fallback" && !domain.ambiguous) hints.push(domain.primary.label);
	const clauses = task
		.split(/\b(?:and|then|also)\b|그리고|그다음|[;\n]/iu)
		.filter((clause) => clause.trim())
		.slice(0, 4);
	const views = [...new Set([task, ...clauses, ...(hints.length > 0 ? [hints.join(" ")] : [])])];
	// Exact BM25 prefilter bounds expensive subword coverage to 64 candidates on large inventories.
	const byName = new Map(available.slice(0, 5000).map((skill) => [skill.name, skill]));
	const pool =
		available.length > 64
			? rankCorpus(
					[hints.join(" "), task].join(" ").slice(0, 4096),
					[...byName.values()].map((skill) => ({
						id: skill.name,
						uri: skill.filePath,
						body: `${skill.name} ${skill.description.slice(0, 1024)}`,
					})),
				)
					.slice(0, 64)
					.map((hit) => byName.get(hit.id))
					.filter((skill): skill is Skill => skill !== undefined)
			: available;
	const plans = views.map((view) => selectSkills({ task: view, skills: pool }));
	const best = plans.reduce((leader, plan) =>
		(plan.selected[0]?.score ?? 0) > (leader.selected[0]?.score ?? 0) ? plan : leader,
	);
	const candidates = new Map<string, SkillSelectionResult["selected"][number]>();
	for (const plan of plans)
		for (const entry of plan.selected) {
			if (entry.score > (candidates.get(entry.name)?.score ?? 0)) candidates.set(entry.name, entry);
		}
	const selected = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 3);
	const scores = new Map<string, number>();
	for (const plan of plans)
		for (const score of plan.scores) scores.set(score.name, Math.max(scores.get(score.name) ?? 0, score.score));
	return {
		...best,
		selected,
		scores: [...scores].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score),
	};
}

/** Draft preview follows the provider's existing skill boundary where one exists. */
export function previewSkillNames(
	query: string,
	inventory: readonly Skill[],
	options: { readonly provider: string | undefined; readonly env: NodeJS.ProcessEnv },
): readonly string[] {
	if (/^[!/]/u.test(query.trimStart())) return [];
	if (isGrokOAuthProvider(options.provider) && grokHarnessAutoApplyEnabled(options.env))
		return selectGrokHarnessSkills(query, inventory);
	if (isDevinProvider(options.provider) && devinHarnessAutoApplyEnabled(options.env))
		return selectDevinHarnessSkills(query, inventory);
	return automaticSkills(query, inventory, options.env).selected.map((skill) => skill.name);
}
