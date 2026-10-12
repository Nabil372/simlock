import type { AgentDeviceHealthProbe } from "./host/health.js";

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
