import { describe, expect, test } from "bun:test";
import { publicUrl, publicUrlError } from "./public-url";

describe("TOPOSCOPE_PUBLIC_URL", () => {
  test("unset or blank is no address, and not an error", () => {
    expect(publicUrl({})).toBeNull();
    expect(publicUrl({ TOPOSCOPE_PUBLIC_URL: "  " })).toBeNull();
    expect(publicUrlError({})).toBeNull();
  });

  test("an http or https address, without its trailing slash", () => {
    expect(publicUrl({ TOPOSCOPE_PUBLIC_URL: "https://logs.example.com/" })).toBe("https://logs.example.com");
    expect(publicUrl({ TOPOSCOPE_PUBLIC_URL: "http://127.0.0.1:8080" })).toBe("http://127.0.0.1:8080");
  });

  test("a path is kept, for Toposcope behind a proxy at a prefix", () => {
    expect(publicUrl({ TOPOSCOPE_PUBLIC_URL: "https://example.com/toposcope/" })).toBe(
      "https://example.com/toposcope",
    );
  });

  test("anything else is refused at boot, with the reason", () => {
    for (const bad of ["logs.example.com", "ftp://logs.example.com", "https://logs.example.com/?a=1", "https://logs.example.com/#top"]) {
      expect(publicUrlError({ TOPOSCOPE_PUBLIC_URL: bad })).toBe(
        "TOPOSCOPE_PUBLIC_URL must be the http or https address Toposcope is opened at, with no query or #fragment",
      );
      expect(publicUrl({ TOPOSCOPE_PUBLIC_URL: bad })).toBeNull();
    }
  });
});
