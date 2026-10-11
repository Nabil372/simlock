import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mutate.mjs");

const REPORT = JSON.stringify({
  files: {
    "src/a.ts": {
      mutants: [
        {
          status: "Killed",
          mutatorName: "BooleanLiteral",
          replacement: "true",
          location: { start: { line: 1 } },
        },
        {
          status: "Survived",
          mutatorName: "BooleanLiteral",
          replacement: "false",
          location: { start: { line: 2 } },
        },
      ],
    },
  },
});

interface Repo {
  readonly dir: string;
  readonly log: string;
  readonly bin: string;
  git(...args: string[]): string;
  commit(files: Record<string, string>): void;
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "mutate-"));
  const dir = join(root, "clone");
  const bin = join(root, "bin");
  const log = join(root, "stryker.log");
  mkdirSync(dir);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\necho "$@" >> "${log}"\nmkdir -p .stryker-tmp/report\necho '${REPORT}' > .stryker-tmp/report/mutation.json\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  };
  git("init", "-q", "-b", "base");
  commit({ "src/a.ts": "export const a = 1;\n" });
  git("switch", "-q", "-c", "work");
  commit({ "src/a.ts": "export const a = 1;\nexport const b = true;\n" });
  return { dir, log, bin, git, commit };
}

function mutate(r: Repo, cwd = r.dir) {
  const run = spawnSync(process.execPath, [SCRIPT, "base"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${r.bin}:/usr/bin:/bin` },
  });
  return { code: run.status, output: run.stdout + run.stderr };
}

const strykerRuns = (r: Repo) =>
  existsSync(r.log) ? readFileSync(r.log, "utf8").trim().split("\n") : [];

describe("mutate.mjs", () => {
  it("runs Stryker on the changed lines with the branch's incremental file, and prints the mutants left alive", () => {
    const r = repo();
    const first = r.git("rev-list", "--reverse", "base..HEAD").split("\n")[0];
    const common = r.git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const { code, output } = mutate(r);

    expect(strykerRuns(r)).toEqual([
      `exec stryker run --mutate src/a.ts:2-2 --incremental --incrementalFile ${common}/mutate/${first}.json`,
    ]);
    expect(output).toContain("2 mutants on 1 changed ranges; 1 alive.");
    expect(output).toContain("src/a.ts:2 Survived BooleanLiteral: false");
    expect(code).toBe(1);
  });

  it("reprints the last result without running Stryker when nothing under src/ changed since, even after a commit elsewhere", () => {
    const r = repo();
    mutate(r);
    r.commit({ "docs/notes.md": "A doc-only fix.\n" });

    const { code, output } = mutate(r);

    expect(strykerRuns(r)).toHaveLength(1);
    expect(output).toContain("Nothing under src/ or ui/src/ changed since this branch's last run");
    expect(output).toContain("src/a.ts:2 Survived BooleanLiteral: false");
    expect(code).toBe(1);
  });

  it("runs Stryker again after a commit that changes src/, and when src/ has uncommitted changes", () => {
    const r = repo();
    mutate(r);
    r.commit({ "src/a.ts": "export const a = 1;\nexport const b = false;\n" });
    mutate(r);
    writeFileSync(join(r.dir, "src/a.ts"), "export const a = 2;\nexport const b = false;\n");

    mutate(r);

    expect(strykerRuns(r)).toHaveLength(3);
  });

  it("shares the last result with another worktree of the branch under another local branch name", () => {
    const r = repo();
    mutate(r);
    const other = join(dirname(r.dir), "other");
    r.git("worktree", "add", "-q", "-b", "fix-run", other, "work");

    const { output } = mutate(r, other);

    expect(strykerRuns(r)).toHaveLength(1);
    expect(output).toContain("Nothing under src/ or ui/src/ changed since this branch's last run");
  });
});
