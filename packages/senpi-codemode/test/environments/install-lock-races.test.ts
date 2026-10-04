import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Fs = typeof import("node:fs/promises");
type Hook = (path: string, content: string) => Promise<void>;
const fsHook = vi.hoisted(
	() => ({ onRead: undefined, real: undefined }) as { onRead: Hook | undefined; real: Fs | undefined },
);

// Every read the lock makes passes through onRead, so a test can act as another waiter at that exact point.
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<Fs>();
	fsHook.real = real;
	const readFile = async (...args: Parameters<Fs["readFile"]>) => {
		const content = await real.readFile(...args);
		if (fsHook.onRead !== undefined) await fsHook.onRead(String(args[0]), String(content));
		return content;
	};
	return { ...real, default: { ...real, readFile }, readFile };
});

const { withRootLock } = await import("../../src/environments/install-lock.ts");

const roots: string[] = [];

afterEach(async () => {
	fsHook.onRead = undefined;
	for (const root of roots.splice(0)) await fsHook.real?.rm(root, { recursive: true, force: true });
});

function exitedPid(): number {
	return spawnSync(process.execPath, ["-e", "0"]).pid ?? 999_999;
}

async function publishLock(base: string, name: string, content: string): Promise<void> {
	const fs = fsHook.real as Fs;
	const temp = join(base, `test-temp-${crypto.randomUUID()}`);
	await fs.writeFile(temp, content);
	await fs.link(temp, join(base, name)).catch(() => undefined);
	await fs.rm(temp, { force: true });
}

describe("Given a waiter that judged the root lock stale", () => {
	it("When other waiters replace it with live locks before this waiter acts, then no live lock is ever deleted", async () => {
		const fs = fsHook.real as Fs;
		const base = await fs.mkdtemp(join(tmpdir(), "senpi-lock-race-"));
		roots.push(base);
		const lock = join(base, ".install.lock");
		const stale = JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" });
		const replacement = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "replacement" });
		const latecomer = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "latecomer" });
		await fs.writeFile(lock, stale);
		let replaced = false;
		let latecomerLinked = false;
		fsHook.onRead = async (path, content) => {
			// Another waiter has just reaped the stale lock and published its own, live one.
			if (!replaced && path === lock && content === stale) {
				replaced = true;
				await fs.rm(lock, { force: true });
				await publishLock(base, ".install.lock", replacement);
				return;
			}
			// The live lock is being read somewhere other than its own path: a third waiter links into the gap.
			if (!latecomerLinked && path !== lock && content === replacement) {
				latecomerLinked = true;
				await publishLock(base, ".install.lock", latecomer);
			}
		};

		const entered = await withRootLock(base, async () => "entered", AbortSignal.timeout(1_500)).catch(() => "waited");

		const onDisk = await fs.readFile(lock, "utf8").catch(() => "<none>");
		expect(entered).toBe("waited");
		expect(onDisk).toBe(replacement);
		expect((await fs.readdir(base)).filter((name) => name.startsWith(".install.lock.reap."))).toEqual([]);
	});
});
