import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/concurrency.js";

describe("Semaphore", () => {
  it("allows up to max concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    expect(sem.running).toBe(2);
    expect(sem.pending).toBe(0);
  });

  it("queues acquisitions beyond max", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let secondAcquired = false;
    const p = sem.acquire().then(() => { secondAcquired = true; });

    // Give the microtask queue a tick
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(sem.pending).toBe(1);

    sem.release();
    await p;
    expect(secondAcquired).toBe(true);
    expect(sem.running).toBe(1);
  });

  it("processes queued tasks in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
    sem.release();
  });

  it("enforces concurrency limit across parallel tasks", async () => {
    const sem = new Semaphore(2);
    let maxConcurrent = 0;
    let current = 0;

    const task = async () => {
      await sem.acquire();
      try {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        current--;
        sem.release();
      }
    };

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(2);
  });
});
