import { describe, expect, test } from "bun:test";
import {
  flamePinLit,
  formatProfileValue,
  layoutFlame,
  packageFromFrame,
} from "./flame";

describe("packageFromFrame", () => {
  test("maps the mock's named layers", () => {
    expect(packageFromFrame("{main}")).toBe("php");
    expect(packageFromFrame("require(wp-admin/post.php)")).toBe("php");
    expect(packageFromFrame("do_action(save_post)")).toBe("wordpress");
    expect(packageFromFrame("mysqli::query")).toBe("mysql");
    expect(packageFromFrame("preg_match_all")).toBe("pcre");
    expect(packageFromFrame("PHPMailer::send")).toBe("phpmailer");
    expect(packageFromFrame("stream_socket_client")).toBe("net");
    expect(packageFromFrame("seo_plugin::analyse")).toBe("plugin");
  });
});

describe("formatProfileValue", () => {
  test("formats cpu nanoseconds as time", () => {
    expect(formatProfileValue(212_000_000, "nanoseconds")).toBe("212ms");
    expect(formatProfileValue(22_000_000, "ns")).toBe("22ms");
  });

  test("formats counts without inventing a duration", () => {
    expect(formatProfileValue(42, "count")).toBe("42");
    expect(formatProfileValue(1284, "count")).toBe("1.28K");
  });
});

describe("layoutFlame", () => {
  test("builds an icicle from root-first stacks", () => {
    const { frames, total } = layoutFlame([
      { frames: ["{main}", "edit_post"], value: 10 },
      { frames: ["{main}", "wp_mail"], value: 4 },
    ]);
    expect(total).toBe(14);
    const root = frames.find((frame) => frame.name === "{main}" && frame.depth === 0);
    expect(root?.value).toBe(14);
    expect(root?.self).toBe(0);
    const edit = frames.find((frame) => frame.name === "edit_post");
    expect(edit?.depth).toBe(1);
    expect(edit?.value).toBe(10);
  });

  test("pin keeps the subtree and ancestor spine", () => {
    const { frames } = layoutFlame([
      { frames: ["a", "b", "c"], value: 8 },
      { frames: ["a", "d"], value: 2 },
    ]);
    const pin = frames.find((frame) => frame.name === "b");
    expect(pin).toBeTruthy();
    const lit = frames.filter((frame) => flamePinLit(frame, pin ?? null)).map((f) => f.name);
    expect(lit).toEqual(["a", "b", "c"]);
  });
});
