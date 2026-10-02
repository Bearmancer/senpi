import type { Rep, Series } from "./bench-compare.ts";

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

function scaled(rep: Rep, factor: number): Rep {
	return {
		cpuMs: rep.cpuMs * factor,
		wallMs: rep.wallMs * factor,
		...(rep.p95Ms === undefined ? {} : { p95Ms: rep.p95Ms * factor }),
	};
}

/** Test-only hook: scales the second calibration instance, forcing a known A/A offset on every row. */
export function injectCalibrationOffset(series: Series, factor: number): Series {
	if (!(factor > 0)) throw new RangeError(`--inject-aa-offset expects a positive factor, got ${factor}`);
	if (factor === 1) return series;
	return {
		...series,
		calibration: series.calibration.map((block) => ({
			first: block.first,
			second: block.second.map((rep) => scaled(rep, factor)),
		})),
	};
}

export function injectSlow(series: Series, injections: readonly SlowInjection[]): Series {
	const factor = injections
		.filter((injection) => injection.scenario === series.scenario)
		.reduce((product, injection) => product * injection.factor, 1);
	if (factor === 1) return series;
	return {
		...series,
		comparison: series.comparison.map((block) => ({
			first: block.first,
			second: block.second.map((rep) => scaled(rep, factor)),
		})),
	};
}
