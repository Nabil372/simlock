import { describe, expect, it } from "vitest";

import { withDaemon } from "./env.js";

describe("cliBackground firstStdoutLine", () => {
  it("rejects with the exit code and stderr, not the timeout, when the process exits without a stdout line", async () => {
    const env = await withDaemon();

    await expect(env.cliBackground(["lease", "--bogus"]).firstStdoutLine(60_000)).rejects.toThrow(
      /^simlock lease --bogus exited with code 2, signal null before printing a stdout line; stderr: .*Unknown option '--bogus'/,
    );
  });

  it("rejects a call made after the process has already exited without a stdout line", async () => {
    const env = await withDaemon();
    const handle = env.cliBackground(["lease", "--bogus"]);
    await handle.waitForExit();

    await expect(handle.firstStdoutLine(60_000)).rejects.toThrow(/exited with code 2/);
  });

  it("resolves the line a process printed just before exiting, for a call made before or after the exit", async () => {
    const env = await withDaemon();
    const handle = env.cliBackground(["--help"]);
    const beforeExit = handle.firstStdoutLine(60_000);

    expect((await handle.waitForExit()).code).toBe(0);
    await expect(beforeExit).resolves.toBe("Usage: simlock <command> [options]");
    await expect(handle.firstStdoutLine(60_000)).resolves.toBe(
      "Usage: simlock <command> [options]",
    );
  });
});
