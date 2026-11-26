// /api/contact-changes: the owner's view of contact change sets, plus reject, cancel, Touch ID approval and undo.
// Same session + CSRF middleware as every /api route (index.ts); every write is audited.
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  contactChangeView, contactSetCounts, getContactChanges, getContactSet, rowToContactChange,
} from "../core/contact-changes";
import { getSettings } from "../core/store";
import type { ContactChange } from "../core/types";
import type { OwnerConfig } from "./config";
import { badRequest, notFound } from "./errors";
import { type FailureLimiter } from "./auth";
import {
  cancelContactSet, contactApproveOptions, coveringContactApproval, createUndoSets, liveContactApprovals, parseContactManifest,
  rejectContactChanges, undoBlockReason,
} from "./contact-approval";
import { readJson } from "./schemas";
import { pinContactsLiveAllowed } from "./status";

const OWNER = "owner";
const SET_STATUSES = ["drafting", "review", "approved", "applying", "done", "cancelled"] as const;
const ids = z.array(z.string().max(100)).min(1).max(500);

type LimiterFor = (c: Context, route: string) => FailureLimiter;

export function registerContactApi(app: Hono, cfg: OwnerConfig, limiterFor: LimiterFor): void {
  const db = (): Database => cfg.db();

  // Sets, newest first, with change counts. `status` filters the set status.
  app.get("/api/contact-changes", (c) => {
    const status = c.req.query("status");
    if (status && !(SET_STATUSES as readonly string[]).includes(status)) throw badRequest(`status must be one of ${SET_STATUSES.join(", ")}`);
    const rows = (status
      ? db().query("SELECT * FROM contact_change_sets WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(status)
      : db().query("SELECT * FROM contact_change_sets ORDER BY created_at DESC LIMIT 200").all()) as any[];
    return c.json({ sets: rows.map((s) => ({ ...s, counts: contactSetCounts(db(), s.id) })) });
  });

  /** The set, each change with its parsed payload, the cached card it is about, which live approval covers it and whether it
   *  can be undone, plus the approvals made for the set. */
  app.get("/api/contact-changes/:id", (c) => {
    const set = getContactSet(db(), c.req.param("id"));
    if (!set) throw notFound("Contact change set not found.");
    const live = liveContactApprovals(db(), set.id);
    const changes = getContactChanges(db(), set.id).map((ch: ContactChange) => {
      const orig = ch.kind === "undo" && ch.undo_of ? db().query("SELECT * FROM contact_changes WHERE id = ?").get(ch.undo_of) : null;
      return {
        ...contactChangeView(db(), ch),
        covered_by: ch.status === "approved" ? coveringContactApproval(db(), ch, live) : null,
        undo_blocked: ch.status === "applied" ? undoBlockReason(db(), ch) : "not applied",
        original: orig ? (({ kind, payload, status }) => ({ kind, payload, status }))(rowToContactChange(orig)) : null,
      };
    });
    const approvals = db().query<any, [string]>("SELECT id, created_at, not_after, revoked_at, manifest FROM contact_approvals WHERE set_id = ? ORDER BY created_at DESC").all(set.id)
      .map((a) => { const m = parseContactManifest(a); return { id: a.id, created_at: a.created_at, not_after: a.not_after, revoked_at: a.revoked_at, items: m?.contact_items.length ?? 0, transport: m?.transport ?? null }; });
    return c.json({
      set, counts: contactSetCounts(db(), set.id), changes, approvals,
      contacts_transport: getSettings(db()).contacts_transport,
      pin_contacts_live_allowed: pinContactsLiveAllowed(cfg),
    });
  });

  app.post("/api/contact-changes/:id/reject", async (c) => {
    const body = await readJson(c, z.object({ change_ids: ids }));
    return c.json({ ok: true, ...rejectContactChanges(db(), c.req.param("id"), body.change_ids, OWNER) });
  });

  app.post("/api/contact-changes/:id/cancel", (c) => c.json({ ok: true, ...cancelContactSet(db(), c.req.param("id"), OWNER) }));

  app.post("/api/contact-changes/:id/approve/options", async (c) => {
    const body = await readJson(c, z.object({ change_ids: ids, signer: z.literal("secure-enclave").optional() }));
    const r = await contactApproveOptions(cfg, db(), c.req.param("id"), body.change_ids);
    // When transport is live but the installed pin lacks contacts_live_allowed, the executor applies dry; the sheet says so.
    return c.json({ ...r, pin_contacts_live_allowed: pinContactsLiveAllowed(cfg) });
  });

  // Undo: makes a new set of kind='undo' changes in review. It is approved like any other (Touch ID).
  app.post("/api/contact-changes/undo", async (c) => {
    const body = await readJson(c, z.object({ change_ids: ids }));
    const r = createUndoSets(db(), body.change_ids, OWNER);
    return c.json({ ok: true, set_id: r.sets[0]!.set_id, ...r });
  });
}
