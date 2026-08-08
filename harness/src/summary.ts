// Summary reporter: per-test-directory counts of command outcomes.

import type { FileResult } from "./runner.ts";

export interface DirStats {
  commands: number;
  executed: number;
  passed: number;
  failed: number;
  xfail: number;
  pendingRuntime: number;
  pendingCapability: number;
  unsupportedDirective: number;
}

function emptyStats(): DirStats {
  return {
    commands: 0,
    executed: 0,
    passed: 0,
    failed: 0,
    xfail: 0,
    pendingRuntime: 0,
    pendingCapability: 0,
    unsupportedDirective: 0,
  };
}

export class Summary {
  readonly dirs: Map<string, DirStats> = new Map();

  /** `dir` is the test-suite subdirectory, e.g. "binary" or "validation".
   * `isXfail(r)` classifies an otherwise-failed command as a known,
   * checked-in xfail rather than an unexpected failure. */
  add(
    dir: string,
    file: FileResult,
    isXfail: (r: FileResult["results"][number]) => boolean = () => false,
  ): void {
    let stats = this.dirs.get(dir);
    if (stats === undefined) {
      stats = emptyStats();
      this.dirs.set(dir, stats);
    }
    for (const r of file.results) {
      stats.commands++;
      switch (r.status) {
        case "passed":
          stats.executed++;
          stats.passed++;
          break;
        case "failed":
          stats.executed++;
          if (isXfail(r)) stats.xfail++;
          else stats.failed++;
          break;
        case "skipped":
          if (r.reason === "pending-runtime") stats.pendingRuntime++;
          else if (r.reason === "pending-capability") stats.pendingCapability++;
          else stats.unsupportedDirective++;
          break;
      }
    }
  }

  total(): DirStats {
    const t = emptyStats();
    for (const s of this.dirs.values()) {
      t.commands += s.commands;
      t.executed += s.executed;
      t.passed += s.passed;
      t.failed += s.failed;
      t.xfail += s.xfail;
      t.pendingRuntime += s.pendingRuntime;
      t.pendingCapability += s.pendingCapability;
      t.unsupportedDirective += s.unsupportedDirective;
    }
    return t;
  }

  format(): string {
    const headers = [
      "directory",
      "commands",
      "executed",
      "passed",
      "failed",
      "xfail",
      "pending-runtime",
      "pending-capability",
      "unsupported-directive",
    ];
    const row = (name: string, s: DirStats): string[] => [
      name,
      String(s.commands),
      String(s.executed),
      String(s.passed),
      String(s.failed),
      String(s.xfail),
      String(s.pendingRuntime),
      String(s.pendingCapability),
      String(s.unsupportedDirective),
    ];
    const rows = [...this.dirs.keys()].sort().map((dir) =>
      row(dir, this.dirs.get(dir)!)
    );
    rows.push(row("TOTAL", this.total()));

    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length))
    );
    const line = (cells: string[]) =>
      cells.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))
        .join("  ");
    const sep = widths.map((w) => "-".repeat(w)).join("  ");
    return [line(headers), sep, ...rows.map(line)].join("\n");
  }
}
