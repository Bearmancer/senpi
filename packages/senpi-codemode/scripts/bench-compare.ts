/**
 * The authoritative timing comparator (plan todo 2): paired interleaved blocks, min-of-N per side,
 * an A/A calibration band, and CPU + wall + p95 gated at <= 1.00 + band. Pure: no I/O, no clocks.
 */

export const LOAD_REFUSAL = 80;
export const MAX_BAND = 0.05;

export type Metric = "cpu" | "wall" | "p95";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "REFUSED";

export interface Rep {
	readonly cpuMs: number;
	readonly wallMs: number;
	readonly p95Ms?: number;
}

/** Repetitions of both sides of one block; `first` is base, `second` is head (or base again for A/A). */
export interface PairedBlock {
	readonly first: readonly Rep[];
	readonly second: readonly Rep[];
}

export interface Series {
	readonly scenario: string;
	readonly runtimeId: string;
	readonly optional?: boolean;
	readonly present: { readonly base: boolean; readonly head: boolean };
	readonly calibration: readonly PairedBlock[];
	readonly comparison: readonly PairedBlock[];
}

export interface RuntimeSide {
	readonly available: boolean;
	readonly version?: string;
}

export interface RuntimeStatus {
	readonly id: string;
	readonly base: RuntimeSide;
	readonly head: RuntimeSide;
}

export interface BenchInput {
	readonly runtimes: readonly RuntimeStatus[];
	readonly blockLoads: readonly number[];
	readonly series: readonly Series[];
	readonly failures?: readonly string[];
}

export interface SeriesResult {
	readonly scenario: string;
	readonly runtimeId: string;
	readonly metric: Metric;
	readonly calibrationRatios: readonly number[];
	readonly pairedRatios: readonly number[];
	readonly medianRatio: number;
	readonly regressed: boolean;
}

export interface Decision {
	readonly exitCode: 0 | 1 | 2 | 3;
	readonly verdict: Verdict;
	readonly band: number | null;
	readonly lines: readonly string[];
	readonly results: readonly SeriesResult[];
	readonly skipped: readonly string[];
}

export function admitHost(load1: number): Decision | undefined {
	if (load1 <= LOAD_REFUSAL) return undefined;
	const line = `host refused: 1-minute load ${load1.toFixed(2)} > ${LOAD_REFUSAL}; rerun on a quieter host`;
	return { exitCode: 2, verdict: "REFUSED", band: null, lines: [line], results: [], skipped: [] };
}

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length === 0) return Number.NaN;
	return sorted.length % 2 === 1
		? (sorted[middle] ?? Number.NaN)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return Number.NaN;
	const rank = Math.max(1, Math.ceil(fraction * sorted.length));
	return sorted[rank - 1] ?? Number.NaN;
}

function metricValue(rep: Rep, metric: Metric): number | undefined {
	switch (metric) {
		case "cpu":
			return rep.cpuMs;
		case "wall":
			return rep.wallMs;
		case "p95":
			return rep.p95Ms;
	}
}

function minimum(reps: readonly Rep[], metric: Metric): number | undefined {
	const values = reps.map((rep) => metricValue(rep, metric)).filter((value) => value !== undefined);
	return values.length === 0 ? undefined : Math.min(...values);
}

/** Per block: min-of-N per side, then second / first. */
export function pairedRatios(blocks: readonly PairedBlock[], metric: Metric): number[] {
	const ratios: number[] = [];
	for (const block of blocks) {
		const first = minimum(block.first, metric);
		const second = minimum(block.second, metric);
		if (first === undefined || second === undefined) continue;
		ratios.push(first === 0 ? (second === 0 ? 1 : Number.POSITIVE_INFINITY) : second / first);
	}
	return ratios;
}

function metricsOf(series: Series): Metric[] {
	if (series.scenario === "warm-cell-1000" || series.scenario === "tool-compose-100") return ["cpu", "wall", "p95"];
	const hasP95 = [...series.calibration, ...series.comparison].some((block) =>
		[...block.first, ...block.second].some((rep) => rep.p95Ms !== undefined),
	);
	return hasP95 ? ["cpu", "wall", "p95"] : ["cpu", "wall"];
}

function invalidations(input: BenchInput): string[] {
	const lines = [...(input.failures ?? [])];
	if (input.runtimes.length === 0) lines.push("no runtimes selected");
	for (const runtime of input.runtimes) {
		for (const side of ["base", "head"] as const) {
			if (!runtime[side].available) lines.push(`required runtime missing on ${side}: ${runtime.id}`);
		}
		const { base, head } = runtime;
		if (base.available && head.available && base.version !== head.version)
			lines.push(`runtime version differs: ${runtime.id} base ${base.version} vs head ${head.version}`);
	}
	for (const series of input.series) {
		if (!series.optional && !series.present.base && !series.present.head)
			lines.push(`required scenario missing on both sides: ${series.scenario} ${series.runtimeId}`);
		if (series.present.base !== series.present.head) {
			const missing = series.present.base ? "head" : "base";
			lines.push(`scenario missing on ${missing}: ${series.scenario} ${series.runtimeId}`);
		}
		if (!series.present.base || !series.present.head) continue;
		for (const blocks of [series.calibration, series.comparison]) {
			if (blocks.length < 3) lines.push(`incomplete blocks: ${series.scenario} ${series.runtimeId}`);
			for (const block of blocks) {
				for (const reps of [block.first, block.second]) {
					if (reps.length !== 3) lines.push(`incomplete repetitions: ${series.scenario} ${series.runtimeId}`);
					for (const rep of reps) {
						if (metricsOf(series).includes("p95") && rep.p95Ms === undefined)
							lines.push(`missing p95 measurement: ${series.scenario} ${series.runtimeId}`);
						if (
							[rep.cpuMs, rep.wallMs, ...(rep.p95Ms === undefined ? [] : [rep.p95Ms])].some(
								(value) => !Number.isFinite(value) || value < 0,
							)
						)
							lines.push(`invalid measurement: ${series.scenario} ${series.runtimeId}`);
					}
				}
			}
		}
	}
	return lines;
}

export function decide(input: BenchInput): Decision {
	const refusal = admitHost(Math.max(...input.blockLoads));
	if (refusal) return refusal;
	const measured = input.series.filter((series) => series.present.base && series.present.head);
	const skipped = input.series
		.filter((series) => series.optional && !series.present.base && !series.present.head)
		.map((series) => `${series.scenario} ${series.runtimeId}: not present on head`);
	const calibration = measured.flatMap((series) =>
		metricsOf(series).flatMap((metric) => pairedRatios(series.calibration, metric)),
	);
	const band =
		calibration.length === 0
			? null
			: percentile(
					calibration.map((ratio) => Math.abs(ratio - 1)),
					0.95,
				);
	const results = measured.flatMap((series) =>
		metricsOf(series).map((metric): SeriesResult => {
			const ratios = pairedRatios(series.comparison, metric);
			const medianRatio = median(ratios);
			return {
				scenario: series.scenario,
				runtimeId: series.runtimeId,
				metric,
				calibrationRatios: pairedRatios(series.calibration, metric),
				pairedRatios: ratios,
				medianRatio,
				regressed: band !== null && !(medianRatio <= 1 + band),
			};
		}),
	);
	const invalid = invalidations(input);
	if (band === null) invalid.push("no A/A calibration ratios were measured");
	else if (!Number.isFinite(band) || band > MAX_BAND)
		invalid.push(`A/A noise band ${band.toFixed(2)} > ${MAX_BAND.toFixed(2)}; repeat on a quieter host`);
	if (invalid.length > 0)
		return {
			exitCode: 3,
			verdict: "INCONCLUSIVE",
			band,
			lines: invalid.map((line) => `INCONCLUSIVE: ${line}`),
			results,
			skipped,
		};
	const shownBand = (band ?? 0).toFixed(2);
	const lines = results
		.filter((result) => result.regressed)
		.map(
			(result) =>
				`FAIL: ${result.scenario} ${result.runtimeId}: paired ${result.metric} ratio ${result.medianRatio.toFixed(2)} > 1.00 + band ${shownBand}`,
		);
	return lines.length > 0
		? { exitCode: 1, verdict: "FAIL", band, lines, results, skipped }
		: { exitCode: 0, verdict: "PASS", band, lines: [], results, skipped };
}

export interface SlowInjection {
	readonly side: "head";
	readonly scenario: string;
	readonly factor: number;
}

/** Test-only hook: `head:<scenario>:<factor>` scales the head's comparison samples of that scenario. */
export function parseInjection(spec: string): SlowInjection {
	const match = /^head:([a-z0-9-]+):(\d+(?:\.\d+)?)$/u.exec(spec);
	const factor = Number(match?.[2]);
	if (!match?.[1] || !(factor > 0))
		throw new RangeError(`--inject-slow expects head:<scenario>:<factor>, got ${spec}`);
	return { side: "head", scenario: match[1], factor };
}

export function injectSlow(series: Series, injections: readonly SlowInjection[]): Series {
	const factor = injections
		.filter((injection) => injection.scenario === series.scenario)
		.reduce((product, injection) => product * injection.factor, 1);
	if (factor === 1) return series;
	const scale = (rep: Rep): Rep => ({
		cpuMs: rep.cpuMs * factor,
		wallMs: rep.wallMs * factor,
		...(rep.p95Ms === undefined ? {} : { p95Ms: rep.p95Ms * factor }),
	});
	return {
		...series,
		comparison: series.comparison.map((block) => ({ first: block.first, second: block.second.map(scale) })),
	};
}
