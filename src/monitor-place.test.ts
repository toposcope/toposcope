import { describe, expect, test } from "bun:test";
import { defaultHost, readPlace, serviceRequired } from "./control/monitor-place";
import type { AlertRule } from "./control/alerts";

const older = { id: "m", name: "m", service: "", host: "" } as unknown as AlertRule;

describe("a monitor names its service and host (#335)", () => {
  test("a monitor cannot be saved without a service; one made before is asked on its next save", () => {
    expect(readPlace({ name: "api health" }, null)).toEqual({ error: serviceRequired });
    expect(readPlace({ threshold: 3 }, older)).toEqual({ error: serviceRequired });
    expect(readPlace({ service: "  " }, null)).toEqual({ error: serviceRequired });
    expect(readPlace({ service: "api" }, older)).toEqual({ service: "api", host: "" });
  });

  test("an HTTP monitor's host is its URL's until changed; TCP and certificate take their target's", () => {
    expect(readPlace({ service: "api", url: "https://api.example.com/health" }, null)).toEqual({ service: "api", host: "api.example.com" });
    expect(readPlace({ service: "api", http: { url: "https://api.example.com/health" } }, null)).toMatchObject({ host: "api.example.com" });
    expect(readPlace({ service: "api", url: "https://api.example.com/health", host: "api-1" }, null)).toMatchObject({ host: "api-1" });
    expect(defaultHost({ target: "billing-db:5432" }, null)).toBe("billing-db");
    expect(defaultHost({ target: "[::1]:443" }, null)).toBe("::1");
  });

  test("a save that leaves them out keeps what the monitor had", () => {
    const named = { ...older, service: "billing", host: "billing-7" } as AlertRule;
    expect(readPlace({ threshold: 9 }, named)).toEqual({ service: "billing", host: "billing-7" });
  });
});
