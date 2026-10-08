// senpi#2353: Windows never rewrites a process's ParentProcessId when its parent exits, and it reuses pids
// quickly. On a hosted runner, wininit.exe, csrss.exe and explorer.exe name parents that are long gone,
// and the runner's own Runner.Listener/Runner.Worker descend from wininit.exe. A walk that trusts
// ParentProcessId alone adopts all of them the moment one of Bun's Chrome processes is handed such a
// recycled pid, and the retirement then force-kills the runner. A process only counts as a child when
// it started after the parent it names.

export interface WindowsProcessRow {
	readonly pid: number;
	readonly parentPid: number;
	readonly createdAt: bigint;
	readonly bunChromeFlag: boolean;
}

/**
 * PowerShell that prints one `pid parentPid createdFileTime flag` line per process, leaving out the
 * listing's own PowerShell (its command line names the flag). A process without a readable creation
 * time prints 0, so it never counts as the child of a process that has one.
 */
export const WINDOWS_PROCESS_ROWS = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {
$created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
$flag = if ($_.CommandLine -like '*--remote-debugging-pipe*') { 1 } else { 0 }
"{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $created, $flag }`;

export function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
	const rows: WindowsProcessRow[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const [pidText, parentText, createdText, flagText] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !/^\d+$/u.test(createdText ?? ""))
			continue;
		rows.push({ pid, parentPid, createdAt: BigInt(createdText ?? "0"), bunChromeFlag: flagText === "1" });
	}
	return rows;
}

export function bunChromeTree(rows: readonly WindowsProcessRow[], ownerPid: number): number[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const startedAfter = (child: WindowsProcessRow, parentPid: number): boolean => {
		const parent = byPid.get(parentPid);
		return parent !== undefined && child.createdAt >= parent.createdAt;
	};
	const tree = new Set<number>();
	for (const row of rows) {
		if (row.parentPid === ownerPid && row.bunChromeFlag && startedAfter(row, ownerPid)) tree.add(row.pid);
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of rows) {
			if (tree.has(row.pid) || !tree.has(row.parentPid) || !startedAfter(row, row.parentPid)) continue;
			tree.add(row.pid);
			grew = true;
		}
	}
	return [...tree];
}
