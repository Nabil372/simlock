// why: `main.test.ts` mocks `connect.js`, so this loop's own failure is asserted nowhere else --
// #663 found the CLI's copy of this loop reporting the same event under a different code.
import { describe, expect, it } from "vitest";

import { FakeClock, FakeDaemonLauncher, MemoryIpcTransport } from "../ports/index.js";
import { connectWithAutoLaunch } from "./connect.js";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("MCP: auto-launch's failed start (#672)", () => {
  it("reports the startup it gave up on as DAEMON_STARTUP_FAILED", async () => {
    // why: nothing ever listens, so this loop can end only on the deadline it is given; the
    // deadline is passed in rather than defaulted so the test waits on the code's reason for
    // failing, never on how long that reason takes to arrive.
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher();
    let done = false;
    const connecting = connectWithAutoLaunch({
      clock,
      ipc: new MemoryIpcTransport(),
      launcher,
      principal: "agent-1",
      socketPath: "/simlock/daemon.sock",
      startupTimeoutMs: 1_000,
    });
    void connecting.catch(() => {
      done = true;
    });
    await settle();
    while (!done && clock.now() < 1_000) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(done, `still polling at ${String(clock.now())}ms, past the deadline it was given`).toBe(
      true,
    );
    await expect(connecting).rejects.toMatchObject({
      code: "DAEMON_STARTUP_FAILED",
      message: expect.stringContaining("Timed out starting simlock daemon"),
    });
    expect(launcher.launches).toBe(1);
  });
});
