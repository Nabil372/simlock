import { join } from "node:path";

import {
  DriverCrashError,
  type DriverRefusalReason,
  type PhysicalDriverDevice,
  type PhysicalInspection,
  type PresentPhysical,
  type ReclaimResult,
  uninstallPlan,
} from "../../core/index.js";
import type { Filesystem, IdGenerator, ProcessResult } from "../../ports/index.js";

export type DevicectlOutcome =
  | { readonly kind: "finished"; readonly result: ProcessResult }
  | { readonly kind: "timed-out" };

export type XcrunInvoker = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<DevicectlOutcome>;

export interface PhysicalHandlerOptions {
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly invoke: XcrunInvoker;
  readonly simlockHome: string;
}

const READ_LIMIT_MS = 30_000;
const UNINSTALL_LIMIT_MS = 60_000;
const MIN_OS_MAJOR = 17;

type Raw = Readonly<Record<string, unknown>>;

const FIELD_LOCATION: Readonly<Record<string, readonly [string, string | undefined]>> = {
  deviceType: ["hardwareProperties", "hardware"],
  developerModeStatus: ["deviceProperties", "state"],
  ecid: ["hardwareProperties", "hardware"],
  isMobileDeviceOnly: ["connectionProperties", undefined],
  marketingName: ["hardwareProperties", "hardware"],
  osVersionNumber: ["deviceProperties", "software"],
  pairingState: ["connectionProperties", "connection"],
  platform: ["hardwareProperties", "hardware"],
  productType: ["hardwareProperties", "hardware"],
  reality: ["hardwareProperties", "hardware"],
  serialNumber: ["hardwareProperties", "hardware"],
  transportType: ["connectionProperties", "connection"],
  udid: ["hardwareProperties", "hardware"],
};

function asRecord(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

/** why: devicectl 642.16 writes both keys but marks the deprecated one for removal, so `properties` is read only when it is absent. */
function fieldOf(entry: Raw, field: string): unknown {
  const location = FIELD_LOCATION[field];
  if (location === undefined) return entry[field];
  const [deprecated, group] = location;
  const old = asRecord(entry[deprecated])?.[field];
  if (old !== undefined) return old;
  if (group === undefined) return undefined;
  return asRecord(asRecord(entry["properties"])?.[group])?.[field];
}

function stringField(entry: Raw, field: string): string | undefined {
  const value = fieldOf(entry, field);
  return typeof value === "string" ? value : undefined;
}

/** why: JSON.parse rounds an ECID above 2^53, so it is read from the raw JSON text as a bigint. */
function parseDevicectlJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { readonly source?: string }) => {
    if (key === "ecid" && typeof value === "number" && context?.source !== undefined) {
      try {
        return BigInt(context.source);
      } catch {
        return value;
      }
    }
    return value;
  });
}

type Read =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly why: string };

function sameText(left: string | undefined, right: string): boolean {
  return left !== undefined && left.toLowerCase() === right.toLowerCase();
}

function ecidOf(id: string): bigint | undefined {
  if (/^[0-9]+$/.test(id) || /^0x[0-9a-f]+$/i.test(id)) return BigInt(id);
  return undefined;
}

function osMajor(version: string): number | undefined {
  const major = /^(\d+)/.exec(version)?.[1];
  return major === undefined ? undefined : Number(major);
}

function pickEntry(matches: readonly Raw[]): {
  readonly entry: Raw | undefined;
  readonly ambiguous: boolean;
} {
  const wired = matches.filter((entry) => fieldOf(entry, "transportType") === "wired");
  if (wired.length >= 2) return { ambiguous: true, entry: undefined };
  return { ambiguous: false, entry: wired[0] ?? matches[0] };
}

export class IosPhysicalHandler {
  readonly #options: PhysicalHandlerOptions;
  #reads = 0;

  constructor(options: PhysicalHandlerOptions) {
    this.#options = options;
  }

  async inspect(id: string): Promise<PhysicalInspection> {
    const listed = await this.#list();
    if (!listed.ok) return unreadable("devicectl list devices", listed.why);

    const ecid = ecidOf(id);
    const matches = listed.entries.filter(
      (entry) =>
        sameText(stringField(entry, "identifier"), id) ||
        sameText(stringField(entry, "udid"), id) ||
        sameText(stringField(entry, "serialNumber"), id) ||
        (ecid !== undefined && fieldOf(entry, "ecid") === ecid),
    );
    const { entry, ambiguous } = pickEntry(matches);
    if (ambiguous) {
      return {
        enrollable: false,
        message: `Could not read the device: ${id} matches more than one device on USB.`,
        reason: "unreadable",
      };
    }
    if (entry === undefined) {
      return refused("not-connected", `${id} is not connected: connect it by USB and try again.`);
    }
    return this.#checkEntry(id, entry);
  }

  async #checkEntry(id: string, entry: Raw): Promise<PhysicalInspection> {
    const transport = fieldOf(entry, "transportType");
    if (transport === "sameMachine" || fieldOf(entry, "reality") === "simulated") {
      return refused("virtual-device", `${id} is a simulator, not a physical device.`);
    }
    if (typeof transport !== "string") return missing(id, "transportType");
    if (transport !== "wired") {
      return refused(
        "network-only",
        `${id} is only reachable over the network: connect it by USB.`,
      );
    }
    const udid = stringField(entry, "udid");
    const platform = stringField(entry, "platform");
    const deviceType = stringField(entry, "deviceType");
    const osVersion = stringField(entry, "osVersionNumber");
    const pairing = stringField(entry, "pairingState");
    if (udid === undefined) return missing(id, "udid");
    if (platform === undefined) return missing(id, "platform");
    if (deviceType === undefined) return missing(id, "deviceType");
    if (osVersion === undefined) return missing(id, "osVersionNumber");
    if (pairing === undefined) return missing(id, "pairingState");

    if (platform !== "iOS" || (deviceType !== "iPhone" && deviceType !== "iPad")) {
      return refused("unsupported-kind", `${id} is a ${deviceType} on ${platform}: not supported.`);
    }
    const mobileOnly = fieldOf(entry, "isMobileDeviceOnly");
    if (mobileOnly !== undefined && typeof mobileOnly !== "boolean") {
      return missing(id, "isMobileDeviceOnly");
    }
    const major = osMajor(osVersion);
    if (major === undefined) return missing(id, "osVersionNumber");
    if (major < MIN_OS_MAJOR || mobileOnly === true) {
      return refused("os-too-old", `${id} needs iOS 17 or later; it runs ${osVersion}.`);
    }
    if (pairing !== "paired") {
      return refused("untrusted", `${id} is not trusted: accept "Trust This Computer" on it.`);
    }
    const developerMode = stringField(entry, "developerModeStatus");
    if (developerMode === undefined) return missing(id, "developerModeStatus");
    if (developerMode !== "enabled") {
      return refused("developer-mode-off", `${id}: Developer Mode is off. Turn it on and retry.`);
    }

    const lock = await this.#lockRead(udid);
    if (!lock.ok) return unreadable("devicectl device info lockState", lock.why);
    if (lock.locked) return refused("locked", `${id} is locked: unlock it and try again.`);

    const apps = await this.#appsRead(udid);
    if (!apps.ok) return unreadable("devicectl device info apps", apps.why);
    const model = stringField(entry, "marketingName") ?? stringField(entry, "productType");
    if (model === undefined) return missing(id, "marketingName");
    return {
      apps: apps.bundles,
      class: deviceType === "iPad" ? "tablet" : "phone",
      driverDeviceId: udid,
      enrollable: true,
      model,
      osVersion,
    };
  }

  async listPresent(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    const absent = (driverDeviceId: string): PresentPhysical => ({
      driverDeviceId,
      present: false,
      reason: "not-present",
    });
    const listed = await this.#list();
    if (!listed.ok) return enrolledIds.map(absent);

    return Promise.all(
      enrolledIds.map(async (udid): Promise<PresentPhysical> => {
        const { entry, ambiguous } = pickEntry(
          listed.entries.filter((candidate) => sameText(stringField(candidate, "udid"), udid)),
        );
        if (ambiguous || entry === undefined) return absent(udid);
        if (fieldOf(entry, "transportType") !== "wired") return absent(udid);
        if (fieldOf(entry, "reality") === "simulated") return absent(udid);
        if (fieldOf(entry, "pairingState") !== "paired") {
          return { driverDeviceId: udid, present: false, reason: "untrusted" };
        }
        const osVersion = stringField(entry, "osVersionNumber");
        if (osVersion === undefined) return absent(udid);
        const lock = await this.#lockRead(udid);
        if (!lock.ok) return absent(udid);
        if (lock.locked) return { driverDeviceId: udid, present: false, reason: "locked" };
        return { driverDeviceId: udid, osVersion, present: true };
      }),
    );
  }

  async reclaim(device: PhysicalDriverDevice): Promise<ReclaimResult> {
    const apps = await this.#appsRead(device.deviceId);
    if (!apps.ok) {
      throw new DriverCrashError(
        `devicectl device info apps for ${device.deviceId} failed: ${apps.why}`,
      );
    }
    const plan = uninstallPlan(apps.bundles, device.enrolledApps);
    for (const bundle of plan.uninstall) {
      const argv = ["devicectl", "device", "uninstall", "app", "--device", device.deviceId, bundle];
      const outcome = await this.#options.invoke(argv, UNINSTALL_LIMIT_MS);
      if (outcome.kind === "timed-out") {
        throw new DriverCrashError(
          `devicectl uninstall of ${bundle} from ${device.deviceId} timed out after ${String(UNINSTALL_LIMIT_MS)}ms`,
        );
      }
      if (outcome.result.code !== 0) {
        throw new DriverCrashError(
          `devicectl uninstall of ${bundle} from ${device.deviceId} failed: ${outcome.result.stderr.trim()}`,
        );
      }
    }
    return { missingApps: plan.missing, state: "ready", strategy: "uninstall" };
  }

  async #list(): Promise<
    | { readonly ok: true; readonly entries: readonly Raw[] }
    | { readonly ok: false; readonly why: string }
  > {
    const read = await this.#read(["list", "devices"]);
    if (!read.ok) return read;
    const devices = asRecord(asRecord(read.json)?.["result"])?.["devices"];
    if (!Array.isArray(devices)) return { ok: false, why: "no result.devices list" };
    const entries: Raw[] = [];
    for (const device of devices as unknown[]) {
      const entry = asRecord(device);
      if (entry === undefined) return { ok: false, why: "a device entry is not an object" };
      entries.push(entry);
    }
    return { entries, ok: true };
  }

  async #lockRead(
    udid: string,
  ): Promise<
    { readonly ok: true; readonly locked: boolean } | { readonly ok: false; readonly why: string }
  > {
    const read = await this.#read(["device", "info", "lockState", "--device", udid]);
    if (!read.ok) return read;
    const passcodeRequired = asRecord(asRecord(read.json)?.["result"])?.["passcodeRequired"];
    if (typeof passcodeRequired !== "boolean") {
      return { ok: false, why: "no boolean passcodeRequired" };
    }
    return { locked: passcodeRequired, ok: true };
  }

  async #appsRead(
    udid: string,
  ): Promise<
    | { readonly ok: true; readonly bundles: readonly string[] }
    | { readonly ok: false; readonly why: string }
  > {
    const read = await this.#read(["device", "info", "apps", "--device", udid]);
    if (!read.ok) return read;
    const apps = asRecord(asRecord(read.json)?.["result"])?.["apps"];
    if (!Array.isArray(apps)) return { ok: false, why: "no result.apps list" };
    const bundles: string[] = [];
    for (const app of apps as unknown[]) {
      const bundle = asRecord(app)?.["bundleIdentifier"];
      if (typeof bundle !== "string") return { ok: false, why: "an app has no bundleIdentifier" };
      bundles.push(bundle);
    }
    return { bundles, ok: true };
  }

  async #read(args: readonly string[]): Promise<Read> {
    const { filesystem } = this.#options;
    const directory = join(this.#options.simlockHome, "devicectl");
    this.#reads += 1;
    const path = join(
      directory,
      `devicectl-${this.#options.idGenerator.generate()}-${String(this.#reads)}.json`,
    );
    try {
      await filesystem.mkdirp(directory);
      await filesystem.chmod(directory, 0o700);
      await filesystem.rm(path);
      const outcome = await this.#options.invoke(
        ["devicectl", ...args, "--json-output", path],
        READ_LIMIT_MS,
      );
      if (outcome.kind === "timed-out") {
        return { ok: false, why: `timed out after ${String(READ_LIMIT_MS)}ms` };
      }
      if (outcome.result.code !== 0) {
        return { ok: false, why: `exited ${String(outcome.result.code)}` };
      }
      return { json: parseDevicectlJson(await filesystem.readFile(path)), ok: true };
    } catch (error: unknown) {
      return { ok: false, why: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        await filesystem.rm(path);
      } catch {}
    }
  }
}

function refused(reason: DriverRefusalReason, message: string): PhysicalInspection {
  return { enrollable: false, message, reason };
}

function unreadable(read: string, why: string): PhysicalInspection {
  return {
    enrollable: false,
    message: `Could not read the device: \`${read}\` failed (${why}).`,
    reason: "unreadable",
  };
}

function missing(id: string, field: string): PhysicalInspection {
  return {
    enrollable: false,
    message: `Could not read the device ${id}: \`devicectl list devices\` has no usable ${field}.`,
    reason: "unreadable",
  };
}
