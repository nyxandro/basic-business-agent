// The machine as Linux shows it in /proc: memory and CPU of a process and its children, free memory.
import { readdirSync, readFileSync } from 'node:fs';

// Clock ticks a second of /proc/<pid>/stat (getconf CLK_TCK, 100 on Linux).
export const TICKS_PER_SECOND = 100;

// The fields of /proc/<pid>/stat after the name in parentheses (which may hold spaces).
function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

// Time on the CPU, user and system, in ticks.
export function cpuTicks(pid: number): number {
  const fields = statFields(pid);
  return Number(fields[11]) + Number(fields[12]);
}

// Resident memory in MB; 0 for a process gone meanwhile.
export function rssMb(pid: number): number {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
}

export const freeMb = (): number => Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024;

// Every process started by `root`, at any depth: the sandbox, its programs, LibreOffice.
export function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      parent.set(Number(name), Number(statFields(Number(name))[1]));
    } catch {
      // The process ended between the listing and the reading.
    }
  }
  const out: number[] = [];
  const walk = (pid: number): void => {
    for (const [child, of] of parent) {
      if (of !== pid) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}
