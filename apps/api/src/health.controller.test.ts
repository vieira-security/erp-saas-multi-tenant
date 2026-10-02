import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("responds ok", () => {
    expect(new HealthController().check()).toEqual({ status: "ok" });
  });
});
