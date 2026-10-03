import { Type } from "typebox";
import { Value } from "typebox/value";
import { type ProcessFootprint, readOwnFootprint } from "../process-footprint.ts";
import type { ResidentStoreSize } from "../session-resident-store-size.ts";
import {
	type MemoryReportSessionSource,
	type NamedMemoryReporter,
	RESERVED_MEMORY_REPORT_KEYS,
	type TuiRenderCacheTotals,
	tuiRenderCacheTotals,
} from "./memory-report-registry.ts";

// The codemode extension publishes its live kernels under this process-global key (kernel-registry.ts).
const KERNEL_REGISTRY_KEY = Symbol.for("senpi.codemode.kernel-registry");

const kernelListingSchema = Type.Object({
	id: Type.String(),
	sessionId: Type.String(),
	language: Type.String(),
	measure: Type.String(),
	lastLiveBytes: Type.Optional(Type.Number()),
	busy: Type.Boolean(),
	pid: Type.Optional(Type.Number()),
});

export interface MainThreadMemory {
	readonly jscHeapSize?: number;
	readonly heapUsed: number;
	readonly external: number;
	readonly footprint: ProcessFootprint;
}

export interface KernelMemoryEntry {
	readonly id: string;
	readonly sessionId: string;
	readonly language: string;
	readonly measure: string;
	readonly lastLiveBytes?: number;
	/** A cell was running: `lastLiveBytes` is the last reading, not what the kernel holds now. */
	readonly stale: boolean;
	readonly pid?: number;
}

export interface MemoryReportCore {
	readonly sessionId: string;
	readonly takenAt: string;
	readonly pid: number;
	readonly main: MainThreadMemory;
	readonly kernels: readonly KernelMemoryEntry[];
	readonly residentStore: ResidentStoreSize;
	readonly tuiRenderCache?: TuiRenderCacheTotals;
	readonly heapSnapshot?: string;
	readonly reporterErrors?: Readonly<Record<string, string>>;
}

/** The core sections plus one section per extension reporter, keyed by the reporter's name. */
export type MemoryReport = MemoryReportCore & Readonly<Record<string, unknown>>;

export function buildMemoryReport(source: MemoryReportSessionSource, heapSnapshot?: string): MemoryReport {
	const { sections, errors } = reporterSections(source.reporters());
	const tuiRenderCache = tuiRenderCacheTotals();
	const core: MemoryReportCore = {
		sessionId: source.sessionId(),
		takenAt: new Date().toISOString(),
		pid: process.pid,
		main: mainThreadMemory(),
		kernels: liveKernels(),
		residentStore: source.residentStore(),
		...(tuiRenderCache === undefined ? {} : { tuiRenderCache }),
		...(heapSnapshot === undefined ? {} : { heapSnapshot }),
		...(Object.keys(errors).length === 0 ? {} : { reporterErrors: errors }),
	};
	return { ...sections, ...core };
}

function mainThreadMemory(): MainThreadMemory {
	const usage = process.memoryUsage();
	const jscHeapSize = jscHeapSizeOnBun();
	return {
		...(jscHeapSize === undefined ? {} : { jscHeapSize }),
		heapUsed: usage.heapUsed,
		external: usage.external,
		footprint: readOwnFootprint(),
	};
}

/** `bun:jsc` answers synchronously on Bun and is absent on Node, where the field is omitted. */
function jscHeapSizeOnBun(): number | undefined {
	const jsc: unknown = process.getBuiltinModule("bun:jsc");
	if (typeof jsc !== "object" || jsc === null) return undefined;
	const heapSize: unknown = Reflect.get(jsc, "heapSize");
	if (typeof heapSize !== "function") return undefined;
	const bytes: unknown = Reflect.apply(heapSize, jsc, []);
	return typeof bytes === "number" ? bytes : undefined;
}

function liveKernels(): KernelMemoryEntry[] {
	const registry: unknown = Reflect.get(globalThis, KERNEL_REGISTRY_KEY);
	if (typeof registry !== "object" || registry === null) return [];
	const list: unknown = Reflect.get(registry, "list");
	if (typeof list !== "function") return [];
	const listed: unknown = Reflect.apply(list, registry, []);
	if (!Array.isArray(listed)) return [];
	return listed
		.filter((entry) => Value.Check(kernelListingSchema, entry))
		.map(({ busy, ...entry }) => ({ ...entry, stale: busy }));
}

function reporterSections(reporters: readonly NamedMemoryReporter[]): {
	sections: Record<string, Record<string, number>>;
	errors: Record<string, string>;
} {
	const sections: Record<string, Record<string, number>> = {};
	const errors: Record<string, string> = {};
	for (const { name, reporter } of reporters) {
		if (RESERVED_MEMORY_REPORT_KEYS.has(name) || name in sections || name in errors) continue;
		try {
			sections[name] = finiteFigures(reporter());
		} catch (error) {
			errors[name] = error instanceof Error ? error.message : String(error);
		}
	}
	return { sections, errors };
}

function finiteFigures(figures: unknown): Record<string, number> {
	if (typeof figures !== "object" || figures === null) return {};
	const kept: Record<string, number> = {};
	for (const [key, value] of Object.entries(figures)) {
		if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
	}
	return kept;
}
