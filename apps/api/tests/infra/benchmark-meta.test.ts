import { describe, expect, test } from "bun:test";
import { BENCHMARKS } from "../../src/infra/http/controllers/benchmark.controller.ts";

describe("BENCHMARKS catalog (free Yahoo indices)", () => {
  test("includes ibov yahoo symbol", () => {
    expect(BENCHMARKS.ibov.yahooSymbol).toBe("^BVSP");
    expect(BENCHMARKS.ibov.source).toBe("yahoo");
  });

  test("ifix is marked experimental", () => {
    expect(BENCHMARKS.ifix.name.toLowerCase()).toContain("experimental");
  });
});
