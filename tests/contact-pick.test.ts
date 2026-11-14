import { describe, expect, test } from "bun:test";
import { pickHandle } from "../src/core/contact-pick";

const ph = (e164: string, label: string) => ({ e164, label });
describe("pickHandle", () => {
  test("mobile / iPhone / cell first (also Apple's _$!<Mobile>!$_ labels), then the first phone, then the first email", () => {
    expect(pickHandle({ phones: [ph("+12025550001", "work"), ph("+13015550123", "_$!<Mobile>!$_")], emails: [] })?.handle).toBe("+13015550123");
    expect(pickHandle({ phones: [ph("+12025550001", "home"), ph("+13015550123", "iPhone")], emails: [] })?.handle).toBe("+13015550123");
    expect(pickHandle({ phones: [ph("+12025550001", "home"), ph("+12025550002", "work")], emails: [{ email: "a@b.co", label: "" }] })).toEqual({ handle: "+12025550001", kind: "phone" });
    expect(pickHandle({ phones: [], emails: [{ email: "A@B.co", label: "" }] })).toEqual({ handle: "a@b.co", kind: "email" });
    expect(pickHandle({ phones: [], emails: [] })).toBeNull();
  });
  test("a fax or pager number is never picked, even as the only phone", () => {
    expect(pickHandle({ phones: [ph("+12025550001", "work fax"), ph("+12025550002", "home")], emails: [] })?.handle).toBe("+12025550002");
    expect(pickHandle({ phones: [ph("+12025550001", "_$!<WorkFAX>!$_")], emails: [{ email: "a@b.co", label: "" }] })).toEqual({ handle: "a@b.co", kind: "email" });
  });
});
