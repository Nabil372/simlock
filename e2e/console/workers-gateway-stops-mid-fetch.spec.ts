import type { Locator, Page, Route } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";

/**
 * why: reproduces #642. The workers page's response helpers (`answerWithoutLoad`, `answerMemory`)
 * answer the page's re-reads of `/v1/workers` by fetching them from the gateway through
 * `route.fetch()`, and the page re-reads every second. A re-read intercepted but not yet fetched
 * when the test's `finally` disposes the fleet gets a refused connect — a listener destroyed
 * mid-request reads the same way as a socket hang up — and Playwright attributes the handler's
 * rejection to the test, so the spec dies on the helper's `route.fetch()` line although every
 * assertion it made had passed. The lane races that window by accident; this holds it open: the
 * next re-read is parked inside the handler before it fetches, the gateway's listener is confirmed
 * gone, and only then is the parked fetch let go. The park is the injection; every other line is
 * the lane's own.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function openConsole(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
}

function workerRows(page: Page): Locator {
  return page.getByRole("list", { name: "Workers", exact: true }).getByRole("listitem");
}

async function askForWorkerList(page: Page, daemon: RunningDaemon): Promise<number> {
  return page.evaluate(
    (bearer) =>
      fetch("/v1/workers", { headers: { authorization: bearer } }).then(
        (response) => response.status,
        () => 0,
      ),
    `Bearer ${daemon.tokens.operator}`,
  );
}

async function listenerIsGone(daemon: RunningDaemon): Promise<boolean> {
  try {
    return (await fetch(new URL("/v1/healthz", daemon.url))).status >= 400;
  } catch {
    return true;
  }
}

test.describe("the workers page response helper against a gateway whose listener stops", () => {
  test("the re-read whose gateway listener stops between its interception and the helper's fetch is dropped by the helper instead of escaping it", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    const escaped: string[] = [];
    let answeredAfterInjection = 0;
    let parkNext = false;
    let parkedSeen = false;
    let parkedArrived = { resolve: () => {} };
    let releaseParked = { resolve: () => {} };
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = { resolve };
    });
    const released = new Promise<void>((resolve) => {
      releaseParked = { resolve };
    });
    let lastListed: { workers: Record<string, unknown>[] } | undefined;
    // why: the lane's `answerWithoutLoad` verbatim but for the park, so the refused connect is the
    // lane's accident and not a helper of this test's own invention.
    const answerWithoutLoad = async (route: Route): Promise<void> => {
      if (parkNext && !parkedSeen) {
        parkedSeen = true;
        parkNext = false;
        parkedArrived.resolve();
        await released;
      }
      const response = await route.fetch();
      const listed = (await response.json()) as { workers: Record<string, unknown>[] };
      for (const worker of listed.workers) delete worker.load;
      lastListed = listed;
      await route.fulfill({ json: listed, response });
    };
    await page.route(
      (url) => url.pathname === "/v1/workers",
      async (route: Route) => {
        try {
          if (parkedSeen && lastListed !== undefined) {
            // why: later polls are answered from the last payload, so the only fetch made against
            // the dead listener is the parked one this test names.
            answeredAfterInjection += 1;
            await route.fulfill({ json: lastListed });
            return;
          }
          await answerWithoutLoad(route);
        } catch (error: unknown) {
          // why: Playwright fails the whole test on this rejection at the handler line; the test
          // records it and keeps going so the failure names the refusal, not a timeout.
          escaped.push(String(error).split("\n")[0] ?? "");
          await route.abort().catch(() => undefined);
        }
      },
    );

    try {
      await openConsole(page, fleet.gateway);
      await expect(workerRows(page)).toHaveCount(2);

      // why: the same helper answers through this gateway while it is up, so a refusal below is the
      // listener being gone and not a route that never worked (testing rule 2).
      expect(await askForWorkerList(page, fleet.gateway)).toBe(200);
      expect(escaped).toEqual([]);

      parkNext = true;
      const asked = askForWorkerList(page, fleet.gateway);
      await arrived;
      await disposeFleet(fleet);
      await waitFor(() => listenerIsGone(fleet.gateway), {
        interval: 50,
        label: "the gateway's HTTP listener stopped",
        timeout: 10_000,
      });
      releaseParked.resolve();
      await waitFor(() => answeredAfterInjection > 0, {
        interval: 50,
        label: "the first poll answered after the injection",
        timeout: 10_000,
      });

      // why: the body only waits and re-asserts from here, as the lane's does around its
      // `finally`; `asked` is drained to keep the page's promise from outliving the test.
      await asked;
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      expect(
        escaped,
        "the helper must answer or quietly drop the re-read whose gateway stops mid-request, not let the connect failure escape it",
      ).toEqual([]);
    } finally {
      await disposeFleet(fleet).catch(() => undefined);
    }
  });
});
