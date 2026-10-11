import { describe, expect, it } from "vitest";

import { HeldWritesFilesystem } from "./testing.js";

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("HeldWritesFilesystem", () => {
  it("writes straight through while it is not holding", async () => {
    const filesystem = new HeldWritesFilesystem();

    await filesystem.writeFileAtomic("/a", "one");

    expect(await filesystem.readFile("/a")).toBe("one");
  });

  it("holds a write while holding, until releaseUntil lets it through", async () => {
    const filesystem = new HeldWritesFilesystem();
    filesystem.holding = true;
    const writing = filesystem.writeFileAtomic("/a", "one");
    await filesystem.held(1);

    await expect(filesystem.readFile("/a")).rejects.toThrow();
    await filesystem.releaseUntil(writing);

    expect(await filesystem.readFile("/a")).toBe("one");
  });

  it("releases held writes one per turn, in the order they were held", async () => {
    const filesystem = new HeldWritesFilesystem();
    filesystem.holding = true;
    const first = filesystem.writeFileAtomic("/a", "first");
    const second = filesystem.writeFileAtomic("/a", "second");
    await filesystem.held(2);

    await filesystem.releaseUntil(Promise.all([first, second]));

    expect(await filesystem.readFile("/a")).toBe("second");
  });

  it("held rejects, naming how many writes it saw, when fewer than asked for are held", async () => {
    const filesystem = new HeldWritesFilesystem();
    filesystem.holding = true;
    void filesystem.writeFileAtomic("/a", "one");

    await expect(filesystem.held(2)).rejects.toThrow("Only 1 writes were held");
  });

  it("held returns as soon as the asked-for count is held, without waiting out its turns", async () => {
    const filesystem = new HeldWritesFilesystem();
    filesystem.holding = true;
    void filesystem.writeFileAtomic("/a", "one");
    await turns(1);

    await expect(filesystem.held(1)).resolves.toBeUndefined();
  });

  it("releaseUntil rejects when nothing it releases settles the promise", async () => {
    const filesystem = new HeldWritesFilesystem();

    await expect(filesystem.releaseUntil(new Promise(() => undefined))).rejects.toThrow(
      "The held writes never settled",
    );
  });

  it("releaseUntil rethrows the error of a promise that rejects", async () => {
    const filesystem = new HeldWritesFilesystem();

    await expect(filesystem.releaseUntil(Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
  });
});
