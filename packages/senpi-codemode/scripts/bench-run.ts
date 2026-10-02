import { loadavg } from "node:os";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { PairedBlock, RuntimeStatus, Series } from "./bench-compare.ts";
import { implementedScenarios, plannedScenarios } from "./bench-scenarios.ts";
import { runProcess } from "./bench-target.ts";

const repSchema = Type.Object({
	cpuMs: Type.Number(),
	wallMs: Type.Number(),
	hostCpuMs: Type.Number(),
	kernelCpuMs: Type.Number(),
	p95Ms: Type.Optional(Type.Number()),
	observations: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
	),
});
const runtimeReportSchema = Type.Object({
	hostRuntime: Type.Union([Type.Literal("bun"), Type.Literal("node")]),
	hostVersion: Type.String(),
	runtimeVersion: Type.String(),
	loadavg: Type.Array(Type.Number()),
	scenarios: Type.Record(Type.String(), Type.Array(repSchema)),
});
export const runtimesSchema = Type.Object({
	version: Type.Literal(1),
	required: Type.Array(
		Type.Object({
			id: Type.String(),
			language: Type.Union([Type.Literal("js"), Type.Literal("py"), Type.Literal("rb"), Type.Literal("jl")]),
			jsRuntime: Type.Optional(Type.Union([Type.Literal("bun"), Type.Literal("node")])),
		}),
	),
});

export type RuntimeReport = Static<typeof runtimeReportSchema>;
export type RequiredRuntime = Static<typeof runtimesSchema>["required"][number];
export type Side = "base" | "head";

export interface RunPlan {
	readonly targets: Readonly<Record<Side, string>>;
	readonly runtimes: readonly RequiredRuntime[];
	readonly blocks: number;
	readonly reps: number;
	readonly scriptRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly log: (line: string) => void;
}

export interface BlockRecord {
	readonly index: number;
	readonly comparisonOrder: readonly Side[];
	readonly loadavg: readonly number[];
	readonly power: string;
}

export interface RunResult {
	readonly blocks: readonly BlockRecord[];
	readonly admissionLoads: readonly number[];
	readonly runtimes: readonly RuntimeStatus[];
	readonly series: readonly Series[];
	readonly reports: Readonly<
		Record<string, readonly { block: number; role: string; side: Side; report: RuntimeReport }[]>
	>;
	readonly failures: readonly string[];
}

const interpreterCommand = { js: "bun", py: "python3", rb: "ruby", jl: "julia" } as const;

async function powerSource(): Promise<string> {
	if (process.platform !== "darwin") return `${process.platform}: not reported`;
	const result = await runProcess(["pmset", "-g", "batt"], { cwd: process.cwd() }).catch(() => undefined);
	return /'([^']+)'/u.exec(result?.stdout ?? "")?.[1] ?? "unknown";
}

async function interpreterAvailable(runtime: RequiredRuntime, env: NodeJS.ProcessEnv): Promise<boolean> {
	const command = runtime.jsRuntime ?? interpreterCommand[runtime.language];
	const result = await runProcess([command, "--version"], { cwd: process.cwd(), env }).catch(() => undefined);
	return result?.exitCode === 0;
}

async function runChild(plan: RunPlan, runtime: RequiredRuntime, target: string): Promise<RuntimeReport | string> {
	const host = runtime.jsRuntime ?? "bun";
	const script = resolve(plan.scriptRoot, "bench-runtime.ts");
	const prefix = host === "node" ? ["node", "--expose-gc", "--import", "tsx"] : ["bun"];
	const args = [...prefix, script, target, runtime.language, String(plan.reps)];
	const result = await runProcess(args, { cwd: resolve(plan.scriptRoot, ".."), env: plan.env });
	const line = result.stdout.split("\n").find((entry) => entry.startsWith("BENCH_RUNTIME:"));
	const parsed: unknown = line === undefined ? undefined : JSON.parse(line.slice("BENCH_RUNTIME:".length));
	if (result.exitCode === 0 && Check(runtimeReportSchema, parsed)) return parsed;
	return `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().split("\n").slice(-6).join(" | ")}`;
}

type Collected = Record<string, { block: number; role: string; side: Side; report: RuntimeReport }[]>;

export async function runBlocks(plan: RunPlan): Promise<RunResult> {
	const failures: string[] = [];
	const available = new Map<string, boolean>();
	for (const runtime of plan.runtimes) available.set(runtime.id, await interpreterAvailable(runtime, plan.env));
	const collected: Collected = {};
	const blocks: BlockRecord[] = [];
	const admissionLoads: number[] = [];
	if ([...available.values()].some((present) => !present))
		return { blocks, admissionLoads, failures, reports: collected, ...assemble(plan, available, collected) };
	blocksLoop: for (let index = 0; index < plan.blocks; index += 1) {
		const comparisonOrder: Side[] = index % 2 === 0 ? ["base", "head"] : ["head", "base"];
		blocks.push({ index, comparisonOrder, loadavg: loadavg(), power: await powerSource() });
		for (const runtime of plan.runtimes) {
			if (available.get(runtime.id) !== true) continue;
			const runs: { role: string; side: Side }[] = [
				...comparisonOrder.map((side) => ({ role: "comparison", side })),
				{ role: "calibration-1", side: "base" },
				{ role: "calibration-2", side: "base" },
			];
			for (const run of index % 2 === 0 ? runs : [...runs.slice(2), ...runs.slice(0, 2)]) {
				const admissionLoad = loadavg()[0] ?? 0;
				admissionLoads.push(admissionLoad);
				if (admissionLoad > 80) {
					failures.push("host load exceeded 80 before the next measurement");
					break blocksLoop;
				}
				plan.log(`block ${index + 1}/${plan.blocks} ${runtime.id} ${run.role} ${run.side}`);
				const outcome = await runChild(plan, runtime, plan.targets[run.side]);
				if (typeof outcome === "string") {
					failures.push(`${runtime.id} ${run.side} block ${index + 1} ${run.role} failed: ${outcome}`);
					break blocksLoop;
				}
				(collected[runtime.id] ??= []).push({ block: index, ...run, report: outcome });
			}
		}
	}
	return { blocks, admissionLoads, failures, reports: collected, ...assemble(plan, available, collected) };
}

function versionOf(runs: readonly { report: RuntimeReport }[]): string | undefined {
	const versions = new Set(
		runs.map(({ report }) => `${report.runtimeVersion} (${report.hostRuntime} ${report.hostVersion})`),
	);
	return versions.size === 1 ? [...versions][0] : versions.size === 0 ? undefined : [...versions].join(" | ");
}

function assemble(plan: RunPlan, available: ReadonlyMap<string, boolean>, collected: Collected) {
	const runtimes: RuntimeStatus[] = [];
	const series: Series[] = [];
	for (const runtime of plan.runtimes) {
		const runs = collected[runtime.id] ?? [];
		const sideRuns = (side: Side) => runs.filter((run) => run.side === side);
		const status = (side: Side) => {
			const version = versionOf(sideRuns(side));
			return {
				available: available.get(runtime.id) === true && sideRuns(side).length > 0,
				...(version ? { version } : {}),
			};
		};
		runtimes.push({ id: runtime.id, base: status("base"), head: status("head") });
		const scenarios = [...implementedScenarios.map((scenario) => scenario.name), ...plannedScenarios];
		for (const scenario of scenarios) {
			const has = (side: Side) =>
				sideRuns(side).length > 0 && sideRuns(side).every((run) => scenario in run.report.scenarios);
			const reps = (block: number, role: string, side: Side) =>
				runs.find((run) => run.block === block && run.role === role && run.side === side)?.report.scenarios[
					scenario
				] ?? [];
			const paired = (roles: readonly [string, Side, string, Side]): PairedBlock[] =>
				Array.from({ length: plan.blocks }, (_, block) => ({
					first: reps(block, roles[0], roles[1]),
					second: reps(block, roles[2], roles[3]),
				}));
			series.push({
				scenario,
				runtimeId: runtime.id,
				present: { base: has("base"), head: has("head") },
				calibration: paired(["calibration-1", "base", "calibration-2", "base"]),
				comparison: paired(["comparison", "base", "comparison", "head"]),
			});
		}
	}
	return { runtimes, series };
}
