import { readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Check } from "typebox/value";
import { admitHost, type Decision, decide } from "./bench-compare.ts";
import { injectSlow, parseInjection } from "./bench-inject.ts";
import { type RunResult, runBlocks, runtimesSchema, type Side } from "./bench-run.ts";
import { assertFreshTarget, BenchTargetError, resolvePackage, targetRevision } from "./bench-target.ts";
import { DEFAULT_BAND_SCOPE, MAX_BAND, parseBandScope, THRESHOLD_Z } from "./bench-threshold.ts";
import { MIN_REPS } from "./bench-validate.ts";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");

function benchEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
}

function refused(line: string): Decision {
	return {
		exitCode: 2,
		verdict: "REFUSED",
		bandScope: DEFAULT_BAND_SCOPE,
		lines: [line],
		results: [],
		skipped: [],
	};
}

const fixed = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

function printDecision(decision: Decision, out: string): void {
	console.log(
		`A/A bands (${decision.bandScope} scope): gate = trimmed-mean paired ratio <= 1.00 + band; band = |A/A offset| + ${THRESHOLD_Z} SE, threshold capped at ${MAX_BAND.toFixed(2)}; a row whose band exceeds the cap is NOISE-LIMITED (INCONCLUSIVE)`,
	);
	console.log("  row | threshold | band | ratio | median paired ratio | verdict");
	for (const result of decision.results) {
		console.log(
			`  ${result.scenario} ${result.runtimeId} ${result.metric} | ${fixed(result.threshold)} | ${fixed(result.band)} | ${fixed(result.ratio)} | ${fixed(result.medianPairedRatio)} | ${result.verdict}`,
		);
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
			reps: { type: "string", default: "15" },
			"band-scope": { type: "string", default: DEFAULT_BAND_SCOPE },
			out: { type: "string", default: "bench-report.json" },
			runtimes: { type: "string" },
			"inject-slow": { type: "string", multiple: true, default: [] },
			"inject-loadavg": { type: "string" },
		},
	});
	const out = resolve(values.out);
	const bandScope = parseBandScope(values["band-scope"]);
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
	if (!Number.isInteger(blocks) || blocks < 3 || !Number.isInteger(reps) || reps < MIN_REPS)
		throw new RangeError(`bench requires at least three blocks and at least ${MIN_REPS} repetitions per side`);
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
		reps,
		bandScope,
		blockLoads: [
			...run.admissionLoads,
			...run.blocks.map((block) => block.loadavg[0] ?? 0),
			...Object.values(run.reports).flatMap((reports) => reports.map(({ report }) => report.loadavg[0] ?? 0)),
		],
		series,
		failures: run.failures,
	});
	return finish(decision, out, { targets, revisions, blocks, reps, bandScope, injections, run, series });
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
			`paired interleaved repetitions, trimmed mean (25%) of paired log ratios per row <= 1.00 + A/A band; band = |A/A offset| + ${THRESHOLD_Z} SE of that row's calibration pairs (or one p95 band with --band-scope global), threshold capped at ${MAX_BAND}; noise-limited rows inconclusive`,
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
