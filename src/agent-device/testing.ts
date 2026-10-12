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

  neverAnswer(): void {
    this.#answer = "never";
  }

  async read(baseUrl: string): Promise<unknown> {
    this.reads.push(baseUrl);
    if (this.#answer === "never") return new Promise<never>(() => undefined);
    if ("error" in this.#answer) throw this.#answer.error;
    return this.#answer.body;
  }
}
