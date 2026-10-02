import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home page", () => {
  it("renders", () => {
    expect(renderToString(<Home />)).toContain("ERP SaaS");
  });
});
