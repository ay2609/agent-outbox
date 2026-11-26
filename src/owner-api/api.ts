// The /api routes (everything except /api/auth). All of these sit behind the session + CSRF middleware in index.ts.
//
// Every read-then-write section is `db.transaction(fn).immediate()`: a deferred transaction that
// reads and then writes hits SQLITE_BUSY_SNAPSHOT when another connection (the executor, the agent API) writes in between.
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { audit, getBatch, getContact, getDrafts, getSettings, rowToContact, rowToDraft, setBatchStatus, setSetting } from "../core/store";
import { pickHandle } from "../core/contact-pick";
import { paths } from "../core/paths";
import type { Draft, ProposedContact, Service, SettingKey, Warning } from "../core/types";
import { pacingProblem, type Pacing } from "../core/pacing";
import { nowIso } from "../db";
import type { OwnerConfig } from "./config";
import { ApiError, badRequest, conflict, notFound } from "./errors";
import {
  APPROVABLE, approveOptions, canonicalProposed, contactHandlesExact, coverageMap, numberInContact, revokeApprovals, undoStop,
} from "./approval";
import { type FailureLimiter, nativeKeyCount, normalizePolicy, setPinPolicy, writePinFiles, getPinPolicy, pinText } from "./auth";
import { loadB, tryLint } from "./integrations";
import { readJson } from "./schemas";
import { buildStatus, pinContactsLiveAllowed, pinLiveAllowed, pinMode } from "./status";
import { registerContactApi } from "./contact-api";
import { registerGroupsApi } from "./groups-api";
import { restoreContactApprovals, revokeContactApprovals } from "./contact-approval";
import { sha256Hex } from "./b64";
import { requireReauth, seReauthSchema } from "./native";

const OWNER = "owner";
/** Statuses no owner edit may touch: the executor owns them. (`unknown` = sent but unconfirmed; never edit or resend.) */
const LOCKED = ["sending", "sent", "unknown", "rejected"] as const;
const LOCKED_SQL = `status NOT IN ('sending','sent','unknown','rejected')`;

export type LimiterFor = (c: Context, route: string) => FailureLimiter;

export function registerApi(app: Hono, cfg: OwnerConfig, limiterFor: LimiterFor): void {
  const db = (): Database => cfg.db();
  const tx = <T>(fn: () => T): T => db().transaction(fn).immediate();

  // ---------- status ----------
  app.get("/api/status", (c) => c.json(buildStatus(cfg, db())));

  // ---------- pin policy ----------
  // Always written to the user pin. Simple mode: takes effect at once, so turning live (sending or contacts) ON needs a fresh
  // Touch ID confirmation (se_reauth). Hardened mode: only the candidate changes; the root pin changes when the user re-runs the harden command.
  const policySchema = z.object({
    live_allowed: z.boolean(),
    /** v4. Left out = keep what the stored policy already says. */
    contacts_live_allowed: z.boolean().optional(),
    se_reauth: seReauthSchema.optional(),
  }).strict();
  app.get("/api/pin-policy", (c) => c.json({ policy: getPinPolicy(db()), mode: pinMode(cfg) }));
  app.put("/api/pin-policy", async (c) => {
    const { se_reauth, ...body } = await readJson(c, policySchema);
    const before = getPinPolicy(db());
    // contacts_live_allowed left out keeps a stored `true`; with nothing stored it stays absent (= false), as in older pins.
    const keep = before.contacts_live_allowed === true ? true : undefined;
    const p = normalizePolicy({ ...body, contacts_live_allowed: body.contacts_live_allowed ?? keep });
    if (!p) throw badRequest("Invalid policy.");
    const turningOn = (p.live_allowed && !before.live_allowed) || (p.contacts_live_allowed === true && before.contacts_live_allowed !== true);
    if (turningOn && pinMode(cfg) === "simple") {
      requireReauth(c, cfg, limiterFor, { se_reauth }, "policy_live", "In simple mode this takes effect at once, so it needs a Touch ID confirmation.");
    }
    tx(() => setPinPolicy(db(), p, OWNER));
    writePinFiles(cfg, db());
    return c.json({ policy: p, status: buildStatus(cfg, db()).pin });
  });

  // ---------- batches ----------
  app.get("/api/batches", (c) => {
    const status = c.req.query("status");
    const rows = status
      ? db().query("SELECT * FROM batches WHERE status = ? ORDER BY created_at DESC LIMIT 300").all(status)
      : db().query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 300").all();
    const stats = db().query<{ batch_id: string; status: string; n: number; w: number; nc: number }, []>(
      `SELECT batch_id, status, COUNT(*) AS n, SUM(warnings_json NOT IN ('[]','')) AS w,
              SUM(proposed_contact_json IS NOT NULL AND create_contact = 1) AS nc FROM drafts GROUP BY batch_id, status`).all();
    const by = new Map<string, { counts: Record<string, number>; total: number; warnings: number; new_contacts: number }>();
    for (const s of stats) {
      const e = by.get(s.batch_id) ?? { counts: {}, total: 0, warnings: 0, new_contacts: 0 };
      e.counts[s.status] = s.n; e.total += s.n; e.warnings += s.w ?? 0; e.new_contacts += s.nc ?? 0;
      by.set(s.batch_id, e);
    }
    return c.json({ batches: (rows as any[]).map((b) => ({ ...b, ...(by.get(b.id) ?? { counts: {}, total: 0, warnings: 0, new_contacts: 0 }) })) });
  });

  app.get("/api/batches/:id", (c) => {
    const batch = getBatch(db(), c.req.param("id"));
    if (!batch) throw notFound("Batch not found.");
    const drafts = getDrafts(db(), batch.id);
    const sends = db().query<any, [string]>(
      `SELECT s.* FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE d.batch_id = ? ORDER BY s.started_at`).all(batch.id);
    const lastSend = new Map<string, any>();
    for (const s of sends) lastSend.set(s.draft_id, s);
    const approvals = db().query<any, [string]>(
      "SELECT id, created_at, not_after, revoked_at, manifest FROM approvals WHERE batch_id = ? ORDER BY created_at DESC").all(batch.id)
      .map((a) => ({ id: a.id, created_at: a.created_at, not_after: a.not_after, revoked_at: a.revoked_at, items: safeCount(a.manifest), transport: safeTransport(a.manifest) }));
    const cover = coverageMap(db(), drafts);
    return c.json({
      batch,
      drafts: drafts.map((d) => ({
        ...d, last_send: lastSend.get(d.id) ?? null,
        /** Id of the LIVE approval that covers this draft right now (null = free to approve). The app leaves covered drafts out of the selection. */
        covered_by: cover.get(d.id) ?? null,
        contact: contactInfo(db(), d.contact_id),
        number_in_contact: numberInContact(db(), d),
        candidates: d.warnings.some((w) => w.code === "ambiguous_contact") ? candidatesFor(db(), d) : [],
      })),
      approvals, settings: getSettings(db()),
    });
  });

  app.post("/api/batches/:id/approve/options", async (c) => {
    const body = await readJson(c, z.object({
      draft_ids: z.array(z.string().max(100)).min(1).max(500),
      include_anyway: z.array(z.string().max(100)).max(500).optional(),
      signer: z.literal("secure-enclave").optional(),
    }));
    const r = await approveOptions(cfg, db(), c.req.param("id"), body.draft_ids, body.include_anyway ?? []);
    return c.json({ ...r,
      /** Does the EFFECTIVE pin (root if installed, else the user pin) allow live? When transport is live but this is false, the executor will not really send. */
      pin_live_allowed: pinLiveAllowed(cfg) });
  });

  app.post("/api/batches/:id/cancel", (c) => {
    const id = c.req.param("id");
    const r = tx(() => {
      const batch = getBatch(db(), id);
      if (!batch) throw notFound("Batch not found.");
      if (batch.status === "done" || batch.status === "cancelled") throw conflict("batch_closed", `This batch is already ${batch.status}.`);
      const rev = revokeApprovals(db(), { batchId: id }, OWNER, "batch cancelled");
      const t = nowIso();
      const n = db().query(`UPDATE drafts SET status = 'rejected', updated_at = ? WHERE batch_id = ? AND status IN ('draft','review','approved','failed','skipped')`).run(t, id).changes;
      db().query("DELETE FROM owner_challenges WHERE kind IN ('send','contacts') AND target = ?").run(id);
      setBatchStatus(db(), id, "cancelled", OWNER);
      audit(db(), OWNER, "batch.cancel", id, { revoked: rev.approvals, rejected: n });
      return { revoked_approvals: rev.approvals, rejected_drafts: n };
    });
    return c.json({ ok: true, ...r });
  });

  /** Bulk exclude / include (the "Exclude all with warnings" button). Approved and locked drafts are left alone. */
  app.post("/api/batches/:id/skip", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c, z.object({ draft_ids: z.array(z.string().max(100)).min(1).max(500), skipped: z.boolean().default(true) }));
    const r = tx(() => {
      if (!getBatch(db(), id)) throw notFound("Batch not found.");
      const t = nowIso();
      let changed = 0;
      for (const did of new Set(body.draft_ids)) {
        changed += body.skipped
          ? db().query("UPDATE drafts SET status = 'skipped', updated_at = ? WHERE id = ? AND batch_id = ? AND status IN ('draft','review','failed')").run(t, did, id).changes
          : db().query("UPDATE drafts SET status = 'review', updated_at = ? WHERE id = ? AND batch_id = ? AND status = 'skipped'").run(t, did, id).changes;
      }
      audit(db(), OWNER, body.skipped ? "draft.skip_many" : "draft.include_many", id, { requested: body.draft_ids.length, changed });
      return { changed };
    });
    return c.json({ ok: true, ...r });
  });

  // ---------- drafts ----------
  const patchSchema = z.object({
    body: z.string().max(20000).optional(),
    service: z.enum(["iMessage", "SMS", "auto"]).optional(),
    create_contact: z.boolean().optional(),
    handle: z.string().min(1).max(320).optional(),
    /** Link the message to an existing contact (the ambiguous-contact picker). Sets the name, clears the new-contact proposal. */
    contact_id: z.string().min(1).max(100).optional(),
  }).refine((v) => Object.keys(v).length > 0, "Nothing to change.");

  app.patch("/api/drafts/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await readJson(c, patchSchema);
    const newHandle = patch.handle !== undefined ? await resolveHandle(patch.handle) : undefined;
    const out = tx(() => {
      const row = db().query("SELECT * FROM drafts WHERE id = ?").get(id);
      if (!row) throw notFound("Message not found.");
      const cur = rowToDraft(row);
      if ((LOCKED as readonly string[]).includes(cur.status)) throw conflict("draft_locked", `A ${cur.status} message can't be edited.`);
      const t = nowIso();

      let handle = cur.handle, contactId = cur.contact_id, name = cur.recipient_name;
      let proposed: ProposedContact | null = cur.proposed_contact, create = cur.create_contact;
      let changed = false;

      if (patch.contact_id !== undefined) {
        const ct = getContact(db(), patch.contact_id);
        if (!ct) throw badRequest("That contact doesn't exist.");
        const handles = db().query<{ handle: string }, [string]>("SELECT handle FROM contact_handles WHERE contact_id = ?").all(ct.id).map((r) => r.handle);
        const want = newHandle ?? (handles.includes(cur.handle) ? cur.handle : pickHandle(ct)?.handle);
        if (!want || !handles.includes(want)) throw badRequest("That number or email isn't one of the contact's.");
        contactId = ct.id; handle = want; name = ct.display_name || name; proposed = null; create = false;
      } else if (newHandle !== undefined) {
        handle = newHandle;
      }
      if (patch.create_contact !== undefined) {
        if (patch.create_contact) {
          if (!proposed) {
            // "Keep this number and create a new contact" for an ambiguous match: build the proposal from the message itself.
            if (!cur.warnings.some((w) => w.code === "ambiguous_contact") || !name.trim()) throw badRequest("This message has no proposed contact to create.");
            const [given, ...rest] = name.trim().split(/\s+/);
            proposed = { given_name: given ?? "", family_name: rest.join(" "), phones: [], emails: [] };
          }
          create = true; contactId = patch.contact_id !== undefined ? contactId : null;
        } else create = false;
      }
      // Whenever contact creation is on, or the number changed, the proposal's handles are reduced to exactly the draft's handle.
      if (proposed && (create || handle !== cur.handle || (patch.create_contact === true))) proposed = canonicalProposed(proposed, handle);
      if (create && proposed && !contactHandlesExact(proposed, handle)) throw badRequest("The new contact's number doesn't match this message's recipient.");

      const proposedJson = proposed ? JSON.stringify(proposed) : null;
      const curProposedJson = cur.proposed_contact ? JSON.stringify(cur.proposed_contact) : null;
      const service = patch.service ?? cur.service;
      const fieldsChanged = service !== cur.service || handle !== cur.handle || contactId !== cur.contact_id || name !== cur.recipient_name
        || create !== cur.create_contact || proposedJson !== curProposedJson;
      const bodyChanged = patch.body !== undefined && patch.body !== cur.body;

      if (fieldsChanged || bodyChanged) {
        const v = bodyChanged ? cur.version + 1 : cur.version;
        // An approved draft that changes drops back to review: its signed item no longer matches, so the executor refuses it anyway.
        const r = db().query(
          `UPDATE drafts SET service = ?, handle = ?, contact_id = ?, recipient_name = ?, create_contact = ?, proposed_contact_json = ?,
             body = ?, version = ?, status = CASE WHEN status = 'approved' THEN 'review' ELSE status END, updated_at = ?
           WHERE id = ? AND ${LOCKED_SQL}`,
        ).run(service, handle, contactId, name, create ? 1 : 0, proposedJson, bodyChanged ? patch.body! : cur.body, v, t, id);
        if (r.changes === 0) throw conflict("draft_locked", "That message started sending and can't be edited now.");
        if (bodyChanged) db().query("INSERT INTO draft_revisions(draft_id, version, body, actor, at) VALUES (?,?,?,?,?)").run(id, v, patch.body!, "owner", t);
        changed = true;
      }
      audit(db(), OWNER, "draft.edit", id, { fields: Object.keys(patch).filter((k) => k !== "body"), body_changed: bodyChanged, was_approved: cur.status === "approved", changed });
      return cur.batch_id;
    });
    await tryLint(db(), out);
    return c.json({ draft: rowToDraft(db().query("SELECT * FROM drafts WHERE id = ?").get(id)) });
  });

  app.post("/api/drafts/:id/skip", (c) => {
    const id = c.req.param("id");
    const r = tx(() => {
      const row = db().query("SELECT * FROM drafts WHERE id = ?").get(id);
      if (!row) throw notFound("Message not found.");
      const d = rowToDraft(row);
      if (!["draft", "review", "approved", "failed"].includes(d.status)) throw conflict("draft_locked", `A ${d.status} message can't be skipped.`);
      // A signed approval can't be edited per message, so skipping an approved message revokes the whole approval;
      // its other messages go back to review and need a fresh approval.
      const rev = d.status === "approved" ? revokeApprovals(db(), { draftId: id }, OWNER, "draft skipped") : { approvals: 0, drafts: 0 };
      const u = db().query(`UPDATE drafts SET status = 'skipped', updated_at = ? WHERE id = ? AND ${LOCKED_SQL}`).run(nowIso(), id);
      if (u.changes === 0) throw conflict("draft_locked", "That message started sending and can't be skipped now.");
      audit(db(), OWNER, "draft.skip", id, { revoked_approvals: rev.approvals });
      return rev;
    });
    return c.json({ ok: true, revoked_approvals: r.approvals, reverted_drafts: Math.max(0, r.drafts - 1) });
  });
  app.post("/api/drafts/:id/include", (c) => {
    const id = c.req.param("id");
    tx(() => {
      const row = db().query("SELECT status FROM drafts WHERE id = ?").get(id) as { status: string } | null;
      if (!row) throw notFound("Message not found.");
      if (row.status !== "skipped") throw conflict("draft_not_skipped", "Only skipped messages can be included again.");
      if (db().query("UPDATE drafts SET status = 'review', updated_at = ? WHERE id = ? AND status = 'skipped'").run(nowIso(), id).changes === 0) {
        throw conflict("draft_not_skipped", "Only skipped messages can be included again.");
      }
      audit(db(), OWNER, "draft.include", id);
    });
    return c.json({ ok: true });
  });

  // ---------- stop / resume ----------
  app.post("/api/stop", (c) => {
    const r = tx(() => {
      const prev = getSettings(db());
      setSetting(db(), "kill_switch", true, OWNER);
      setSetting(db(), "kill_reason", "owner", OWNER);
      const rev = revokeApprovals(db(), { all: true }, OWNER, "stop all sending");
      // v4: Stop also revokes every unconsumed contacts approval (its changes go back to review).
      const crev = revokeContactApprovals(db(), { all: true }, OWNER, "stop all sending");
      db().query("DELETE FROM owner_challenges WHERE kind IN ('send','contacts')").run();
      const details = {
        revoked_approvals: rev.approvals, reverted_drafts: rev.drafts,
        approval_ids: rev.approval_ids, draft_ids: rev.draft_ids, revoked_at: rev.at,
        revoked_contact_approvals: crev.approvals, reverted_contact_changes: crev.changes,
        contact_approval_ids: crev.approval_ids, contact_change_ids: crev.change_ids, contact_revoked_at: crev.at,
        prev: { kill_switch: prev.kill_switch, kill_reason: prev.kill_reason },
      };
      const stopId = Number(db().query("INSERT INTO audit_log(at, actor, action, target, details_json) VALUES (?,?,?,?,?)").run(nowIso(), OWNER, "stop", null, JSON.stringify(details)).lastInsertRowid);
      return { rev, crev, stopId };
    });
    return c.json({ ok: true, kill_switch: true, kill_reason: "owner", revoked_approvals: r.rev.approvals, reverted_drafts: r.rev.drafts,
      revoked_contact_approvals: r.crev.approvals, reverted_contact_changes: r.crev.changes, stop_id: r.stopId });
  });
  /** Undo ONE stop within 2 minutes: restores the approvals that stop revoked and resets the kill switch. */
  app.post("/api/stop/undo", async (c) => {
    const body = await readJson(c, z.object({ stop_id: z.number().int().positive() }));
    const r = tx(() => {
      const base = undoStop(db(), body.stop_id, OWNER);
      // v4: the contacts approvals that same stop revoked come back too.
      const row = db().query<{ details_json: string }, [number]>("SELECT details_json FROM audit_log WHERE id = ?").get(body.stop_id);
      const d = safeJson(row?.details_json ?? "{}") as { contact_approval_ids?: string[]; contact_change_ids?: string[]; contact_revoked_at?: string };
      const cr = restoreContactApprovals(db(), d.contact_approval_ids ?? [], d.contact_change_ids ?? [], d.contact_revoked_at ?? "", OWNER);
      return { ...base, restored_contact_approvals: cr.approvals, restored_contact_changes: cr.changes };
    });
    return c.json({ ok: true, ...r });
  });
  app.post("/api/resume", (c) => {
    const was = tx(() => {
      const s = getSettings(db());
      setSetting(db(), "kill_switch", false, OWNER);
      setSetting(db(), "kill_reason", "", OWNER);
      audit(db(), OWNER, "resume", null, { was: s.kill_reason });
      return s.kill_reason;
    });
    return c.json({ ok: true, kill_switch: false, was: was });
  });

  // ---------- settings ----------
  app.get("/api/settings", (c) => c.json({ settings: getSettings(db()) }));
  const settingsSchema = z.object({
    transport: z.enum(["dry", "live"]),
    breaker_on_failure: z.boolean(),
    contacts_transport: z.enum(["dry", "live"]),
    // "Spread out messages": only slows sending down, so turning it on or loosening it needs no Touch ID. Values are checked as a whole below.
    pacing: z.object({
      enabled: z.boolean(), min_s: z.number(), max_s: z.number(), daily_cap: z.number(),
      quiet_start: z.string().max(5), quiet_end: z.string().max(5),
    }).partial().strict(),
  }).partial().strict().extend({ se_reauth: seReauthSchema.optional() });

  app.patch("/api/settings", async (c) => {
    const { se_reauth, pacing: pacingPatch, ...patch } = await readJson(c, settingsSchema);
    const before = getSettings(db());
    const nextPacing = pacingPatch ? { ...before.pacing, ...pacingPatch } : before.pacing;
    const pacingBad = pacingPatch ? pacingProblem(nextPacing) : null;
    if (pacingBad) throw badRequest(pacingBad);
    const goingLive = patch.transport === "live" && before.transport !== "live";
    const contactsLive = patch.contacts_transport === "live" && before.contacts_transport !== "live";
    // The executor only goes live if the effective pin has policy.live_allowed. Refuse early with the way forward.
    const way = pinMode(cfg) === "hardened" ? ", then run the harden command again" : "";
    if (goingLive && !pinLiveAllowed(cfg)) {
      throw new ApiError(409, "pin_not_live_allowed", `The pin file doesn't allow live sending. In Settings, tick "Allow live sending"${way}.`);
    }
    // v4: the same for contact changes, with policy.contacts_live_allowed.
    if (contactsLive && !pinContactsLiveAllowed(cfg)) {
      throw new ApiError(409, "pin_not_contacts_live_allowed", `The pin file doesn't allow live contact changes. In Settings, tick "Allow live contact changes"${way}.`);
    }
    if (goingLive || contactsLive) {
      requireReauth(c, cfg, limiterFor, { se_reauth }, "mode_live", "Going live needs a Touch ID confirmation.");
    }
    tx(() => {
      const cur = getSettings(db());
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && (cur as any)[k] !== v) setSetting(db(), k as SettingKey, v as any, OWNER);
      }
      if (pacingPatch) {
        const rows: [SettingKey, keyof Pacing][] = [["pace_enabled", "enabled"], ["pace_min_s", "min_s"], ["pace_max_s", "max_s"], ["daily_cap", "daily_cap"], ["quiet_start", "quiet_start"], ["quiet_end", "quiet_end"]];
        for (const [key, f] of rows) if (cur.pacing[f] !== nextPacing[f]) setSetting(db(), key, nextPacing[f], OWNER);
      }
    });
    return c.json({ settings: getSettings(db()) });
  });

  // ---------- mode: the one Live / Dry run switch ----------
  // dry: both transports to dry, no Touch ID (it can only make sending safer). live: needs a fresh Touch ID confirmation (se_reauth) whenever it
  // changes anything. Simple mode: turns the policy on too (what PUT /api/pin-policy does) and both transports live, ONE Touch ID.
  // Hardened mode: never touches the policy or the root pin; it only flips a transport the installed pin already allows.
  // Sending itself is unchanged: every message still needs a Touch ID approval of its exact text.
  app.post("/api/mode", async (c) => {
    const { mode, se_reauth } = await readJson(c, z.object({ mode: z.enum(["live", "dry"]), se_reauth: seReauthSchema.optional() }).strict());
    // `approval_key` false: no active approval key exists, so nothing can really send yet.
    const finish = (extra: object) => c.json({ settings: getSettings(db()), status: buildStatus(cfg, db()).pin, approval_key: nativeKeyCount(db()) > 0, ...extra });
    if (mode === "dry") {
      tx(() => {
        const cur = getSettings(db());
        const changed = { transport: cur.transport !== "dry", contacts_transport: cur.contacts_transport !== "dry" };
        if (changed.transport) setSetting(db(), "transport", "dry", OWNER);
        if (changed.contacts_transport) setSetting(db(), "contacts_transport", "dry", OWNER);
        audit(db(), OWNER, "mode.set", null, { mode: "dry", ...changed });
      });
      return finish({ contacts: "dry" });
    }
    const hardened = pinMode(cfg) === "hardened";
    const policy = getPinPolicy(db());
    const before = getSettings(db());
    if (hardened && !pinLiveAllowed(cfg)) {
      throw new ApiError(409, "pin_not_live_allowed", `The installed pin file doesn't allow live sending. In Settings, open Advanced and tick "Allow live sending", then run the harden command again.`);
    }
    // Hardened and the pin lacks contacts: messages go live, contact changes stay as they are (the sender applies them dry).
    const contactsOk = !hardened || pinContactsLiveAllowed(cfg);
    const policyChange = !hardened && (!policy.live_allowed || policy.contacts_live_allowed !== true);
    const changes = policyChange || before.transport !== "live" || (contactsOk && before.contacts_transport !== "live");
    if (changes) {
      requireReauth(c, cfg, limiterFor, { se_reauth }, "mode_live", "Going live needs a Touch ID confirmation.");
      tx(() => {
        // Re-read inside the lock: the policy and settings may have changed while the assertion was being checked.
        if (!hardened) {
          const p = getPinPolicy(db());
          if (!p.live_allowed || p.contacts_live_allowed !== true) setPinPolicy(db(), { live_allowed: true, contacts_live_allowed: true }, OWNER);
        }
        const cur = getSettings(db());
        if (cur.transport !== "live") setSetting(db(), "transport", "live", OWNER);
        if (contactsOk && cur.contacts_transport !== "live") setSetting(db(), "contacts_transport", "live", OWNER);
        audit(db(), OWNER, "mode.set", null, { mode: "live", policy_changed: policyChange, hardened, contacts: contactsOk ? "live" : "dry_pin" });
      });
      if (!hardened) writePinFiles(cfg, db());
    }
    // Simple mode: a missing or stale user pin (hand-edited) is rebuilt from the database on any Live tap, whatever the key count.
    // That only restores what the server already holds, so it loosens nothing and needs no Touch ID.
    let pinRepaired = false;
    if (!hardened) {
      let onDisk: string | null = null;
      try { onDisk = readFileSync(cfg.userPinFile, "utf8"); } catch { /* not written yet */ }
      if (onDisk !== pinText(db())) { writePinFiles(cfg, db()); pinRepaired = true; audit(db(), OWNER, "pin.repaired", null, { via: "mode" }); }
    }
    return finish({ contacts: contactsOk ? "live" : "dry_pin", policy_changed: policyChange, pin_repaired: pinRepaired });
  });

  // ---------- imports  ----------
  const region =z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase());
  app.get("/api/imports", (c) => {
    const rows = db().query<any, []>("SELECT id, filename, kind, sheet, row_count, mapping_json, created_by, created_at FROM imports ORDER BY created_at DESC LIMIT 50").all();
    return c.json({
      imports: rows.map((r) => {
        let confirmed = false; try { confirmed = !!JSON.parse(r.mapping_json)?.confirmed; } catch { /* keep false */ }
        return { id: r.id, filename: r.filename, kind: r.kind, sheet: r.sheet, row_count: r.row_count, created_by: r.created_by, created_at: r.created_at, confirmed };
      }),
    });
  });

  // JSON only: { filename (<= 200), data_b64 } (the file's bytes, <= 25 MB decoded) or { text, filename? }, plus sheet?, kind?, region?.
  app.post("/api/imports", async (c) => {
    const lib = await loadB();
    const body = await readJson(c, z.object({
      filename: z.string().max(200).optional(), data_b64: z.string().optional(), text: z.string().min(1).max(5_000_000).optional(),
      sheet: z.string().optional(), kind: z.string().optional(), region: region.optional(),
    }).strict().refine((v) => (v.data_b64 === undefined) !== (v.text === undefined), "Send either data_b64 (with filename) or text."));
    let bytes: Uint8Array, filename: string, kind: string | undefined;
    if (body.data_b64 !== undefined) {
      if (!body.filename) throw badRequest("A file upload needs a filename.");
      // 4 base64 characters decode to 3 bytes: refuse before decoding anything big.
      if (Math.floor(body.data_b64.length * 3 / 4) > cfg.maxUploadBytes + 3) throw new ApiError(413, "too_large", "That file is over 25 MB.");
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body.data_b64)) throw badRequest("data_b64 must be base64.");
      bytes = new Uint8Array(Buffer.from(body.data_b64, "base64"));
      if (bytes.length > cfg.maxUploadBytes) throw new ApiError(413, "too_large", "That file is over 25 MB.");
      filename = body.filename; kind = body.kind;
    } else {
      bytes = new TextEncoder().encode(body.text!);
      filename = body.filename ?? "pasted.txt"; kind = body.kind ?? "text";
    }
    const sheet = body.sheet, reg = body.region;
    if (bytes.length === 0) throw badRequest("That file is empty.");
    let summary: any;
    try { summary = lib.ingestFile(db(), { bytes, filename, created_by: OWNER, sheet, kind, ...(reg ? { region: reg } : {}), ...(cfg.importsDir ? { importsDir: cfg.importsDir } : {}) }); }
    catch (e) { throw badRequest(`Couldn't read that file: ${(e as Error).message}`); }
    audit(db(), OWNER, "import.create", summary?.import_id ?? null, { filename, bytes: bytes.length, sheet: sheet ?? null, region: reg ?? null });
    return c.json(summary);
  });

  /** The import summary plus a PAGE of its rows, optionally filtered by match (matched|new|ambiguous|invalid|duplicate). */
  app.get("/api/imports/:id", async (c) => {
    const lib = await loadB();
    let imp: any;
    try { imp = lib.getImport(db(), c.req.param("id")); } catch { throw notFound("Import not found."); }
    const match = c.req.query("match");
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25) || 25));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const all: any[] = imp.rows ?? [];
    const filtered = match ? all.filter((r) => r.match === match) : all;
    return c.json({ ...imp, rows: filtered.slice(offset, offset + limit), rows_total: filtered.length, rows_offset: offset, rows_limit: limit });
  });

  /** Re-read the stored file with another sheet and/or phone region. Creates a fresh import (the old one stays) and returns its summary. */
  app.post("/api/imports/:id/reingest", async (c) => {
    const lib = await loadB();
    const body = await readJson(c, z.object({ sheet: z.string().max(200).optional(), region: region.optional() }));
    const imp = db().query<{ id: string; filename: string; kind: string; stored_path: string }, [string]>("SELECT id, filename, kind, stored_path FROM imports WHERE id = ?").get(c.req.param("id"));
    if (!imp) throw notFound("Import not found.");
    // Only ever read files the importer itself stored.
    const base = resolve(cfg.importsDir ?? paths.imports) + sep;
    const abs = resolve(imp.stored_path);
    if (!abs.startsWith(base)) throw badRequest("That import's file is outside the import store.");
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(abs)); } catch { throw notFound("The stored file is gone; upload it again."); }
    let summary: any;
    try {
      summary = lib.ingestFile(db(), { bytes, filename: imp.filename, created_by: OWNER, sheet: body.sheet, kind: imp.kind, ...(body.region ? { region: body.region } : {}), ...(cfg.importsDir ? { importsDir: cfg.importsDir } : {}) });
    } catch (e) { throw badRequest(`Couldn't read that file: ${(e as Error).message}`); }
    audit(db(), OWNER, "import.reingest", summary?.import_id ?? null, { from: imp.id, sheet: body.sheet ?? null, region: body.region ?? null, sha256: sha256Hex(bytes) });
    return c.json(summary);
  });

  const mappingSchema = z.object({
    fields: z.record(z.string(), z.object({ column: z.string().min(1).max(200), confidence: z.number().min(0).max(1).default(1) })),
    vars: z.record(z.string(), z.string()).default({}),
    confirmed: z.boolean().default(true),
    region: region.optional(),
  });
  app.put("/api/imports/:id/mapping", async (c) => {
    const lib = await loadB();
    const { region: reg, ...mapping } = await readJson(c, mappingSchema);
    let r: any;
    try { r = lib.setMapping(db(), c.req.param("id"), reg ? { ...mapping, region: reg } : mapping, reg ? { region: reg } : undefined); } catch (e) { throw badRequest((e as Error).message); }
    audit(db(), OWNER, "import.mapping", c.req.param("id"), { fields: Object.keys(mapping.fields), region: reg ?? null });
    return c.json(r);
  });

  /** Renders the template for the first few rows with the same standard variables the batch builder uses. */
  app.post("/api/imports/:id/preview", async (c) => {
    const lib = await loadB();
    const { template, rows: n } = await readJson(c, z.object({ template: z.string().max(5000), rows: z.number().int().min(1).max(10).default(3) }));
    let imp: any;
    try { imp = lib.getImport(db(), c.req.param("id")); } catch { throw notFound("Import not found."); }
    // The same variable set batchFromImport uses, so the preview is what the drafts will say.
    const usable = ((imp.rows ?? imp.preview ?? []) as any[]).filter((r) => r.match !== "invalid" && r.match !== "duplicate").slice(0, n);
    return c.json({
      previews: usable.map((r) => {
        const nr = (r.normalized ?? {}) as Record<string, any>;
        const out = lib.renderTemplate(template, lib.varsForRow(r, imp.columns ?? []));
        return {
          row_index: r.row_index ?? null, to: r.normalized?.handle ?? nr.phone_e164 ?? nr.email ?? "",
          name: nr.display_name || [nr.given_name, nr.family_name].filter(Boolean).join(" "), body: out.body, unresolved: out.unresolved, empty: out.empty,
        };
      }),
    });
  });

  app.post("/api/imports/:id/batch", async (c) => {
    const lib = await loadB();
    const body = await readJson(c, z.object({
      title: z.string().min(1).max(200), template: z.string().min(1).max(5000),
      per_row_bodies: z.record(z.string(), z.string()).optional(), create_new_contacts: z.boolean().optional(),
      include: z.array(z.number().int()).optional(),
    }));
    let r;
    try {
      r = lib.batchFromImport(db(), c.req.param("id"), {
        title: body.title, template: body.template, created_by: OWNER, source: "dashboard",
        per_row_bodies: body.per_row_bodies ? Object.fromEntries(Object.entries(body.per_row_bodies).map(([k, v]) => [Number(k), v])) : undefined,
        create_new_contacts: body.create_new_contacts, include: body.include,
      });
    } catch (e) { throw badRequest((e as Error).message); }
    const b = getBatch(db(), r.batch_id);
    if (b && b.status === "drafting") setBatchStatus(db(), r.batch_id, "review", OWNER);
    await tryLint(db(), r.batch_id);
    audit(db(), OWNER, "import.batch", r.batch_id, { import_id: c.req.param("id"), drafts: r.drafts });
    return c.json(r);
  });

  // ---------- contacts ----------
  // Asks outbox-exec for an address-book export. The first request puts the macOS Contacts prompt on this Mac's screen.
  app.post("/api/contacts/sync", (c) => {
    const open = db().query("SELECT id FROM exec_requests WHERE kind = 'contacts_export' AND done_at IS NULL").get() as any;
    if (open) return c.json({ request_id: open.id, already_pending: true });
    const id = Bun.randomUUIDv7();
    db().query("INSERT INTO exec_requests(id, kind, created_at) VALUES (?, 'contacts_export', ?)").run(id, nowIso());
    audit(db(), OWNER, "contacts.sync_request", id, {});
    return c.json({ request_id: id, already_pending: false });
  });

  app.get("/api/contacts", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    // Offset paging over a stable order (name, then id) so pages never repeat or skip a contact; search pages the same way.
    const num = (v: string | undefined, dflt: number) => { const n = v === undefined || v === "" ? NaN : Math.floor(Number(v)); return Number.isFinite(n) ? n : dflt; };
    const limit = Math.min(200, Math.max(1, num(c.req.query("limit"), 100)));
    const offset = Math.max(0, num(c.req.query("offset"), 0));
    const esc = (s: string) => `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const total = db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contacts").get()?.n ?? 0;
    let rows: any[];
    let matched = total;
    if (!q) {
      rows = db().query("SELECT * FROM contacts ORDER BY display_name COLLATE NOCASE, id LIMIT ? OFFSET ?").all(limit, offset);
    } else {
      const digits = q.replace(/\D/g, "");
      const where = `FROM contacts c LEFT JOIN contact_handles h ON h.contact_id = c.id
         WHERE c.display_name LIKE ? ESCAPE '\\' OR c.given_name LIKE ? ESCAPE '\\' OR c.family_name LIKE ? ESCAPE '\\'
            OR c.nickname LIKE ? ESCAPE '\\' OR c.org LIKE ? ESCAPE '\\' OR c.tags_json LIKE ? ESCAPE '\\' OR h.handle LIKE ? ESCAPE '\\'
            OR (? <> '' AND h.handle LIKE ? ESCAPE '\\')`;
      const args = [esc(q), esc(q), esc(q), esc(q), esc(q), esc(q), esc(q), digits.length >= 3 ? "x" : "", esc(digits)];
      rows = db().query(`SELECT DISTINCT c.* ${where} ORDER BY c.display_name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
      matched = db().query<{ n: number }, any[]>(`SELECT COUNT(DISTINCT c.id) AS n ${where}`).get(...args)?.n ?? 0;
    }
    return c.json({ contacts: rows.map(rowToContact), total, matched, offset, limit, has_more: offset + rows.length < matched });
  });
  app.get("/api/contacts/pending", (c) => {
    const rows = db().query<any, []>(
      `SELECT d.id AS draft_id, d.batch_id, d.recipient_name, d.handle, d.proposed_contact_json, d.create_contact, d.status, b.title AS batch_title
       FROM drafts d JOIN batches b ON b.id = d.batch_id
       WHERE d.proposed_contact_json IS NOT NULL AND d.status IN ('draft','review','approved','skipped') AND b.status <> 'cancelled'
       ORDER BY d.created_at DESC LIMIT 300`).all();
    return c.json({ pending: rows.map((r) => ({ ...r, proposed_contact: JSON.parse(r.proposed_contact_json), create_contact: !!r.create_contact, proposed_contact_json: undefined })) });
  });
  app.get("/api/contacts/:id", (c) => {
    const ct = getContact(db(), c.req.param("id"));
    if (!ct) throw notFound("Contact not found.");
    return c.json({ contact: ct });
  });

  // ---------- contact changes (v4) ----------
  registerContactApi(app, cfg, limiterFor);

  // ---------- saved groups (v5) ----------
  registerGroupsApi(app, cfg);

  // ---------- activity ----------
  app.get("/api/activity", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const auditBefore = Number(c.req.query("audit_before") ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
    const sendsBefore = c.req.query("sends_before") ?? "9999";
    const sends = db().query<any, [string, number]>(
      `SELECT s.*, d.handle, d.recipient_name, d.batch_id, substr(d.body, 1, 120) AS preview
       FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE s.started_at < ? ORDER BY s.started_at DESC LIMIT ?`).all(sendsBefore, limit);
    // `action` (optional): only audit rows with that action (the app looks up its one-time migration.v7 row this way).
    const action = c.req.query("action");
    const auditRows = action
      ? db().query<any, [number, string, number]>("SELECT * FROM audit_log WHERE id < ? AND action = ? ORDER BY id DESC LIMIT ?").all(auditBefore, action.slice(0, 100), limit)
      : db().query<any, [number, number]>("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").all(auditBefore, limit);
    return c.json({
      sends,
      audit: auditRows.map((a) => ({ ...a, details: safeJson(a.details_json), details_json: undefined })),
      next: { sends_before: sends.length === limit ? sends[sends.length - 1]?.started_at ?? null : null, audit_before: auditRows.length === limit ? auditRows[auditRows.length - 1]?.id ?? null : null },
    });
  });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
function safeCount(manifest: string): number { try { return (JSON.parse(manifest).items ?? []).length; } catch { return 0; } }
function safeTransport(manifest: string): string | null { try { return JSON.parse(manifest).transport ?? null; } catch { return null; } }

/** The linked contact with ALL its handles, so the card can say "number not in contact". */
function contactInfo(db: Database, id: string | null): { id: string; display_name: string; org: string; handles: string[] } | null {
  if (!id) return null;
  const c = db.query<{ id: string; display_name: string; org: string }, [string]>("SELECT id, display_name, org FROM contacts WHERE id = ?").get(id);
  if (!c) return null;
  return { ...c, handles: db.query<{ handle: string }, [string]>("SELECT handle FROM contact_handles WHERE contact_id = ?").all(id).map((r) => r.handle) };
}
/** Existing contacts a draft might really be: same handle, or the same name. For the ambiguous-contact picker. */
function candidatesFor(db: Database, d: Draft): { contact_id: string; display_name: string; org: string; handles: string[] }[] {
  const ids = new Set<string>();
  for (const r of db.query<{ contact_id: string }, [string]>("SELECT contact_id FROM contact_handles WHERE handle = ?").all(d.handle)) ids.add(r.contact_id);
  const nm = d.recipient_name.trim();
  if (nm) {
    for (const r of db.query<{ id: string }, [string, string]>("SELECT id FROM contacts WHERE display_name = ? COLLATE NOCASE OR (given_name || ' ' || family_name) = ? COLLATE NOCASE LIMIT 8").all(nm, nm)) ids.add(r.id);
  }
  return [...ids].slice(0, 6).map((id) => contactInfo(db, id)!).filter(Boolean).map((c) => ({ contact_id: c.id, display_name: c.display_name, org: c.org, handles: c.handles }));
}

/** E.164 / lower-cased email when the ingest library is present; otherwise a conservative fallback. Invalid input is a 400. */
async function resolveHandle(input: string): Promise<string> {
  let lib;
  try { lib = await loadB(); } catch { lib = null; }
  if (lib) {
    const h = lib.normalizeHandle(input);
    if (!h.valid || !h.handle) throw badRequest("That isn't a valid phone number or email.");
    return h.handle;
  }
  const t = input.trim().toLowerCase();
  if (/^\+\d{8,15}$/.test(t) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return t;
  throw badRequest("Use a phone number like +15551234567 or an email address.");
}
export type { Draft, Service, Warning };
export { APPROVABLE };
