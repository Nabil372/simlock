import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import type { DaemonServer } from "../daemon/server.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { FakeAgentDevice } from "./testing.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const secrets = {
  one: "slk_test_agent_one",
  operator: "slk_test_operator",
  two: "slk_test_agent_two",
  worker: "slk_test_worker_join",
} as const;
const principals = { one: "tok_one", two: "tok_two" } as const;

const notAvailable = "agent-device is not available on this simlock: ";
const agentTokenOnly = "refused: agent-device through simlock needs an agent token";
const queueTimeoutMessage = "timed out waiting for a device; nothing was leased";
const defaultTtlMs = 600_000;
const maxTtlMs = 1_800_000;
const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;

const adminSession = {
  manageEventSubscription: () => undefined,
  principal: "admin",
  role: "admin",
} as const;

function sessionFor(principal: string) {
  return { manageEventSubscription: () => undefined, principal, role: "agent" } as const;
}

interface Envelope {
  readonly id?: unknown;
  readonly jsonrpc?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: { readonly code: string; readonly message: string };
  };
}

interface SetUpOptions {
  readonly drivers?: (clock: FakeClock) => FakeDriver[];
  readonly enabled?: boolean;
  readonly gatewayMode?: boolean;
  readonly maxRunning?: number;
  readonly slowStart?: boolean;
  readonly upstream?: FakeAgentDevice;
}

interface Rig {
  readonly clock: FakeClock;
  readonly daemon: DaemonServer;
  readonly driver: FakeDriver;
  readonly fake: FakeAgentDevice;
  readonly filesystem: MemoryFilesystem;
  readonly origin: string;
  readonly statePath: string;
  readonly started: Promise<DaemonServer>;
}

const phoneModels = {
  defaultModels: { phone: ["iPhone 16"] },
  modelClasses: { "iPhone 16": "phone" },
} as const;

function iosDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    defaultModels: { desktop: ["Mac"], phone: ["iPhone 16"], tv: ["Apple TV 4K"] },
    knownModels: ["iPhone 16", "iPhone 17 Pro", "Apple TV 4K", "Mac"],
    modelClasses: {
      "Apple TV 4K": "tv",
      "iPhone 16": "phone",
      "iPhone 17 Pro": "phone",
      Mac: "desktop",
    },
    platform: "ios",
  });
}

function androidDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["35"],
    clock,
    defaultModels: { phone: ["Pixel 8"] },
    knownModels: ["Pixel 8"],
    modelClasses: { "Pixel 8": "phone" },
    platform: "android",
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function setUp(options: SetUpOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-agent-device-edge-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(directory);
  const hasher = new CryptoTokenSecrets();
  const record = (id: string, secret: string, role: string) => ({
    createdAt: 0,
    hash: hasher.hash(secret),
    id,
    role,
  });
  await filesystem.writeFileAtomic(
    join(directory, "tokens.json"),
    JSON.stringify([
      record(principals.one, secrets.one, "agent"),
      record(principals.two, secrets.two, "agent"),
      record("tok_operator", secrets.operator, "operator"),
      record("tok_worker", secrets.worker, "worker"),
    ]),
  );
  const port = await freeLoopbackPort();
  const fake = options.upstream ?? new FakeAgentDevice();
  const drivers = options.drivers?.(clock) ?? [iosDriver(clock)];
  const statePath = join(directory, "state.json");
  const started = startDaemon({
    agentDeviceUpstream: fake,
    clock,
    configOverrides: {
      agentDevice: { enabled: options.enabled ?? true },
      capacity: { config: { maxRunning: options.maxRunning ?? 4 }, strategy: "fixed" },
      http: { enabled: true, host: "127.0.0.1", port },
      lease: { defaultTtlMs, maxTtlMs },
      ...(options.gatewayMode === true ? { mode: "gateway" as const } : {}),
    },
    dataDirectory: directory,
    drivers,
    filesystem,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    statePath,
    version: "1.2.3",
  } as StartDaemonOptions).then((daemon) => {
    runningDaemons.push(daemon);
    return daemon;
  });
  const origin = `http://127.0.0.1:${port}`;
  if (options.slowStart === true) {
    await waitListening(origin);
    return {
      clock,
      daemon: undefined as never,
      driver: drivers[0] as FakeDriver,
      fake,
      filesystem,
      origin,
      started,
      statePath,
    };
  }
  const daemon = await started;
  return {
    clock,
    daemon,
    driver: drivers[0] as FakeDriver,
    fake,
    filesystem,
    origin,
    started,
    statePath,
  };
}

async function waitListening(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await fetch(`${origin}/v1/healthz`);
      return;
    } catch {
      await sleep(5);
    }
  }
  throw new Error("the daemon never listened");
}

async function advance(rig: Rig, ms: number, step = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    rig.clock.advance(Math.min(step, ms - elapsed));
    await sleep(3);
  }
}

interface SendOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly token?: string | null;
}

function send(rig: Rig, path: string, options: SendOptions = {}): Promise<Response> {
  const token = options.token === undefined ? secrets.one : options.token;
  return fetch(`${rig.origin}/v1/agent-device${path}`, {
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function rpcBody(method: string, params: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

function rpc(
  rig: Rig,
  method: string,
  params: Record<string, unknown>,
  options: Omit<SendOptions, "body"> & { readonly id?: unknown } = {},
): Promise<Response> {
  return send(rig, "/rpc", { ...options, body: rpcBody(method, params, options.id ?? 1) });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(
    text.trimStart().startsWith("{"),
    `expected a JSON object body, got ${response.status} ${text.slice(0, 80)}`,
  ).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await bodyOf(response)) as Envelope;
}

const hex = (n: number): string => n.toString(16).padStart(32, "0");

function allocateParams(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...scope, leaseId: hex(n), platform: "ios", ttlMs: 120_000, ...extra };
}

function allocate(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.allocate", allocateParams(n, extra), options);
}

async function granted(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<void> {
  const answer = await envelopeOf(await allocate(rig, n, extra, options));
  expect(answer.result).toMatchObject({ ok: true });
}

function release(rig: Rig, n: number, options: Omit<SendOptions, "body"> = {}): Promise<Response> {
  return rpc(rig, "agent_device.lease.release", { ...scope, leaseId: hex(n) }, options);
}

function command(
  rig: Rig,
  name: string,
  n: number | undefined,
  options: Omit<SendOptions, "body"> = {},
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return rpc(
    rig,
    "agent_device.command",
    {
      command: name,
      ...(n === undefined ? {} : { meta: { leaseId: hex(n) } }),
      ...extra,
    },
    options,
  );
}

interface LeaseView {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  readonly lastRenewedAt: number;
}

async function leases(rig: Rig): Promise<readonly LeaseView[]> {
  return (await rig.daemon.dispatch(
    "list.get",
    { kind: "leases" },
    adminSession,
  )) as unknown as readonly LeaseView[];
}

async function waiting(
  rig: Rig,
): Promise<readonly { readonly id: string; readonly requesterId: string }[]> {
  return (await rig.daemon.dispatch("list.get", { kind: "requests" }, adminSession)) as never;
}

async function devices(rig: Rig): Promise<
  readonly {
    readonly id: string;
    readonly state: string;
    readonly address?: string;
    readonly driverDeviceId?: string;
  }[]
> {
  return (await rig.daemon.dispatch("list.get", { kind: "devices" }, adminSession)) as never;
}

async function requestedSpecs(rig: Rig, requester: string): Promise<readonly unknown[]> {
  const events = await rig.daemon.dispatch("events.replay", {}, adminSession);
  return events
    .filter((entry) => entry.event === "lease.requested")
    .map((entry) => entry.payload as { requester: string; requestSpec: unknown })
    .filter((payload) => payload.requester === requester)
    .map((payload) => payload.requestSpec);
}

async function grantedDevice(rig: Rig) {
  const [device] = await devices(rig);
  expect(device?.address).toBeDefined();
  return device as { readonly address: string; readonly driverDeviceId?: string };
}

function receivedAllocate(rig: Rig, n: number): Record<string, unknown> {
  const params = allocatesReceived(rig, n)[0]?.params;
  expect(params).toBeDefined();
  return params as Record<string, unknown>;
}

function allocatesReceived(rig: Rig, n?: number) {
  return rig.fake
    .rpcRequests("agent_device.lease.allocate")
    .filter((request) => n === undefined || request.params?.["leaseId"] === hex(n));
}

async function simlockMessage(rig: Rig, input: Record<string, unknown>): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.request", input, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a request the test expected it to refuse");
}

function track<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly promise: Promise<T>;
} {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  return { done: () => settled, promise: tracked };
}

function refusal(message: string, code = "INVALID_ARGS") {
  return { code: -32000, data: { code, message }, message };
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("with agentDevice.enabled false, and on a gateway-mode daemon, /v1/agent-device/health answers 404, as today", async () => {
    const enabled = await setUp();
    expect((await send(enabled, "/health")).status).toBe(200);

    const off = await setUp({ enabled: false });
    expect((await send(off, "/health")).status).toBe(404);

    const gateway = await setUp({ gatewayMode: true });
    expect((await send(gateway, "/health")).status).toBe(404);
  });

  it("/v1/agent-device/rpc with no simlock token answers 401, with a worker join token 403, and with an operator token 403 `refused: agent-device through simlock needs an agent token`; the agent-device daemon receives nothing", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const received = rig.fake.requests.length;

    expect((await command(rig, "snapshot", undefined, { token: null })).status).toBe(401);
    expect((await command(rig, "snapshot", undefined, { token: secrets.worker })).status).toBe(403);
    const operator = await command(rig, "snapshot", undefined, { token: secrets.operator });
    expect(operator.status).toBe(403);
    expect(await operator.text()).toContain(agentTokenOnly);

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("/v1/agent-device/health with a simlock token answers the proxy's health, with the agent-device daemon's health under `upstream`", async () => {
    const rig = await setUp();

    const response = await send(rig, "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });
  });

  it("with agentDevice.enabled true and agent-device unavailable, /health, /rpc and an upload each answer `agent-device is not available on this simlock: <reason>`, nothing is leased, and POST /v1/lease-requests still grants a device", async () => {
    const rig = await setUp();
    const reason = "found 0.20.3, need 0.21.25 or later";
    rig.fake.setUnavailable(reason);

    const health = await send(rig, "/health");
    const rpcAnswer = await allocate(rig, 1);
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(await health.text()).toContain(`${notAvailable}${reason}`);
    expect((await envelopeOf(rpcAnswer)).error?.message).toBe(`${notAvailable}${reason}`);
    expect(await upload.text()).toContain(`${notAvailable}${reason}`);
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.requests).toEqual([]);

    const granted = await fetch(`${rig.origin}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", platform: "ios" }),
      headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(granted.status).toBe(201);
  });

  it("after the agent-device daemon restarts with a new base URL, token and generation, the next request reaches the new daemon", async () => {
    const rig = await setUp();
    expect(await bodyOf(await send(rig, "/health"))).toMatchObject({
      upstream: { service: "agent-device-daemon" },
    });
    const before = rig.fake.requests.length;

    rig.fake.restart();
    const response = await send(rig, "/health");

    expect(await bodyOf(response)).toMatchObject({ upstream: { service: "agent-device-daemon" } });
    expect(rig.fake.requests.length).toBeGreaterThan(before);
  });

  it("commands sent with two simlock tokens reach the agent-device daemon as two tenants, each its token's principal, though the client named another tenant", async () => {
    const rig = await setUp();
    const named = { meta: { tenantId: "someone-else" }, tenantId: "someone-else" };

    await command(rig, "snapshot", undefined, { token: secrets.one }, named);
    await command(rig, "snapshot", undefined, { token: secrets.two }, named);

    expect(rig.fake.rpcRequests("agent_device.command").map((request) => request.tenant)).toEqual([
      principals.one,
      principals.two,
    ]);
  });

  it("allocate `--platform ios` makes a simlock lease whose ID and requester are the CLI's lease ID, owned by the token's principal, and the lease request names no osVersion, mode, imageTag or physical device and offers no download", async () => {
    const rig = await setUp();

    const answer = await allocate(rig, 1);

    expect((await envelopeOf(answer)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toMatchObject([
      { id: hex(1), ownerId: principals.one, requesterId: hex(1) },
    ]);
    expect(await requestedSpecs(rig, hex(1))).toEqual([{ platform: "ios" }]);

    const bare = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });
    const refused = await allocate(bare, 2);
    expect((await envelopeOf(refused)).error?.message).toContain("refused by simlock: ");
    expect(bare.driver.calls.map((call) => call.operation)).not.toContain("installComponent");
  });

  it("the simlock lease's TTL is the CLI's `ttlMs`, 5 s when the CLI sent less, and `lease.defaultTtlMs` when it sent none; the allocate the agent-device daemon receives carries `ttlMs` equal to the ceiling in each case", async () => {
    const rig = await setUp();

    await granted(rig, 1, { ttlMs: 120_000 });
    await granted(rig, 2, { ttlMs: 1_000 });
    await granted(rig, 3, { ttlMs: undefined });

    const byId = new Map((await leases(rig)).map((lease) => [lease.id, lease.ttlMs]));
    expect(byId.get(hex(1))).toBe(120_000);
    expect(byId.get(hex(2))).toBe(5_000);
    expect(byId.get(hex(3))).toBe(defaultTtlMs);
    expect(allocatesReceived(rig).map((request) => request.params?.["ttlMs"])).toEqual([
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
    ]);
  });

  it('allocate `--target mobile`, `tv` and `desktop` ask simlock for class `phone`, `tv` and `desktop`; allocate `--device "iPhone 17 Pro"`, alone and with `--target tv`, asks for that model and no class', async () => {
    const rig = await setUp({ maxRunning: 8 });

    await granted(rig, 1, { target: "mobile" });
    await granted(rig, 2, { target: "tv" });
    await granted(rig, 3, { target: "desktop" });
    await granted(rig, 4, { device: "iPhone 17 Pro" });
    await granted(rig, 5, { device: "iPhone 17 Pro", target: "tv" });

    expect(await requestedSpecs(rig, hex(1))).toEqual([{ class: "phone", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([{ class: "tv", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ class: "desktop", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(4))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
    expect(await requestedSpecs(rig, hex(5))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
  });

  it("an allocate whose `ttlMs` is above `lease.maxTtlMs` answers `refused by simlock:` with simlock's `BAD_REQUEST` message and leaves no simlock lease; one with `ttlMs: null` gets `lease.defaultTtlMs`", async () => {
    const rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1, { ttlMs: null }))).result).toMatchObject({
      ok: true,
    });
    expect((await leases(rig)).map((lease) => lease.ttlMs)).toEqual([defaultTtlMs]);

    const over = maxTtlMs + 1;
    const expected = await simlockMessage(rig, { leaseId: hex(9), platform: "ios", ttlMs: over });
    const answer = await envelopeOf(await allocate(rig, 2, { ttlMs: over }));

    expect(answer.error?.message).toBe(`refused by simlock: ${expected}`);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it('allocate `--device "My test phone"` answers `refused by simlock:` with simlock\'s message, and leaves no simlock lease', async () => {
    const rig = await setUp();
    expect(
      (await envelopeOf(await allocate(rig, 1, { device: "iPhone 17 Pro" }))).result,
    ).toMatchObject({ ok: true });
    const expected = await simlockMessage(rig, {
      leaseId: hex(9),
      model: "My test phone",
      platform: "ios",
    });

    const answer = await envelopeOf(await allocate(rig, 2, { device: "My test phone" }));

    expect(answer.error).toMatchObject(refusal(`refused by simlock: ${expected}`));
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  describe("each input refused before simlock", () => {
    const tooOld = "refused: this agent-device is too old for simlock; upgrade it";
    const ttlRefusal = "refused: ttlMs must be a positive number of milliseconds";
    const plainOnly = "refused: simlock leases only plain devices";
    const lifecycle = "refused: send lease calls as lease RPCs";
    const cases: readonly {
      readonly title: string;
      readonly message: string;
      readonly method?: string;
      readonly params: (n: number) => Record<string, unknown>;
    }[] = [
      {
        message: "refused: only iOS and Android",
        params: (n) => allocateParams(n, { platform: "macos" }),
        title: "--platform macos",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { udid: "ABC" }),
        title: "--udid",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { serial: "emulator-5554" }),
        title: "--serial",
      },
      {
        message: "refused: name --platform ios or android",
        params: (n) => allocateParams(n, { platform: undefined }),
        title: "no platform",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: undefined }),
        title: "no lease ID",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: hex(n).toUpperCase().replace(/[0-9]/g, "A") }),
        title: "a lease ID that is not 32 lowercase hex",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: "abc" }),
        title: 'a ttlMs of "abc"',
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: -1 }),
        title: "a ttlMs of -1",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: 0 }),
        title: "a ttlMs of 0",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { backend: "cloud" }),
        title: "backend",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { retainOnClose: true }),
        title: "retainOnClose: true",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { providerName: "x" }),
        title: "a provider* key",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { leaseProvider: "aws" }),
        title: 'leaseProvider: "aws"',
      },
      ...["agent_device.command", "agent-device.command"].flatMap((method) =>
        ["lease_allocate", "lease_heartbeat", "lease_release"].map((name) => ({
          message: lifecycle,
          method,
          params: (n: number) => ({ command: name, meta: { leaseId: hex(n) } }),
          title: `${method} carrying ${name}`,
        })),
      ),
    ];

    it.each(cases)(
      "$title answers its message, simlock stores no lease request, and the agent-device daemon receives nothing",
      async ({ message, method, params }) => {
        const rig = await setUp();
        const accepted = await allocate(rig, 1);
        expect((await envelopeOf(accepted)).result).toMatchObject({ ok: true });
        const heldBefore = (await leases(rig)).map((lease) => lease.id);
        const receivedBefore = rig.fake.requests.length;

        const answer = await rpc(rig, method ?? "agent_device.lease.allocate", params(2));

        expect((await envelopeOf(answer)).error).toMatchObject(refusal(message));
        expect(await requestedSpecs(rig, hex(2))).toEqual([]);
        expect(await waiting(rig)).toEqual([]);
        expect((await leases(rig)).map((lease) => lease.id)).toEqual(heldBefore);
        expect(rig.fake.requests).toHaveLength(receivedBefore);
      },
    );
  });

  it("allocate and release sent as `agent-device.lease.allocate` and `agent-device.lease.release` act exactly as the `agent_device.lease.*` spelling", async () => {
    const rig = await setUp();

    const allocated = await rpc(rig, "agent-device.lease.allocate", allocateParams(1));

    expect((await envelopeOf(allocated)).result).toMatchObject({ ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const released = await rpc(rig, "agent-device.lease.release", { ...scope, leaseId: hex(1) });

    expect((await envelopeOf(released)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
  });

  it("after the grant, the allocate the agent-device daemon receives names the granted device's address by `udid` on iOS and by `serial` on Android (the emulator serial, not the AVD name), and carries no `device`, `deviceKey` or `target`; the CLI gets the daemon's reply with the same lease ID", async () => {
    const ios = await setUp();
    const iosAnswer = await envelopeOf(
      await allocate(ios, 1, { device: "iPhone 17 Pro", deviceKey: "saved", target: "mobile" }),
    );
    const iosDevice = await grantedDevice(ios);
    const iosParams = receivedAllocate(ios, 1);

    expect(iosAnswer.result).toMatchObject({ lease: { leaseId: hex(1) }, ok: true });
    expect(iosParams["udid"]).toBe(iosDevice.address);
    expect(iosParams).not.toHaveProperty("serial");
    for (const dropped of ["device", "deviceKey", "target"]) {
      expect(iosParams).not.toHaveProperty(dropped);
    }

    const android = await setUp({ drivers: (clock) => [androidDriver(clock)] });
    const androidAnswer = await envelopeOf(
      await allocate(android, 2, { device: "Pixel 8", platform: "android" }),
    );
    const androidDevice = await grantedDevice(android);
    const androidParams = receivedAllocate(android, 2);

    expect(androidAnswer.result).toMatchObject({ lease: { leaseId: hex(2) }, ok: true });
    expect(androidParams["serial"]).toBe(androidDevice.address);
    expect(androidParams["serial"]).not.toBe(androidDevice.driverDeviceId);
    expect(androidParams).not.toHaveProperty("udid");
  });

  it("with every matching device leased, allocate waits, and is granted and answered once that device is released and reclaimed", async () => {
    const rig = await setUp({ maxRunning: 1 });
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await expect
      .poll(async () => (await waiting(rig)).map((request) => request.requesterId))
      .toEqual([hex(2)]);
    expect(second.done()).toBe(false);

    await release(rig, 1);
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ lease: { leaseId: hex(2) }, ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
  });

  it("a CLI that hangs up while its allocate waits, and one that hangs up before simlock admitted the request, leave simlock's queue, and neither request is granted when a device frees", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    const hangUp = new AbortController();
    const second = track(allocate(rig, 2, {}, { signal: hangUp.signal, token: secrets.two }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    hangUp.abort();
    await second.promise.catch(() => undefined);
    await expect.poll(async () => (await waiting(rig)).length).toBe(0);
    await release(rig, 1);
    await sleep(50);

    expect(await leases(rig)).toEqual([]);
    expect(allocatesReceived(rig, 2)).toEqual([]);

    const slow = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      slowStart: true,
    });
    const early = new AbortController();
    const parked = track(
      fetch(`${slow.origin}/v1/agent-device/rpc`, {
        body: rpcBody("agent_device.lease.allocate", allocateParams(3)),
        headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
        method: "POST",
        signal: early.signal,
      }),
    );
    await sleep(100);
    expect(parked.done()).toBe(false);
    early.abort();
    await parked.promise.catch(() => undefined);
    await sleep(50);
    slow.clock.advance(30_000);
    const ready = { ...slow, daemon: await slow.started };
    await sleep(100);

    expect(await leases(ready)).toEqual([]);
    expect(await requestedSpecs(ready, hex(3))).toEqual([]);
    expect(allocatesReceived(ready, 3)).toEqual([]);
  });

  it("a CLI that hangs up after device work started for it gets no agent-device lease: the grant that lands later is released at once and never reaches the agent-device daemon; when that device work fails and the request goes back to the queue, the front's repeated cancel removes it, and it is never granted", async () => {
    const slowDevice = (clock: FakeClock) => [
      new FakeDriver({
        ...phoneModels,
        availableOsVersions: ["26.5"],
        clock,
        knownModels: ["iPhone 16"],
        latencyMs: { makeReady: 10_000 },
        platform: "ios",
      }),
    ];
    const rig = await setUp({ drivers: slowDevice });
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect
      .poll(() => rig.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await advance(rig, 12_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    expect(allocatesReceived(rig, 1)).toEqual([]);

    const failing = await setUp({ drivers: slowDevice });
    failing.driver.failOn("makeReady", 1, new Error("boot failed"));
    const abort = new AbortController();
    const second = track(allocate(failing, 2, {}, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect
      .poll(() => failing.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);
    abort.abort();
    await second.promise.catch(() => undefined);

    await advance(failing, 15_000);

    await expect.poll(async () => (await waiting(failing)).length).toBe(0);
    expect(await leases(failing)).toEqual([]);
    expect(allocatesReceived(failing, 2)).toEqual([]);
  });

  it("`DELETE /v1/lease-requests/:id` for the front's waiting request answers the allocate `refused by simlock:` with simlock's message, and nothing is leased", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);
    const [request] = await waiting(rig);

    const cancelled = await fetch(`${rig.origin}/v1/lease-requests/${request?.id}`, {
      headers: { authorization: `Bearer ${secrets.one}` },
      method: "DELETE",
    });
    const answer = await envelopeOf(await second.promise);

    expect(cancelled.status).toBe(204);
    expect(answer.error?.message).toMatch(/^refused by simlock: .+/);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(await waiting(rig)).toEqual([]);
  });

  it("stopping the daemon while an allocate waits ends with no simlock lease, and the lease request it waited on is cancelled, not open, in state.json", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await rig.daemon.stop("test");
    await second.promise.catch(() => undefined);

    const state = await rig.filesystem.readFile(rig.statePath);
    expect(second.done()).toBe(true);
    expect(state).toContain(hex(1));
    const records = JSON.parse(state ?? "{}") as {
      leaseRequests?: readonly { leaseId?: string; state: string }[];
    };
    expect(records.leaseRequests?.filter((record) => record.leaseId === hex(2))).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(records.leaseRequests?.some((record) => record.state === "open")).toBe(false);
  });

  it("an allocate still waiting 330 s after the front admitted it answers `timed out waiting for a device; nothing was leased`, and simlock's queue is empty", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: maxTtlMs }, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await advance(rig, 329_000);
    expect(second.done()).toBe(false);
    await advance(rig, 1_000);
    const answer = await envelopeOf(await second.promise);

    expect(answer.error).toMatchObject(refusal(queueTimeoutMessage, "COMMAND_FAILED"));
    expect(await waiting(rig)).toEqual([]);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("an agent-device allocate that answers an error, and a grant that names no device address, release the simlock lease, and the CLI gets the error", async () => {
    const rig = await setUp();
    rig.fake.failNextAllocate({ code: "NO_DEVICE", message: "no such device" });

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "NO_DEVICE", message: "no such device" },
      message: "no such device",
    });
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    class NoAddressDriver extends FakeDriver {
      override async makeReady(...arguments_: Parameters<FakeDriver["makeReady"]>) {
        const ready = await super.makeReady(...arguments_);
        return { ...ready, address: undefined as unknown as string };
      }
    }
    const bare = await setUp({
      drivers: (clock) => [
        new NoAddressDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });

    const noAddress = await envelopeOf(await allocate(bare, 2));

    expect(noAddress.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(bare)).length).toBe(0);
    expect(allocatesReceived(bare, 2)).toEqual([]);
  });

  it("an agent-device allocate with no usable reply (an unreachable daemon, a non-JSON body) releases the simlock lease and answers `COMMAND_FAILED`; when agent-device answers the follow-up release with a scope error, the simlock lease stays until its TTL, and when it answers `LEASE_NOT_FOUND`, the simlock lease is released", async () => {
    const rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await allocate(rig, 2));
    rig.fake.setUnreachable(false);

    expect(unreachable.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    const notJson = await envelopeOf(await allocate(rig, 3));

    expect(notJson.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "UNAUTHORIZED", message: "lease scope mismatch" });
    const kept = await envelopeOf(await allocate(rig, 4, { ttlMs: 60_000 }));

    expect(kept.error?.data?.code).toBe("COMMAND_FAILED");
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(4));
    await advance(rig, 61_000);
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(4));
  });

  it("a CLI that hangs up while agent-device makes its lease leaves neither lease: the agent-device lease is released with the reply's scope, then the simlock lease; when that release fails, the simlock lease stays until its TTL", async () => {
    const rig = await setUp();
    rig.fake.holdAllocate();
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 1).length).toBe(1);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();

    await expect.poll(async () => (await leases(rig)).length).toBe(0);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject(scope);

    rig.fake.holdAllocate();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const abort = new AbortController();
    const second = track(allocate(rig, 2, { ttlMs: 60_000 }, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 2).length).toBe(1);
    abort.abort();
    await second.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();
    await expect.poll(() => rig.fake.rpcRequests("agent_device.lease.release").length).toBe(2);

    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
    await advance(rig, 61_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);
  });

  it("a heartbeat reaches the agent-device daemon unchanged, its reply reaches the CLI, and the simlock lease's deadline does not move", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const [before] = await leases(rig);
    rig.clock.advance(10_000);
    const params = { ...scope, leaseId: hex(1), ttlMs: 90_000 };

    const answer = await envelopeOf(
      await rpc(rig, "agent_device.lease.heartbeat", params, { id: "hb-1" }),
    );

    expect(answer).toMatchObject({ id: "hb-1", result: { ok: true } });
    expect(rig.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject(params);
    expect((await leases(rig))[0]).toEqual(before);
  });

  it("release, and release after `close` (which the daemon answers `released: false`), go to the agent-device daemon first, then release the simlock lease, and the device is reclaimed and free", async () => {
    const rig = await setUp();
    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = (await leases(rig)).map((lease) => lease.id);
    };
    await granted(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toEqual([hex(1)]);
    expect(await leases(rig)).toEqual([]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);

    await granted(rig, 2);
    await command(rig, "close", 2);
    const afterClose = await envelopeOf(await release(rig, 2));

    expect(afterClose.result).toMatchObject({ ok: true, released: false });
    expect(heldAtDaemonRelease).toEqual([hex(2)]);
    expect(await leases(rig)).toEqual([]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease and answers the daemon's error", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a release after `simlock release --all` ended the simlock lease answers the daemon's reply", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expect(await leases(rig)).toEqual([]);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
  });

  it("a release from a second token naming the first token's lease ID leaves the first token's simlock lease in place", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.error).toBeDefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);
  });

  it("a command's reply, a streamed progress body included, reaches the CLI unchanged, and a CLI that hangs up during it aborts the request the agent-device daemon was answering", async () => {
    const rig = await setUp();
    const chunks = ['{"progress":1}\n', '{"progress":2}\n', '{"done":true}\n'];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "install", undefined);

    expect(await streamed.text()).toBe(chunks.join(""));

    const plain = await envelopeOf(await command(rig, "snapshot", undefined));
    expect(plain.result).toMatchObject({ command: "snapshot", ok: true });

    rig.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "snapshot", undefined, { signal: hangUp.signal }));
    await sleep(50);
    expect(held.done()).toBe(false);
    await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(3);
    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect.poll(() => rig.fake.abortedCommands).toEqual(["snapshot"]);
  });

  it("an upload preflight answers a ticket URL under `/v1/agent-device/upload/direct/` on simlock's own origin, carrying the agent's own simlock token, and a `PUT` to it reaches the agent-device daemon", async () => {
    const rig = await setUp();

    const preflight = await send(rig, "/upload/preflight", { body: "{}" });
    expect(preflight.status).toBe(200);
    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;

    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const carried = Object.entries(ticket.headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(carried?.[1]).toBe(`Bearer ${secrets.one}`);

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: ticket.headers,
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(rig.fake.uploads).toEqual(["artifact bytes"]);
  });

  it("an `/rpc` body over 1 MiB, one that is not JSON, a JSON array, and an object with no `method` are each refused with their message and `id: null`, also while agent-device is unavailable, and neither simlock nor the agent-device daemon sees them", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const oneMiB = 1024 * 1024;
    const bodies: readonly [string, string][] = [
      [
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "agent_device.command",
          params: { pad: "x".repeat(oneMiB) },
        }),
        "refused: request body over 1 MiB",
      ],
      ["{ not json", "refused: send one JSON-RPC request"],
      ["[]", "refused: send one JSON-RPC request"],
      [JSON.stringify({ id: 3, jsonrpc: "2.0" }), "refused: send one JSON-RPC request"],
    ];

    for (const unavailable of [false, true]) {
      rig.fake.setUnavailable(unavailable ? "starting" : undefined);
      const receivedBefore = rig.fake.requests.length;
      for (const [body, message] of bodies) {
        const answer = await envelopeOf(await send(rig, "/rpc", { body }));
        expect(answer).toMatchObject({ error: refusal(message), id: null, jsonrpc: "2.0" });
      }
      expect(rig.fake.requests).toHaveLength(receivedBefore);
    }
    expect(await waiting(rig)).toEqual([]);
    expect(await leases(rig)).toEqual([]);
  });
});
