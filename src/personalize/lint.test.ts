import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../db";
import { addDraft, createBatch, getDrafts, setBatchStatus } from "../core/store";
import type { Draft, Warning, WarningCode } from "../core/types";
import { memDb } from "../ingest/testutil";
import { dupKey, lintBatch, lintDraft, relintOpenBatches, type LintContext } from "./lint";

const H = "+13015550123";

function draft(o: Partial<Draft> = {}): Draft {
  return {
    id: "d1", batch_id: "b1", position: 0, contact_id: "c1", proposed_contact: null, create_contact: false, recipient_name: "Jane",
    handle: H, service: "auto", body: "Hi Jane, are you free Friday?", version: 1, status: "review", confirmed: false, warnings: [], vars: {},
    notes: "", import_id: null, import_row: null, scheduled_for: null, created_at: "", updated_at: "", ...o,
  };
}
const codes = (w: Warning[]): WarningCode[] => w.map((x) => x.code);
const has = (d: Draft, code: WarningCode, ctx: LintContext = {}) => codes(lintDraft(d, ctx)).includes(code);

describe("lintDraft: pure rules", () => {
  test("a clean draft has no warnings", () => {
    expect(lintDraft(draft(), {})).toEqual([]);
  });

  test("empty_body", () => {
    expect(has(draft({ body: "" }), "empty_body")).toBe(true);
    expect(has(draft({ body: "  \n\t " }), "empty_body")).toBe(true);
    expect(has(draft({ body: "x" }), "empty_body")).toBe(false);
  });

  test("unresolved_var names every leftover token", () => {
    const w = lintDraft(draft({ body: "Hi {{first_name}}, from {{ org | Acme }} and {{city}}" }), {});
    const u = w.find((x) => x.code === "unresolved_var")!;
    expect(u.message).toContain("{{first_name}}");
    expect(u.message).toContain("{{org}}");
    expect(u.message).toContain("{{city}}");
    expect(w.filter((x) => x.code === "unresolved_var")).toHaveLength(1);
    expect(has(draft({ body: "Hi Jane {not a var}" }), "unresolved_var")).toBe(false);
  });

  test("empty_var: the body still matches the template render and a var is blank", () => {
    const tpl = "Hi {{first_name}}, how is {{org}}?";
    const d = draft({ vars: { first_name: "Jane", org: "" }, body: "Hi Jane, how is ?" });
    expect(has(d, "empty_var", { template: tpl })).toBe(true);
    expect(lintDraft(d, { template: tpl }).find((w) => w.code === "empty_var")!.message).toContain("{{org}}");
  });
  test("empty_var is not raised when the var has a fallback or a value", () => {
    expect(has(draft({ vars: { first_name: "" }, body: "Hi there" }), "empty_var", { template: "Hi {{first_name|there}}" })).toBe(false);
    expect(has(draft({ vars: { first_name: "Jane" }, body: "Hi Jane" }), "empty_var", { template: "Hi {{first_name}}" })).toBe(false);
  });
  test("empty_var needs a template", () => {
    expect(has(draft({ vars: { org: "" }, body: "At ." }), "empty_var", {})).toBe(false);
  });
  test("empty_var survives an edit that leaves the blank merge field in place", () => {
    expect(has(draft({ vars: { org: "" }, body: "Edited: {{org}} yes" }), "empty_var", { template: "At {{org}}" })).toBe(true);
  });

  test("duplicate_recipient is the same text to the same handle", () => {
    const d = draft({ body: "Hello " });
    const ctx = { duplicateCounts: new Map([[dupKey(H, "Hello"), 2]]) }; // bodies compare after trim
    expect(lintDraft(d, ctx).find((w) => w.code === "duplicate_recipient")!.message).toBe("The same text goes to this person 2 times");
    expect(has(d, "duplicate_recipient", { duplicateCounts: new Map([[dupKey(H, "Hello"), 1]]) })).toBe(false);
    expect(has(d, "duplicate_recipient", {})).toBe(false);
  });

  test("pending_elsewhere", () => {
    expect(has(draft(), "pending_elsewhere", { pendingElsewhere: new Set([H]) })).toBe(true);
    expect(has(draft(), "pending_elsewhere", { pendingElsewhere: new Set(["+1999"]) })).toBe(false);
  });

  test("recently_messaged shows the date", () => {
    const w = lintDraft(draft(), { recentlySent: new Map([[H, "2026-11-08T10:00:00.000Z"]]) });
    expect(w.find((x) => x.code === "recently_messaged")!.message).toContain("2026-11-08");
  });

  test("invalid_handle", () => {
    expect(has(draft({ handle: "5551234" }), "invalid_handle")).toBe(true);
    expect(has(draft({ handle: "not an email" }), "invalid_handle")).toBe(true);
    expect(has(draft({ handle: "" }), "invalid_handle")).toBe(true);
    expect(has(draft({ handle: "jane@example.com" }), "invalid_handle")).toBe(false);
    expect(has(draft({ handle: H }), "invalid_handle")).toBe(false);
  });

  test("non_mobile: toll-free and UK landline yes, mobile and email no", () => {
    expect(has(draft({ handle: "+18005550199" }), "non_mobile")).toBe(true);
    expect(has(draft({ handle: "+442079460958" }), "non_mobile")).toBe(true);
    expect(has(draft({ handle: "+447911123456" }), "non_mobile")).toBe(false);
    expect(has(draft({ handle: H }), "non_mobile")).toBe(false);
    expect(has(draft({ handle: "jane@example.com" }), "non_mobile")).toBe(false);
  });

  test("too_long: > 1000 characters", () => {
    expect(has(draft({ body: "x".repeat(1000) }), "too_long")).toBe(false);
    expect(has(draft({ body: "x".repeat(1001) }), "too_long")).toBe(true);
  });

  test("identical_to_template only when personalisation was asked for", () => {
    const tpl = "Hello there, join us Friday!";
    expect(has(draft({ body: tpl }), "identical_to_template", { template: tpl, instructions: "Personalise each message with something about the person" })).toBe(true);
    expect(has(draft({ body: tpl }), "identical_to_template", { template: tpl, instructions: "Customize per recipient" })).toBe(true);
    expect(has(draft({ body: tpl }), "identical_to_template", { template: tpl, instructions: "Send the same text to everyone" })).toBe(false);
    expect(has(draft({ body: tpl }), "identical_to_template", { template: tpl })).toBe(false);
    expect(has(draft({ body: tpl + "!" }), "identical_to_template", { template: tpl, instructions: "personalize" })).toBe(false);
  });

  test("new_contact: no contact id but a proposed contact", () => {
    const pc = { given_name: "A", family_name: "B", phones: [], emails: [] };
    expect(has(draft({ contact_id: null, proposed_contact: pc }), "new_contact")).toBe(true);
    expect(has(draft({ contact_id: "c1", proposed_contact: pc }), "new_contact")).toBe(false);
    expect(has(draft({ contact_id: null, proposed_contact: null }), "new_contact")).toBe(false);
  });

  test("ambiguous_contact comes from the import row and replaces new_contact", () => {
    const importRows = new Map([["i1#3", { match: "ambiguous" as const, issues: [{ code: "ambiguous_name" as const, message: "", candidates: [{ contact_id: "c9", display_name: "Bob Jones", phones: [], emails: [] }] }] }]]);
    const d = draft({ contact_id: null, import_id: "i1", import_row: 3 });
    const w = lintDraft(d, { importRows });
    expect(w.find((x) => x.code === "ambiguous_contact")!.message).toContain("Bob Jones");
    expect(codes(lintDraft({ ...d, proposed_contact: { given_name: "", family_name: "", phones: [], emails: [] } }, { importRows }))).not.toContain("new_contact");
    expect(has(draft({ import_id: "i1", import_row: 4 }), "ambiguous_contact", { importRows })).toBe(false);
  });

  describe("link_in_first_message", () => {
    const bodies: [string, boolean][] = [
      ["Check https://example.com/rsvp", true],
      ["See http://x.io", true],
      ["go to www.example.org today", true],
      ["Details at example.com/rsvp", true],
      ["rsvp at bit.ly/abc123", true],
      ["Email me at jane@example.com", false],
      ["e.g. this works. i.e. fine", false],
      ["See you at 5.30 pm, ok.", false],
      ["No link here", false],
    ];
    for (const [body, want] of bodies) test(JSON.stringify(body), () => expect(has(draft({ body }), "link_in_first_message", { priorSends: new Set() })).toBe(want));

    test("not raised once there's a prior send to that handle", () => {
      expect(has(draft({ body: "https://example.com" }), "link_in_first_message", { priorSends: new Set([H]) })).toBe(false);
    });
  });

  test("warnings are plain {code, message} objects", () => {
    for (const w of lintDraft(draft({ body: "" , handle: "x"}), {})) {
      expect(Object.keys(w).sort()).toEqual(["code", "message"]);
      expect(w.message.length).toBeGreaterThan(5);
    }
  });
});

// ------------------------------------------------------------------ lintBatch against the DB
function approval(db: Database, batchId: string): string {
  const id = newId();
  db.query(`INSERT INTO approvals(id,batch_id,manifest,manifest_sha256,credential_id,authenticator_data_b64,client_data_json_b64,signature_b64,not_after,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, batchId, "{}", "00", "cred", "a", "b", "c", nowIso(), nowIso());
  return id;
}
function addSend(db: Database, draftId: string, batchId: string, result: "sent" | "failed" | "unknown", at: Date): void {
  db.query(`INSERT INTO sends(id,draft_id,approval_id,attempt,transport,started_at,finished_at,result) VALUES (?,?,?,?,?,?,?,?)`)
    .run(newId(), draftId, approval(db, batchId), 1, "dry", at.toISOString(), at.toISOString(), result);
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const warnCodes = (db: Database, batchId: string, i = 0) => getDrafts(db, batchId)[i]!.warnings.map((w) => w.code);

function mkBatch(db: Database, opts: { template?: string; instructions?: string; status?: any } = {}) {
  return createBatch(db, { title: "t", created_by: "test", source: "cli", template: opts.template ?? null, instructions: opts.instructions ?? null, status: opts.status });
}
const add = (db: Database, b: string, handle: string, body = "Hello there", extra: Record<string, unknown> = {}) =>
  addDraft(db, b, { handle, body, actor: "template", ...extra });

describe("lintBatch", () => {
  test("writes warnings_json for every draft", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, H, "ok");
    add(db, b, "5551234", "");
    lintBatch(db, b);
    const ds = getDrafts(db, b);
    expect(ds[0]!.warnings).toEqual([]);
    expect(ds[1]!.warnings.map((w) => w.code).sort()).toEqual(["empty_body", "invalid_handle"]);
  });

  test("is idempotent and replaces stale warnings", () => {
    const db = memDb();
    const b = mkBatch(db);
    const d = add(db, b, H, "ok", { warnings: [{ code: "too_long", message: "stale" }] });
    lintBatch(db, b);
    expect(getDrafts(db, b)[0]!.warnings).toEqual([]);
    lintBatch(db, b);
    expect(getDrafts(db, b)[0]!.warnings).toEqual([]);
    expect(d).toBeTruthy();
  });

  test("a missing batch throws; an empty batch is a no-op", () => {
    const db = memDb();
    expect(() => lintBatch(db, "nope")).toThrow();
    lintBatch(db, mkBatch(db));
  });

  test("a chain (different texts to one handle) is not a duplicate", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, H, "Hey, you're invited"); add(db, b, H, "https://example.com/rsvp");
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).not.toContain("duplicate_recipient");
    expect(warnCodes(db, b, 1)).not.toContain("duplicate_recipient");
    // the same text to a different handle is not a duplicate either
    add(db, b, "+12025550100", "Hey, you're invited");
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).not.toContain("duplicate_recipient");
  });

  test("duplicate_recipient within the batch, ignoring skipped drafts", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, H); add(db, b, H);
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).toContain("duplicate_recipient");
    expect(warnCodes(db, b, 1)).toContain("duplicate_recipient");
    db.query("UPDATE drafts SET status = 'skipped' WHERE batch_id = ? AND position = 1").run(b);
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).not.toContain("duplicate_recipient");
  });

  test("pending_elsewhere: another live batch with a draft in draft/review/approved", () => {
    const db = memDb();
    const other = mkBatch(db);
    add(db, other, H);
    const b = mkBatch(db);
    add(db, b, H); add(db, b, "+12025550143");
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).toContain("pending_elsewhere");
    expect(warnCodes(db, b, 1)).not.toContain("pending_elsewhere");
    // the other batch sees this one too
    lintBatch(db, other);
    expect(warnCodes(db, other, 0)).toContain("pending_elsewhere");
  });

  test("pending_elsewhere ignores sent drafts, rejected drafts and cancelled batches", () => {
    const db = memDb();
    const other = mkBatch(db);
    const od = add(db, other, H);
    const b = mkBatch(db);
    add(db, b, H);
    for (const st of ["sent", "rejected", "failed", "skipped", "unknown"]) {
      db.query("UPDATE drafts SET status = ? WHERE id = ?").run(st, od);
      lintBatch(db, b);
      expect(warnCodes(db, b)).not.toContain("pending_elsewhere");
    }
    db.query("UPDATE drafts SET status = 'approved' WHERE id = ?").run(od);
    lintBatch(db, b);
    expect(warnCodes(db, b)).toContain("pending_elsewhere");
    setBatchStatus(db, other, "cancelled", "test");
    lintBatch(db, b);
    expect(warnCodes(db, b)).not.toContain("pending_elsewhere");
  });

  test("recently_messaged: a 'sent' send within 7 days", () => {
    const db = memDb();
    const old = mkBatch(db, { status: "done" });
    const od = add(db, old, H);
    addSend(db, od, old, "sent", ago(3));
    const b = mkBatch(db);
    add(db, b, H);
    lintBatch(db, b);
    expect(warnCodes(db, b)).toContain("recently_messaged");
  });

  test("recently_messaged ignores old sends, failures and other handles", () => {
    const db = memDb();
    const old = mkBatch(db, { status: "done" });
    const d1 = add(db, old, H); const d2 = add(db, old, "+12025550143"); const d3 = add(db, old, "+14155550132");
    addSend(db, d1, old, "sent", ago(8));
    addSend(db, d2, old, "failed", ago(1));
    addSend(db, d3, old, "sent", ago(1));
    const b = mkBatch(db);
    add(db, b, H); add(db, b, "+12025550143");
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).not.toContain("recently_messaged");
    expect(warnCodes(db, b, 1)).not.toContain("recently_messaged");
  });

  test("recently_messaged window honours the `now` option", () => {
    const db = memDb();
    const old = mkBatch(db, { status: "done" });
    const od = add(db, old, H);
    addSend(db, od, old, "sent", ago(10));
    const b = mkBatch(db);
    add(db, b, H);
    lintBatch(db, b, { now: ago(5) }); // 5 days after that send
    expect(warnCodes(db, b)).toContain("recently_messaged");
    lintBatch(db, b);
    expect(warnCodes(db, b)).not.toContain("recently_messaged");
  });

  test("link_in_first_message: only when no earlier send to the handle exists", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, H, "RSVP at https://example.com/rsvp");
    lintBatch(db, b);
    expect(warnCodes(db, b)).toContain("link_in_first_message");

    const old = mkBatch(db, { status: "done" });
    const od = add(db, old, H);
    addSend(db, od, old, "sent", ago(30));
    lintBatch(db, b);
    expect(warnCodes(db, b)).not.toContain("link_in_first_message");
  });

  test("a failed earlier send doesn't count as a prior conversation", () => {
    const db = memDb();
    const old = mkBatch(db, { status: "done" });
    const od = add(db, old, H);
    addSend(db, od, old, "failed", ago(30));
    const b = mkBatch(db);
    add(db, b, H, "https://example.com");
    lintBatch(db, b);
    expect(warnCodes(db, b)).toContain("link_in_first_message");
  });

  test("identical_to_template uses the batch template and instructions", () => {
    const db = memDb();
    const b = mkBatch(db, { template: "Join us Friday", instructions: "Personalise each message" });
    add(db, b, H, "Join us Friday"); add(db, b, "+12025550143", "Hi Bob, join us Friday");
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).toContain("identical_to_template");
    expect(warnCodes(db, b, 1)).not.toContain("identical_to_template");
  });

  test("empty_var uses the template and draft vars", () => {
    const db = memDb();
    const b = mkBatch(db, { template: "Hi {{first_name}} from {{org}}" });
    add(db, b, H, "Hi Jane from ", { vars: { first_name: "Jane", org: "" } });
    lintBatch(db, b);
    expect(warnCodes(db, b)).toContain("empty_var");
  });

  test("new_contact and ambiguous_contact from the import rows", () => {
    const db = memDb();
    const importId = newId();
    db.query("INSERT INTO imports(id,filename,sha256,kind,stored_path,created_by,created_at) VALUES (?,?,?,?,?,?,?)").run(importId, "f", "0", "csv", "/x", "t", nowIso());
    db.query("INSERT INTO import_rows(import_id,row_index,raw_json,match,issues_json) VALUES (?,?,?,?,?)")
      .run(importId, 0, "{}", "ambiguous", JSON.stringify([{ code: "ambiguous_name", message: "m", candidates: [{ contact_id: "x", display_name: "Bob Jones", phones: [], emails: [] }] }]));
    db.query("INSERT INTO import_rows(import_id,row_index,raw_json,match,issues_json) VALUES (?,?,?,?,?)").run(importId, 1, "{}", "new", "[]");
    const b = mkBatch(db);
    add(db, b, H, "hi", { import_id: importId, import_row: 0 });
    add(db, b, "+12025550143", "hi", { import_id: importId, import_row: 1, proposed_contact: { given_name: "A", family_name: "B", phones: [], emails: [] } });
    lintBatch(db, b);
    expect(warnCodes(db, b, 0)).toContain("ambiguous_contact");
    expect(warnCodes(db, b, 1)).toContain("new_contact");
  });

  test("non_mobile, invalid_handle and too_long flow through", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, "+18005550199", "x".repeat(1200));
    lintBatch(db, b);
    expect(warnCodes(db, b).sort()).toEqual(["non_mobile", "too_long"]);
  });

  test("drafts that are sending or sent keep their warnings untouched", () => {
    const db = memDb();
    const b = mkBatch(db);
    const d = add(db, b, H, "ok", { warnings: [{ code: "too_long", message: "kept" }] });
    db.query("UPDATE drafts SET status = 'sent' WHERE id = ?").run(d);
    lintBatch(db, b);
    expect(getDrafts(db, b)[0]!.warnings).toEqual([{ code: "too_long", message: "kept" }]);
  });

  test("lint doesn't change body, version, status or updated_at", () => {
    const db = memDb();
    const b = mkBatch(db);
    add(db, b, H, "ok");
    const before = db.query("SELECT body, version, status, updated_at FROM drafts").get();
    lintBatch(db, b);
    expect(db.query("SELECT body, version, status, updated_at FROM drafts").get()).toEqual(before as any);
  });

  test("every WarningCode is produced by some rule (guards against a code silently going unused)", () => {
    const all: WarningCode[] = ["unresolved_var", "empty_var", "duplicate_recipient", "pending_elsewhere", "recently_messaged", "invalid_handle", "non_mobile", "too_long", "identical_to_template", "empty_body", "new_contact", "ambiguous_contact", "link_in_first_message"];
    const importRows = new Map([["i#0", { match: "ambiguous" as const, issues: [] }]]);
    const ctx: LintContext = {
      template: "Hi {{org}}", instructions: "personalise", duplicateCounts: new Map([[dupKey("bad", "Hi {{org}} http://x.com " + "x".repeat(1100)), 2]]), pendingElsewhere: new Set(["bad"]),
      recentlySent: new Map([["bad", "2026-01-01T00:00:00Z"]]), priorSends: new Set(), importRows,
    };
    const seen = new Set<WarningCode>();
    const feed = (d: Draft) => lintDraft(d, ctx).forEach((w) => seen.add(w.code));
    feed(draft({ handle: "bad", body: "Hi {{org}} http://x.com " + "x".repeat(1100), vars: { org: "" } }));
    feed(draft({ handle: "+18005550199", body: "Hi {{org}}", contact_id: null, proposed_contact: { given_name: "", family_name: "", phones: [], emails: [] } }));
    feed(draft({ body: "", contact_id: null, import_id: "i", import_row: 0 }));
    feed(draft({ body: "Hi ", vars: { org: "" } }));
    feed(draft({ body: ctx.template! }));
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

describe("lintBatch: the same contact", () => {
  test("a chain to one contact, or two numbers for it with different texts, is no duplicate", () => {
    const db = memDb();
    const cid = newId();
    db.query("INSERT INTO contacts(id, source, display_name, updated_at) VALUES (?, 'macos', 'Jane Smith', ?)").run(cid, nowIso());
    const b = createBatch(db, { title: "t", created_by: "agent:x", source: "mcp", status: "review" });
    const a = addDraft(db, b, { handle: "+13015550123", body: "Hi Jane", contact_id: cid, actor: "agent" });
    const c = addDraft(db, b, { handle: "+13015550123", body: "Here's the link", contact_id: cid, actor: "agent" });
    const e = addDraft(db, b, { handle: "+12025550143", body: "Hi Jane!", contact_id: cid, actor: "agent" });
    lintBatch(db, b);
    for (const id of [a, c, e]) expect(getDrafts(db, b).find((d) => d.id === id)!.warnings.map((x) => x.code)).not.toContain("duplicate_recipient");
  });

  test("the same text twice to one handle flags both; skipping one clears the other", () => {
    const db = memDb();
    const b = createBatch(db, { title: "t", created_by: "agent:x", source: "mcp", status: "review" });
    const a = addDraft(db, b, { handle: "+13015550123", body: "Hi", actor: "agent" });
    const c = addDraft(db, b, { handle: "+13015550123", body: "Hi", actor: "agent" });
    lintBatch(db, b);
    const w = (id: string) => getDrafts(db, b).find((d) => d.id === id)!.warnings;
    for (const id of [a, c]) expect(w(id).map((x) => x.code)).toContain("duplicate_recipient");
    db.query("UPDATE drafts SET status = 'skipped' WHERE id = ?").run(c);
    lintBatch(db, b);
    expect(w(a).map((x) => x.code)).not.toContain("duplicate_recipient");
  });
});

describe("relintOpenBatches", () => {
  test("refreshes stale stored warnings in drafting/review batches only", () => {
    const db = memDb();
    const mk = (status: "review" | "drafting" | "approved") => {
      const b = createBatch(db, { title: "t", created_by: "agent:x", source: "mcp", status });
      const a = addDraft(db, b, { handle: H, body: "invite", actor: "agent", warnings: [{ code: "duplicate_recipient", message: "old rule" }] });
      const c = addDraft(db, b, { handle: H, body: "link", actor: "agent", warnings: [{ code: "duplicate_recipient", message: "old rule" }] });
      return { b, a, c };
    };
    const rev = mk("review"), dr = mk("drafting"), ap = mk("approved");
    expect(relintOpenBatches(db)).toBe(2);
    const codes = (x: { b: string; a: string }) => getDrafts(db, x.b).find((d) => d.id === x.a)!.warnings.map((w) => w.code);
    expect(codes(rev)).not.toContain("duplicate_recipient");
    expect(codes(dr)).not.toContain("duplicate_recipient");
    expect(codes(ap)).toContain("duplicate_recipient"); // approved batches are left as they were
  });
});
