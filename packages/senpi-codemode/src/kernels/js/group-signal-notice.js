// senpi#2995: Bun.$, node:child_process exec/execFile and the synchronous spawners leave their children in the
// agent's process group (Bun.$ has no such option, Bun ignores `detached` for exec/execFile, and a synchronous call
// keeps the terminal), so a group-wide signal from the same cell stops the agent. Such a command gets a notice; the
// notice only warns and never fails the cell.

// A group target is a dash argument after the signal options: a number, `$var`, `${var}` or `$(...)`.
const GROUP_TARGET = String.raw`-(?:\d+|\$\{?\w+\}?|\$\()`;
const SIGNAL_OPTION = String.raw`(?:-s\s+\w+|-n\s+\d+|-[A-Za-z]+\d*|-\d+)`;
// The first dash argument is a signal, so a group is one after `--`, after a signal option, or after a plain pid:
// `kill -- -<pgid>`, `kill -SIG -<pgid>`, `kill -TERM 1234 -5678`.
const PID = String.raw`[^\s\-;|&]\S*`;
const KILL_GROUP = new RegExp(
	String.raw`\bkill\b(?:` +
		String.raw`\s+--\s+${GROUP_TARGET}` +
		String.raw`|(?:\s+${SIGNAL_OPTION})+(?:\s+${PID})*\s+(?:--\s+)?${GROUP_TARGET}` +
		String.raw`|(?:\s+${SIGNAL_OPTION})*(?:\s+${PID})+\s+${GROUP_TARGET})`,
	"u",
);
const PKILL_GROUP = /\bpkill\b[^\n;|&]*\s(?:-g\d*|--pgroup)\b/u;
// `killall` in command position (also after `sudo` or as a `-c` script) signals every process with that name, which
// can include the agent's own (bun, node, senpi). Inside an `echo` string it is only text.
const KILLALL = /(?:^|[;|&(`]\s*|\bsudo\s+|-c\s+['"]\s*)killall\s/mu;

export const GROUP_SIGNAL_NOTICE_TAG = "[senpi:group-signal]";

export function signalsProcessGroup(commandText) {
	return KILL_GROUP.test(commandText) || PKILL_GROUP.test(commandText) || KILLALL.test(commandText);
}

export function groupSignalNotice(api, readGroup = agentProcessGroup) {
	const pgid = readGroup();
	const group = pgid === undefined ? "the agent's process group" : `the agent's process group (${pgid})`;
	return (
		`${GROUP_SIGNAL_NOTICE_TAG} This command signals a process group. Children of ${api} share ${group}, so ` +
		"signalling that group can stop this session. Start background jobs with Bun.spawn or child_process.spawn, " +
		"which give them their own group, or signal them by pid.\n"
	);
}

let cachedGroup;

// One bounded `ps` lookup per kernel; a missing `ps` or a failed run only drops the number from the notice.
export function agentProcessGroup(spawnSync = globalThis.Bun?.spawnSync) {
	if (cachedGroup !== undefined) return cachedGroup || undefined;
	let text = "";
	try {
		const result = spawnSync?.(["ps", "-o", "pgid=", "-p", String(process.pid)], { timeout: 2_000 });
		text = result?.success ? String(result.stdout).trim() : "";
	} catch {
		text = "";
	}
	cachedGroup = /^\d+$/u.test(text) ? text : "";
	return cachedGroup || undefined;
}

export function shellCommandText(strings, expressions) {
	if (!Array.isArray(strings)) return String(strings ?? "");
	return strings.reduce((text, part, index) => text + part + (index < expressions.length ? String(expressions[index]) : ""), "");
}

const SCANNED_SPAWNERS = ["exec", "execFile", "execSync", "execFileSync", "spawnSync"];

function commandTextOf(name, args) {
	if (name === "exec" || name === "execSync") return String(args[0]);
	return [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
}

export function noticeChildProcessGroupSignals(emitText, isActive) {
	const childProcess = process.getBuiltinModule("node:child_process");
	const originals = new Map();
	for (const name of SCANNED_SPAWNERS) {
		const original = childProcess[name];
		if (typeof original !== "function") continue;
		originals.set(name, original);
		const scanned = function scannedSpawner(...args) {
			try {
				if (isActive() && signalsProcessGroup(commandTextOf(name, args))) {
					emitText("stderr", groupSignalNotice(`child_process.${name}`));
				}
			} catch {
				// The notice is advisory; the call itself always runs.
			}
			return original.apply(this, args);
		};
		// Every own property, symbols included: `util.promisify.custom` is what makes promisify(exec) resolve to
		// { stdout, stderr }.
		for (const key of Reflect.ownKeys(original)) {
			if (key === "length" || key === "name" || key === "prototype") continue;
			const descriptor = Object.getOwnPropertyDescriptor(original, key);
			if (descriptor) Object.defineProperty(scanned, key, descriptor);
		}
		childProcess[name] = scanned;
	}
	return () => {
		for (const [name, original] of originals) childProcess[name] = original;
	};
}
