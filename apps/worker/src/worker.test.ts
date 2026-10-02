import { describe, expect, it } from "vitest";
import { describeWorker } from "./worker.js";

describe("worker", () => {
  it("bootstraps without queues", () => {
    expect(describeWorker()).toContain("no queues");
  });
});
