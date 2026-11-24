import { describe, expect, it } from "vitest";

import { sanitizeInput } from "./routine-input.ts";
import type { RoutineInput } from "./routines.ts";

const status = (input: unknown) => {
  try {
    sanitizeInput(input as RoutineInput, Date.now());
    return "accepted";
  } catch (error) {
    return { status: (error as { status?: number }).status, message: (error as Error).message };
  }
};

describe("sanitizeInput", () => {
  it("answers a routine it can't keep with 400 and the reason, whatever the body", () => {
    expect(status(null)).toEqual({ status: 400, message: "Give the routine a name" });
    expect(status([])).toEqual({ status: 400, message: "Give the routine a name" });
    expect(status({ name: "Morning" })).toEqual({ status: 400, message: "Tell the bot what to do" });
    expect(status({ name: "Morning", prompt: "Check mail", botId: "b1", overlap: "both" })).toMatchObject({ status: 400 });
  });

  describe("script check post and access", () => {
    const base = { name: "Report", prompt: "Post it", botId: "b1", runOn: "maus", schedule: { type: "interval", everyMinutes: 60 } };
    const kept = (probe: unknown) => sanitizeInput({ ...base, probe } as unknown as RoutineInput, Date.now()).probe;

    it("keeps post and access on a script check", () => {
      expect(kept({ kind: "script", url: "", command: "date", post: true, access: "full" })).toEqual({ kind: "script", url: "", command: "date", post: true, access: "full" });
      expect(kept({ kind: "script", url: "", command: "date" })).toEqual({ kind: "script", url: "", command: "date" });
    });

    it("refuses them on a page, feed or price check", () => {
      for (const kind of ["page", "feed", "price"]) {
        expect(status({ ...base, probe: { kind, url: "https://example.com", post: true } })).toMatchObject({ status: 400, message: expect.stringMatching(/^A page, feed or price check cannot/) });
        expect(status({ ...base, probe: { kind, url: "https://example.com", access: "full" } })).toMatchObject({ status: 400 });
      }
    });

    it("refuses other values", () => {
      expect(status({ ...base, probe: { kind: "script", url: "", command: "date", post: false } })).toMatchObject({ status: 400 });
      expect(status({ ...base, probe: { kind: "script", url: "", command: "date", access: "read" } })).toMatchObject({ status: 400 });
    });
  });
});
