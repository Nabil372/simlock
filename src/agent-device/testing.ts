import type { AgentDeviceHealthProbe } from "./host/health.js";
import type { AgentDeviceUpstream, AgentDeviceUpstreamState } from "./host/upstream.js";

type Answer = { readonly body: unknown } | { readonly error: Error } | "never";

export class FakeAgentDeviceHealth implements AgentDeviceHealthProbe {
  readonly reads: string[] = [];
  #answer: Answer = "never";

  respondWith(body: unknown): void {
    this.#answer = { body };
  }

  rejectWith(error: Error): void {
    this.#answer = { error };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the AgentDeviceHealthProbe port by the supervisor.
  async read(baseUrl: string): Promise<unknown> {
    this.reads.push(baseUrl);
    if (this.#answer === "never") return new Promise<never>(() => undefined);
    if ("error" in this.#answer) throw this.#answer.error;
    return this.#answer.body;
  }
}

export interface FakeAgentDeviceRequest {
  readonly method: string;
  readonly path: string;
  readonly tenant: string | undefined;
  readonly rpcMethod?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface FakeAgentDeviceLease {
  readonly leaseId: string;
  readonly tenant: string | undefined;
  readonly scope: {
    readonly runId: unknown;
    readonly leaseProvider: unknown;
    readonly clientId: unknown;
    readonly deviceKey: unknown;
  };
  readonly ttlMs: unknown;
  ended: boolean;
}

interface FakeFailure {
  readonly code: string;
  readonly message: string;
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

function envelope(id: unknown, result: unknown): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

function errorEnvelope(id: unknown, failure: FakeFailure): Response {
  return Response.json({
    error: { code: -32000, data: failure, message: failure.message },
    id,
    jsonrpc: "2.0",
  });
}

export class FakeAgentDevice implements AgentDeviceUpstream {
  readonly requests: FakeAgentDeviceRequest[] = [];
  readonly leases = new Map<string, FakeAgentDeviceLease>();
  readonly abortedCommands: string[] = [];
  readonly uploads: string[] = [];
  baseUrl = "http://127.0.0.1:47001";
  token = "daemon-token-1";
  generation = 1;
  leaseMaxTtlMs: number;
  onRelease: (() => Promise<void>) | undefined;
  #unavailable: string | undefined;
  #unreachable = false;
  #failAllocate: FakeFailure | undefined;
  #failRelease: FakeFailure | undefined;
  #allocateBody: string | undefined;
  #allocateGate: Gate | undefined;
  #commandGate: Gate | undefined;
  #streamChunks: readonly string[] | undefined;
  #restarts = 0;

  constructor(options: { readonly leaseMaxTtlMs?: number } = {}) {
    this.leaseMaxTtlMs = options.leaseMaxTtlMs ?? 4 * 60 * 60_000 + 10_000;
  }

  current(): AgentDeviceUpstreamState {
    if (this.#unavailable !== undefined) {
      return { reason: this.#unavailable, state: "unavailable" };
    }
    return {
      baseUrl: this.baseUrl,
      generation: this.generation,
      leaseMaxTtlMs: this.leaseMaxTtlMs,
      state: "running",
      token: this.token,
    };
  }

  setUnavailable(reason: string | undefined): void {
    this.#unavailable = reason;
  }

  setUnreachable(unreachable: boolean): void {
    this.#unreachable = unreachable;
  }

  failNextAllocate(failure: FakeFailure): void {
    this.#failAllocate = failure;
  }

  failNextRelease(failure: FakeFailure): void {
    this.#failRelease = failure;
  }

  answerNextAllocateWith(body: string): void {
    this.#allocateBody = body;
  }

  holdAllocate(): void {
    this.#allocateGate = gate();
  }

  letAllocateGo(): void {
    this.#allocateGate?.open();
  }

  holdCommand(): void {
    this.#commandGate = gate();
  }

  letCommandGo(): void {
    this.#commandGate?.open();
  }

  streamNextCommand(chunks: readonly string[]): void {
    this.#streamChunks = chunks;
  }

  restart(): void {
    this.#restarts += 1;
    this.generation += 1;
    this.baseUrl = `http://127.0.0.1:${47_001 + this.#restarts}`;
    this.token = `daemon-token-${this.generation}`;
    this.leases.clear();
  }

  rpcRequests(rpcMethod: string): readonly FakeAgentDeviceRequest[] {
    return this.requests.filter((request) => request.rpcMethod === rpcMethod);
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#unreachable) throw new TypeError("fetch failed");
    const url = new URL(request.url);
    const base = new URL(this.baseUrl);
    if (url.origin !== base.origin) throw new TypeError("fetch failed: wrong origin");
    if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
      return Response.json(
        { code: "UNAUTHORIZED", error: "bad token", ok: false },
        { status: 401 },
      );
    }
    const tenantHeader = request.headers.get("x-agent-device-tenant") ?? undefined;
    if (url.pathname === "/health") {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      return Response.json({ ok: true, rpcProtocolVersion: 2, service: "agent-device-daemon" });
    }
    if (url.pathname === "/upload/preflight") {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      return Response.json({
        ok: true,
        upload: { headers: {}, url: `${this.baseUrl}/upload/direct/ticket-1` },
      });
    }
    if (url.pathname.startsWith("/upload/direct/")) {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      this.uploads.push(await request.text());
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/rpc") return new Response("Not found", { status: 404 });
    return this.#rpc(request, tenantHeader);
  }

  async #rpc(request: Request, tenantHeader: string | undefined): Promise<Response> {
    const body = (await request.json()) as {
      readonly id?: unknown;
      readonly method?: string;
      readonly params?: Record<string, unknown>;
    };
    const params = body.params ?? {};
    const meta = (params["meta"] ?? {}) as Record<string, unknown>;
    const tenantOf = (value: unknown) => (typeof value === "string" ? value : undefined);
    const tenant = tenantHeader ?? tenantOf(params["tenantId"]) ?? tenantOf(meta["tenantId"]);
    const method = body.method ?? "";
    this.requests.push({ method: request.method, params, path: "/rpc", rpcMethod: method, tenant });
    const kind = method.replace(/^agent[_-]device\./, "");
    if (kind === "lease.allocate") return this.#allocate(body.id, params, tenant);
    if (kind === "lease.heartbeat") return envelope(body.id, { lease: params, ok: true });
    if (kind === "lease.release") {
      await this.onRelease?.();
      return this.#release(body.id, params, tenant);
    }
    return this.#command(request, body.id, params, meta);
  }

  async #allocate(
    id: unknown,
    params: Record<string, unknown>,
    tenant: string | undefined,
  ): Promise<Response> {
    if (this.#allocateGate !== undefined) await this.#allocateGate.promise;
    const raw = this.#allocateBody;
    this.#allocateBody = undefined;
    if (raw !== undefined) return new Response(raw, { status: 200 });
    const failure = this.#failAllocate;
    this.#failAllocate = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const leaseId = String(params["leaseId"]);
    const scope = {
      clientId: params["clientId"],
      deviceKey: params["deviceKey"],
      leaseProvider: params["leaseProvider"],
      runId: params["runId"],
    };
    this.leases.set(leaseId, { ended: false, leaseId, scope, tenant, ttlMs: params["ttlMs"] });
    return envelope(id, {
      lease: { ...scope, leaseId, tenantId: tenant, ttlMs: params["ttlMs"] },
      ok: true,
    });
  }

  #release(id: unknown, params: Record<string, unknown>, tenant: string | undefined): Response {
    const failure = this.#failRelease;
    this.#failRelease = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const lease = this.leases.get(String(params["leaseId"]));
    if (lease === undefined || lease.tenant !== tenant) {
      return errorEnvelope(id, { code: "LEASE_NOT_FOUND", message: "lease not found" });
    }
    if (
      lease.scope.runId !== params["runId"] ||
      lease.scope.leaseProvider !== params["leaseProvider"] ||
      lease.scope.clientId !== params["clientId"]
    ) {
      return errorEnvelope(id, { code: "UNAUTHORIZED", message: "lease scope mismatch" });
    }
    this.leases.delete(lease.leaseId);
    return envelope(id, { ok: true, released: !lease.ended });
  }

  async #command(
    request: Request,
    id: unknown,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Response> {
    const command = String(params["command"] ?? "");
    if (this.#commandGate !== undefined) {
      const aborted = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          this.abortedCommands.push(command);
          reject(new Error("aborted"));
        });
      });
      await Promise.race([this.#commandGate.promise, aborted]);
    }
    const chunks = this.#streamChunks;
    this.#streamChunks = undefined;
    if (chunks !== undefined) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    const leaseId = meta["leaseId"];
    if (command === "close" && typeof leaseId === "string") {
      const lease = this.leases.get(leaseId);
      if (lease !== undefined) lease.ended = true;
    }
    return envelope(id, { command, ok: true });
  }
}
