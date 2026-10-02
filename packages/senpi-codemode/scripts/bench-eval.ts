import { readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Check } from "typebox/value";
import { admitHost, type Decision, decide, injectSlow, parseInjection } from "./bench-compare.ts";
import { type RunResult, runBlocks, runtimesSchema, type Side } from "./bench-run.ts";
import { assertFreshTarget, BenchTargetError, resolvePackage, targetRevision } from "./bench-target.ts";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");

function benchEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
}

function refused(line: string): Decision {
	return { exitCode: 2, verdict: "REFUSED", band: null, lines: [line], results: [], skipped: [] };
}

function printDecision(decision: Decision, out: string): void {
	const band = decision.band === null ? "not measured" : decision.band.toFixed(4);
	console.log(`A/A noise band: ${band} (gate: median paired ratio <= 1.00 + band; band > 0.05 is INCONCLUSIVE)`);
	for (const result of decision.results) {
		const ratio = Number.isFinite(result.medianRatio) ? result.medianRatio.toFixed(3) : String(result.medianRatio);
		console.log(`  ${result.scenario} ${result.runtimeId} ${result.metric}: median paired ratio ${ratio}`);
	}
	for (const skip of decision.skipped) console.log(`  skipped ${skip}`);
	for (const line of decision.lines) console.error(line);
	console.log(`Bench report: ${out}`);
	console.log(`bench: ${decision.verdict} (exit ${decision.exitCode})`);
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			base: { type: "string" },
			head: { type: "string" },
			blocks: { type: "string", default: "9" },
			reps: { type: "string", default: "3" },
			out: { type: "string", default: "bench-report.json" },
			runtimes: { type: "string" },
			"inject-slow": { type: "string", multiple: true, default: [] },
			"inject-loadavg": { type: "string" },
		},
	});
	const out = resolve(values.out);
	const load = values["inject-loadavg"] === undefined ? (loadavg()[0] ?? 0) : Number(values["inject-loadavg"]);
	console.log(`host: 1-minute load ${load.toFixed(2)}, ${process.platform}/${process.arch}`);
	const admission = admitHost(load);
	if (admission) return finish(admission, out, {});
	if (!values.base || !values.head) throw new RangeError("bench needs --base <checkout> and --head <checkout>");
	const injections = values["inject-slow"].map(parseInjection);
	const targets = { base: resolvePackage(values.base), head: resolvePackage(values.head) };
	const revisions: Partial<Record<Side, string>> = {};
	for (const side of ["base", "head"] as const) {
		try {
			await assertFreshTarget(targets[side]);
			revisions[side] = await targetRevision(targets[side]);
		} catch (error) {
			if (error instanceof BenchTargetError) return finish(refused(`${side}: ${error.message}`), out, { targets });
			throw error;
		}
	}
	const manifest: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/runtimes.json"), "utf8"));
	if (!Check(runtimesSchema, manifest)) throw new RangeError("test/gate/runtimes.json does not match its schema");
	const subset = values.runtimes?.split(",");
	const runtimes = manifest.required.filter((runtime) => subset === undefined || subset.includes(runtime.id));
	if (subset?.some((id) => !manifest.required.some((runtime) => runtime.id === id)) || runtimes.length === 0)
		throw new RangeError("--runtimes must select known, nonempty runtime ids");
	if (subset !== undefined)
		console.log(`runtime subset (explicit --runtimes): ${runtimes.map((r) => r.id).join(", ")}`);
	const blocks = Number(values.blocks);
	const reps = Number(values.reps);
	if (!Number.isInteger(blocks) || blocks < 3 || reps !== 3)
		throw new RangeError("bench requires at least three blocks and exactly three repetitions per side");
	const run = await runBlocks({
		targets,
		runtimes,
		blocks,
		reps,
		scriptRoot,
		env: benchEnv(),
		log: (line) => console.log(line),
	});
	const series = run.series.map((entry) => injectSlow(entry, injections));
	const decision = decide({
		runtimes: run.runtimes,
		blockLoads: [
			...run.admissionLoads,
			...run.blocks.map((block) => block.loadavg[0] ?? 0),
			...Object.values(run.reports).flatMap((reports) => reports.map(({ report }) => report.loadavg[0] ?? 0)),
		],
		series,
		failures: run.failures,
	});
	return finish(decision, out, { targets, revisions, blocks, reps, injections, run, series });
}

async function finish(decision: Decision, out: string, context: Readonly<Record<string, unknown>>): Promise<number> {
	const { run, ...rest } = context;
	const runResult: RunResult | undefined = isRunResult(run) ? run : undefined;
	const report = {
		schemaVersion: 1,
		suite: "senpi-codemode-eval",
		package: "@code-yeongyu/senpi-codemode",
		createdAt: new Date().toISOString(),
		policy:
			"paired interleaved blocks, min-of-N per side, median paired ratio <= 1.00 + A/A band (p95 |ratio-1|), band > 0.05 inconclusive",
		...rest,
		hostLoadavg: loadavg(),
		hostRuntime: {
			bun: process.versions.bun,
			node: process.versions.node,
			platform: process.platform,
			arch: process.arch,
		},
		blocks: runResult?.blocks ?? [],
		admissionLoads: runResult?.admissionLoads ?? [],
		runtimes: runResult?.runtimes ?? [],
		decision,
		reports: runResult?.reports ?? {},
	};
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	printDecision(decision, out);
	return decision.exitCode;
}

function isRunResult(value: unknown): value is RunResult {
	return typeof value === "object" && value !== null && "series" in value && "blocks" in value;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 3;
	},
);
