import type { DispatcherOptions } from "./dispatcher.js";

type Enrollment = NonNullable<DispatcherOptions["enrollment"]>;

/**
 * Wakes the queue after an enrollment change commits (ADR 0022 §3), so a request waiting for a
 * device is granted one that was just enrolled, and one whose last match was unenrolled ends. It
 * lives at the composition root because the core cannot reach leasing: the wake is leasing's
 * port, which only the daemon holds. A refused `add` or `remove` changed nothing and wakes nothing.
 */
export function wakingQueueAfter(enrollment: Enrollment, wake: () => void): Enrollment {
  return {
    add: async (platform, id) => {
      const added = await enrollment.add(platform, id);
      wake();
      return added;
    },
    remove: async (id) => {
      const removed = await enrollment.remove(id);
      wake();
      return removed;
    },
  };
}
