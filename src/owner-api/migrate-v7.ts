// One-time migration to the app-only schema (v7), guarded by settings.migrated_v7. Runs at server start, in one IMMEDIATE transaction:
//  1. revokes every approval and contact approval that is not signed by an ACTIVE Secure Enclave key (browser-passkey approvals: the
//     executor would refuse them anyway); unsent drafts and unapplied changes go back to review;
//  2. empties the legacy browser tables (sessions, webauthn_challenges, native_challenges, link_codes, session_links) and deletes
//     pending native keys. `passkeys` rows are kept (public keys only; a revert to the old build needs them);
//  3. audits `migration.v7` and sets migrated_v7 = '1'.
import type { Database } from "bun:sqlite";
import { audit } from "../core/store";
import { listNativeKeys } from "./auth";
import { revokeApprovals } from "./approval";
import { revokeContactApprovals } from "./contact-approval";

export interface MigrationResult { ran: boolean; revoked_approvals: number; revoked_contact_approvals: number }

export function migrateV7(db: Database): MigrationResult {
  const done = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'migrated_v7'").get();
  if (done?.value === "1") return { ran: false, revoked_approvals: 0, revoked_contact_approvals: 0 };
  return db.transaction((): MigrationResult => {
    const active = listNativeKeys(db, "active").map((k) => k.key_id);
    const a = revokeApprovals(db, { exceptCredentialIds: active }, "system", "migration v7: not signed by a Secure Enclave key");
    const c = revokeContactApprovals(db, { exceptCredentialIds: active }, "system", "migration v7: not signed by a Secure Enclave key");
    for (const t of ["sessions", "webauthn_challenges", "native_challenges", "link_codes", "session_links"]) db.query(`DELETE FROM ${t}`).run();
    db.query("DELETE FROM native_keys WHERE status = 'pending'").run();
    audit(db, "system", "migration.v7", null, { revoked_approvals: a.approvals, revoked_contact_approvals: c.approvals });
    db.query("INSERT INTO settings(key, value) VALUES ('migrated_v7','1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    return { ran: true, revoked_approvals: a.approvals, revoked_contact_approvals: c.approvals };
  }).immediate();
}
