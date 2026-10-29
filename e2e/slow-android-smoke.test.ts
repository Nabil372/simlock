import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon, type TestEnv } from "./helpers/index.js";
import { DEVICE_READY_MS, waitFor } from "./helpers/wait.js";

const execFileAsync = promisify(execFile);
const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

/** Simlock's emulators live on Simlock's own adb server, so that is the one to ask. */
async function adbDevices(serverPort: number): Promise<string[]> {
  const adb = join(ANDROID_HOME, "platform-tools", "adb");
  const { stdout } = await execFileAsync(adb, ["-P", String(serverPort), "devices"]).catch(() => ({
    stdout: "",
  }));
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("device"))
    .map((line) => line.split(/\s+/)[0] as string);
}

async function avdManagerList(): Promise<string[]> {
  const avdmanager = join(ANDROID_HOME, "cmdline-tools", "latest", "bin", "avdmanager");
  const binary = existsSync(avdmanager)
    ? avdmanager
    : join(ANDROID_HOME, "tools", "bin", "avdmanager");
  const { stdout } = await execFileAsync(binary, ["list", "avd"]).catch(() => ({ stdout: "" }));
  return [...stdout.matchAll(/Name:\s*(\S+)/g)].map((match) => match[1] as string);
}

// why: Simlock's adb server may list other emulators on this machine, so the leased one is the
// serial whose `emu avd name` is the grant's AVD; its console port is in that serial.
async function leasedSerial(env: TestEnv, avdName: string): Promise<string> {
  const devices = await env.cli(["adb", "devices"]);
  for (const [, serial] of devices.stdout.matchAll(/^(emulator-\d+)\s+device$/gm)) {
    const name = await env.cli(["adb", "-s", serial as string, "emu", "avd", "name"]);
    if (name.stdout.split(/\r?\n/)[0]?.trim() === avdName) return serial as string;
  }
  throw new Error(`no emulator named ${avdName} in simlock adb devices: ${devices.stdout}`);
}

function grpcPortOf(serial: string): number {
  return Number(serial.slice("emulator-".length)) + 3000;
}

// why: lsof lists every socket listening on the port, on any address family, so a bind beyond
// loopback shows up as a listener. It exits 1 with no output when nothing listens, so only that
// is an empty list; any other failure is thrown rather than read as a closed port.
async function listenersOn(port: number): Promise<string[]> {
  const stdout = await execFileAsync("lsof", [
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fn",
  ]).then(
    (result) => result.stdout,
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        error.stderr === ""
      ) {
        return "";
      }
      throw error;
    },
  );
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function beyondLoopback(listeners: readonly string[], port: number): string[] {
  return listeners.filter(
    (listener) => listener !== `127.0.0.1:${port}` && listener !== `[::1]:${port}`,
  );
}

// why: The kernel draws its boot id once per boot, and a snapshot holds the memory it is in, so
// once the emulator has stopped, the same id on the next boot means that boot restored the
// snapshot instead of booting cold.
async function bootId(env: TestEnv, serial: string): Promise<string> {
  const read = await env.cli([
    "adb",
    "-s",
    serial,
    "shell",
    "cat",
    "/proc/sys/kernel/random/boot_id",
  ]);
  expect(read.code, `reading the boot id failed: ${read.stderr}`).toBe(0);
  return read.stdout.trim();
}

async function leasePixel9(env: TestEnv): Promise<{ avdName: string; leaseId: string }> {
  const lease = await env.cli(
    [
      "lease",
      "--platform",
      "android",
      "--device",
      "Pixel 9",
      "--agent-id",
      "android-grpc",
      "--detach",
    ],
    { timeout: DEVICE_READY_MS },
  );
  expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
  const grant = lease.json as { device: { driverDeviceId: string }; lease: { id: string } };
  return { avdName: grant.device.driverDeviceId, leaseId: grant.lease.id };
}

interface AndroidCatalogOutput {
  readonly platforms: readonly {
    readonly platform: string;
    readonly models: readonly string[];
    readonly runtimes: readonly string[];
    readonly modelClasses: Readonly<Record<string, string>>;
    readonly modelAliases: Readonly<Record<string, readonly string[]>>;
    readonly images?: readonly { runtime: string; tag: string; abi: string }[];
  }[];
}

function checkCatalog(output: AndroidCatalogOutput): void {
  const android = output.platforms.find((platform) => platform.platform === "android");
  if (android === undefined) {
    throw new Error("simlock catalog reported no android platform -- SDK discovery failed");
  }
  expect(android.models.length).toBeGreaterThan(0);
  // The class comes from the device profile's tag, read off this host's avdmanager.
  expect(android.modelClasses["Pixel 8"]).toBe("phone");
  expect(android.modelClasses["Television (1080p)"]).toBe("tv");

  const images = android.images ?? [];
  expect(images.length, "expected the installed system images to be listed").toBeGreaterThan(0);
  for (const image of images) {
    expect(android.runtimes).toContain(image.runtime);
    const path = join(
      ANDROID_HOME,
      "system-images",
      `android-${image.runtime}`,
      image.tag,
      image.abi,
    );
    expect(existsSync(path), `listed image ${JSON.stringify(image)} is not installed`).toBe(true);
  }

  expect(android.models[0]).toBe("Pixel 9");
  expect(android.modelClasses["Pixel 9"]).toBe("phone");
  expect(android.modelAliases["Pixel 9"]).toEqual(["pixel_9"]);
}

// Real emulator boots are slow and this SDK layout is host-specific, so this lane is
// gated on an actually-discoverable Android SDK rather than just `process.platform`.
describe.skipIf(!hasAndroidSdk)(
  "Android smoke (real emulator/adb)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "catalog lists Simlock's Pixel 9 first, a cold lease of Pixel 9 boots a real emulator with the library screen size, and a shut-down emulator reports erasableReadable:false with no crash or false provenance finding",
      { timeout: 420_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 } },
        });
        const { adbServerPort } = env;
        if (adbServerPort === undefined) {
          throw new Error("the real-SDK lane must allocate its own adb server port");
        }
        try {
          const catalog = await env.cli(["catalog", "--json", "--platform", "android"]);
          expect(catalog.code).toBe(0);
          checkCatalog(catalog.json as AndroidCatalogOutput);

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "android",
              "--device",
              "Pixel 9",
              "--agent-id",
              "android-smoke",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const grant = lease.json as {
            device: { driverDeviceId: string };
            environment: Record<string, string>;
            lease: { id: string };
          };
          // On Android the driver's device id is the AVD name (the driver refuses a record
          // where they differ), so this is the name to look for on disk and in avdmanager.
          const avdName = grant.device.driverDeviceId;

          // Without this, a holder's `adb` talks to the shared server, which by design
          // cannot see a Simlock emulator at all (ADR 0001, decision 7).
          expect(grant.environment).toEqual({
            ANDROID_ADB_SERVER_PORT: String(adbServerPort),
          });

          // `simlock adb` is the same scoping, made for the caller, and the refusals are
          // what keep the wrapper from handing back the capability containment removed.
          const wrapped = await env.cli(["adb", "devices"]);
          expect(wrapped.code, `simlock adb failed: ${wrapped.stderr}`).toBe(0);
          expect(wrapped.stdout).toContain("emulator-");

          const size = await env.cli(["adb", "shell", "wm", "size"]);
          expect(size.stdout).toContain("Physical size: 1080x2424");
          const density = await env.cli(["adb", "shell", "wm", "density"]);
          expect(density.stdout).toContain("Physical density: 420");

          const refused = await env.cli(["adb", "kill-server"]);
          expect(refused.code, "simlock adb kill-server must be refused, not run").toBe(2);
          expect(refused.error?.code).toBe("USAGE");

          // The adb serial (e.g. "emulator-5554") is a driver-internal detail simlock
          // deliberately keeps opaque outside drivers/android (architecture.md #2) --
          // the grant names simlock's own AVD, not the adb serial, so this only
          // asserts that *an* emulator is actually online, not which one by serial.
          const onlineSerials = await adbDevices(adbServerPort);
          expect(
            onlineSerials.length,
            "expected at least one booted emulator visible to Simlock's own adb server",
          ).toBeGreaterThan(0);

          // Ownership is root membership, not a name: the AVD must be inside the root this
          // env's Simlock owns, and must not be in the user's own AVD home at all.
          expect(
            existsSync(join(env.home, "devices", "android", `${avdName}.avd`)),
            "expected the AVD to live inside Simlock's own device root",
          ).toBe(true);
          const avdNames = await avdManagerList();
          expect(
            avdNames.includes(avdName),
            "a Simlock AVD must not appear in the user's own AVD home",
          ).toBe(false);

          const release = await env.cli(["release", grant.lease.id]);
          expect(release.code, `release failed: ${release.stderr}`).toBe(0);

          // Force the idle-shutdown rule (see flow 9) rather than waiting on the slow
          // periodic tick, so the emulator process actually stops.
          await waitFor(
            async () => {
              await env.cli(["cleanup"]);
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some((row) => row.driverDeviceId === avdName && row.state === "shutdown");
            },
            { timeout: 60_000, interval: 500, label: "device demoted to shutdown" },
          );

          // With the emulator process stopped, the on-device erasable mark is
          // unreachable -- `doctor` must not crash on that, must not report it as an
          // erase (unreadable is not the same as absent), and `list` must render fine.
          const doctorReport = await env.cli(["doctor"]);
          expect(doctorReport.code).toBe(0);
          const findings = (
            doctorReport.json as { findings: { kind: string; deviceId?: string }[] }
          ).findings;
          const devices = (await env.cli(["list", "--devices"])).json as {
            id: string;
            driverDeviceId: string;
          }[];
          const registryId = devices.find((device) => device.driverDeviceId === avdName)?.id;
          expect(
            findings.some(
              (finding) =>
                finding.kind === "foreign-provenance-change" && finding.deviceId === registryId,
            ),
            "a stopped emulator's unreadable mark must not be reported as a foreign-provenance-change",
          ).toBe(false);

          const list = await env.cli(["list", "--devices"]);
          expect(list.code).toBe(0);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );

    it(
      "a leased emulator's gRPC port, its console port plus 3000, listens on loopback only, and with the pool off the next lease after its release boots it from its clean baseline snapshot with that port listening again",
      { timeout: 900_000 },
      async () => {
        // why: With the pool off the released emulator is the only device the next lease can boot.
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 }, warmPool: { enabled: false } },
        });
        try {
          const first = await leasePixel9(env);
          const serial = await leasedSerial(env, first.avdName);
          const port = grpcPortOf(serial);
          const listeners = await listenersOn(port);
          expect(listeners.length, `nothing listens on port ${port}`).toBeGreaterThan(0);
          expect(beyondLoopback(listeners, port)).toEqual([]);
          const capturedBoot = await bootId(env, serial);

          const release = await env.cli(["release", first.leaseId]);
          expect(release.code, `release failed: ${release.stderr}`).toBe(0);
          await waitFor(
            async () => {
              await env.cli(["cleanup"]);
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some(
                (row) => row.driverDeviceId === first.avdName && row.state === "shutdown",
              );
            },
            { timeout: 60_000, interval: 500, label: "device demoted to shutdown" },
          );
          await waitFor(async () => (await listenersOn(port)).length === 0, {
            timeout: 60_000,
            interval: 500,
            label: `the stopped emulator's port ${port} closed`,
          });

          const second = await leasePixel9(env);
          expect(second.avdName).toBe(first.avdName);
          const secondSerial = await leasedSerial(env, second.avdName);
          expect(
            await bootId(env, secondSerial),
            "the boot after the shutdown was not the snapshot",
          ).toBe(capturedBoot);
          expect(secondSerial).toBe(serial);
          const relisteners = await listenersOn(port);
          expect(relisteners.length, `nothing listens on port ${port}`).toBeGreaterThan(0);
          expect(beyondLoopback(relisteners, port)).toEqual([]);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
