import type { Response } from "@playwright/test";

import { expect, startDaemon, signIn, test } from "./fixtures.js";

/**
 * why: reproduces #1005. The Events tab test in `workers.spec.ts` reads the body of every
 * `/v1/events` response with a `page.on("response")` listener that calls `void response.json()`
 * and never awaits it, and the listener stays on for the rest of the test. The single host's
 * Events tab, the test's last page, asks for its first older page (`before=…&limit=100`) as it
 * opens; the test's last assertion does not need that answer, so the test can reach its `finally`
 * while the body is unread. `host.dispose()` closes the page first, the read rejects with "Target
 * page, context or browser has been closed", and Playwright fails the test on that rejection
 * although every assertion passed. The lane hits that window by accident under load; this holds
 * it open: the older-page read is parked before it reads, the host is disposed, and only then is
 * the read let go. The park is the injection; the read is the lane's own.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

test.describe("the workers page Events tab reader against a page closed under a read", () => {
  test("a /v1/events body still unread when host.dispose() closes the page is dropped by the Events tab test's reader instead of escaping it", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    const escaped: string[] = [];
    const answered: { readonly payload?: { readonly workerId?: string } }[] = [];
    const reads: Promise<void>[] = [];
    let parkOlder = false;
    let parkedArrived = (): void => {};
    let releaseParked = (): void => {};
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseParked = resolve;
    });
    // why: the lane's read verbatim, but for the park and for recording the rejection: Playwright
    // fails the whole test on it at the read's line, so it is kept to fail on a named assertion.
    const read = (response: Response): Promise<void> =>
      response.json().then((body: { events?: (typeof answered)[number][] }) => {
        answered.push(...(body.events ?? []));
      });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname !== "/v1/events") return;
      const park = parkOlder && url.searchParams.has("before");
      if (park) parkOlder = false;
      reads.push(
        (async () => {
          if (park) {
            parkedArrived();
            await released;
          }
          await read(response);
        })().catch((error: unknown) => {
          escaped.push(String(error).split("\n")[0] ?? "");
        }),
      );
    });

    try {
      const granted = await host.cli([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--detach",
        "--agent-id",
        "console-e2e-host",
      ]);
      expect(granted.code, granted.stderr).toBe(0);
      const listed = await host.cli(["worker", "list", "--json"]);
      expect(listed.code, listed.stderr).toBe(0);
      const workerId = (listed.json as { workers: readonly { id: string }[] }).workers[0]?.id ?? "";
      expect(workerId).not.toBe("");
      const eventsTab = new URL(`/fleet/${encodeURIComponent(workerId)}?tab=events`, host.url).href;
      const forHost = page.getByRole("list", { name: "Events for this worker" });

      await page.goto(host.url);
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      // why: the same read lands its events while the page is open, so a rejection below is the
      // page closing under it and not a read that never worked (testing rule 2).
      const older = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/v1/events" &&
          new URL(response.url()).searchParams.has("before"),
      );
      await page.goto(eventsTab);
      await expect(forHost.getByText("lease.granted").first()).toBeVisible();
      await older;
      await Promise.all(reads);
      expect(answered.length).toBeGreaterThan(0);
      expect(escaped).toEqual([]);

      parkOlder = true;
      await page.goto(eventsTab);
      await expect(forHost.getByText("lease.granted").first()).toBeVisible();
      await arrived;
      await host.dispose();
      expect(page.isClosed()).toBe(true);
      releaseParked();
      await Promise.all(reads);

      expect(
        escaped,
        "the reader must read or quietly drop a /v1/events body the page closed under, not let the rejection escape it",
      ).toEqual([]);
    } finally {
      releaseParked();
      await host.dispose().catch(() => undefined);
    }
  });
});
