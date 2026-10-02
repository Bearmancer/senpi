import { loadavg } from "node:os";
import type { EvalLanguage } from "../src/tool/types.ts";
import { futureCapabilityCell, scalarCell, versionCell } from "./bench-cells.ts";
import type { Measured } from "./bench-measure.ts";
import { implementedScenarios } from "./bench-scenarios.ts";
import { type BenchMemory, createBenchSession, loadTarget } from "./bench-session.ts";

const BENCH_RUNTIME_PREFIX = "BENCH_RUNTIME:";
const WARM_UP_CELLS = 5;

function languageFrom(value: string | undefined): EvalLanguage {
	switch (value) {
		case "js":
		case "py":
		case "rb":
		case "jl":
			return value;
		default:
			throw new RangeError(`bench language ${String(value)}`);
	}
}

/** One side of one block for one runtime, in its own host process so js-bun and js-node use their own engine. */
async function main(): Promise<void> {
	const [target, languageArg, repsArg, onlyArg] = process.argv.slice(2);
	if (!target) throw new RangeError("bench runtime needs a target");
	const language = languageFrom(languageArg);
	const reps = Number(repsArg ?? "3");
	const only = onlyArg ? onlyArg.split(",") : undefined;
	const selected = implementedScenarios.filter((scenario) => only === undefined || only.includes(scenario.name));
	const modules = await loadTarget(target);
	const fresh = (memory?: BenchMemory) => createBenchSession(modules, language, memory);
	const session = await fresh();
	try {
		for (let index = 0; index < WARM_UP_CELLS; index += 1) await session.cell(scalarCell[language]);
		const runtimeVersion = (await session.cell(versionCell[language])).text.trim().replace(/^["']|["']$/gu, "");
		const scenarios: Record<string, Measured[]> = {};
		const capabilities = (await session.cell(futureCapabilityCell[language])).text;
		const pending = [
			...(capabilities.includes("wait") ? ["wait-1000-handles"] : []),
			...(capabilities.includes("install") ? ["managed-install", "install-local-fixtures"] : []),
			...(capabilities.includes("callback") ? ["callback-roundtrip-js-py"] : []),
			...("sandbox" in modules.settings.defaultCodemodeSettings
				? ["sandbox-execute", "sandbox-compose", "sandbox-runaway"]
				: []),
		];
		// A newly shipped capability without a workload must invalidate, not silently skip.
		for (const name of pending) scenarios[name] = [];
		for (const scenario of selected) {
			const samples: Measured[] = [];
			for (let rep = 0; rep < reps; rep += 1) samples.push(await scenario.run({ language, session, fresh, rep }));
			scenarios[scenario.name] = samples;
		}
		const report = {
			hostRuntime: process.versions.bun === undefined ? "node" : "bun",
			hostVersion: process.versions.bun ?? process.versions.node,
			runtimeVersion,
			loadavg: loadavg(),
			scenarios,
		};
		console.log(`${BENCH_RUNTIME_PREFIX}${JSON.stringify(report)}`);
	} finally {
		await session.dispose();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
