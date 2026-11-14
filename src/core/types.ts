// Shared domain types. Mirrors src/db/schema.sql; JSON columns are parsed into these shapes.

export type Service = "iMessage" | "SMS" | "auto";
export type BatchStatus = "drafting" | "review" | "approved" | "sending" | "done" | "cancelled";
export type BatchSource = "mcp" | "cli" | "dashboard" | "compose";
export type DraftStatus =
  | "draft" | "review" | "approved" | "sending" | "sent" | "failed" | "unknown" | "skipped" | "rejected";
export type RevisionActor = "agent" | "owner" | "compose" | "template";
export type MatchStatus = "matched" | "new" | "ambiguous" | "invalid" | "duplicate";

export interface Phone { e164: string; label: string; raw?: string }
export interface Email { email: string; label: string }

export interface Contact {
  id: string;
  source: "macos" | "import" | "manual";
  macos_id: string | null;
  display_name: string;
  given_name: string;
  family_name: string;
  nickname: string;
  org: string;
  phones: Phone[];
  emails: Email[];
  tags: string[];
  notes: string;
  updated_at: string;
  synced_at: string | null;
}

/** A contact created on approval. Its handles must be EXACTLY the draft's handle: one phone (== to) and no
 *  emails, or one email (== to) and no phones. Both TS and Swift enforce this, so an approval can't plant
 *  someone else's number under a trusted name. */
export interface ProposedContact {
  given_name: string;
  family_name: string;
  org?: string;
  phones: Phone[];
  emails: Email[];
  note?: string;
  tags?: string[];            // shown to the user; only the "Outbox imports" group is written to macOS
}

export interface Warning { code: WarningCode; message: string }
export type WarningCode =
  | "unresolved_var" | "empty_var" | "duplicate_recipient" | "pending_elsewhere" | "recently_messaged"
  | "invalid_handle" | "non_mobile" | "too_long" | "identical_to_template" | "empty_body"
  | "new_contact" | "ambiguous_contact" | "link_in_first_message";

export interface Batch {
  id: string;
  title: string;
  created_by: string;
  source: BatchSource;
  import_id: string | null;
  template: string | null;
  instructions: string | null;
  status: BatchStatus;
  created_at: string;
  updated_at: string;
}

export interface Draft {
  id: string;
  batch_id: string;
  position: number;
  contact_id: string | null;
  proposed_contact: ProposedContact | null;
  create_contact: boolean;
  recipient_name: string;
  handle: string;
  service: Service;
  body: string;
  version: number;
  status: DraftStatus;
  confirmed: boolean;
  warnings: Warning[];
  vars: Record<string, string>;
  notes: string;
  import_id: string | null;
  import_row: number | null;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
}

/** Approval manifest. The server serialises it ONCE with JSON.stringify (no whitespace) and stores those exact
 *  bytes; sha256(bytes) is the WebAuthn challenge. Nobody re-serialises it for verification. */
export interface ManifestItem {
  draft_id: string;
  to: string;            // handle
  service: Service;
  body_sha256: string;   // lowercase hex of sha256(utf8(body))
  name: string;
  create_contact: ProposedContact | null;
}
export interface Manifest {
  v: 2;
  /** Signed by the user. outbox-exec sends live ONLY if this is "live" AND the effective pin policy allows live.
   *  The DB `transport` setting only decides what new manifests ask for. */
  transport: "dry" | "live";
  approval_id: string;
  batch_id: string;
  created_at: string;
  not_after: string;
  rp_id: string;
  origin: string;
  items: ManifestItem[];
}

/** Pin file format: the root pin (/Library/Application Support/agent-outbox/passkeys.json, hardened mode) and the user pin (<state>/passkeys.json, simple mode).
 *  `keys` holds ONLY approval-purpose passkeys (never the sign-in passkey), so a harvested login assertion can't
 *  satisfy the executor. `policy` holds floors the executor enforces over whatever the DB settings say. */
export interface PinFile {
  v: 2;
  rp_id: string;
  origin: string;
  keys: { credential_id: string; x963: string; label: string }[]; // base64url, purpose = 'approve' only
  policy: PinPolicy;
}
/** v3 (2026-11-10: "approve → send, nothing else"): the only policy is whether live sending is allowed.
 *  Older pin files may carry extra pacing fields; readers ignore them. */
export interface PinPolicy {
  live_allowed: boolean;      // false → executor never uses the live transport
  /** v4: false or missing → contact changes (auto creates and approved edits) are only ever applied dry. */
  contacts_live_allowed?: boolean;
}
export const DEFAULT_PIN_POLICY: PinPolicy = { live_allowed: false, contacts_live_allowed: false };
export type PasskeyPurpose = "login" | "approve";

export interface Settings {
  transport: "dry" | "live";
  kill_switch: boolean;
  kill_reason: "" | "owner" | "breaker";
  breaker_on_failure: boolean;
  contacts_transport: "dry" | "live";   // v4: what auto creates use and what new contacts manifests ask for
}

// ===== v4: native contact management (contract: docs/design/CONTRACTS.md "v4") =====
export type ContactChangeKind = "create" | "update" | "undo";
export type ContactChangeStatus =
  | "pending" | "auto_queued" | "review" | "approved" | "applied" | "failed" | "rejected" | "undone";
export type ContactSetStatus = "drafting" | "review" | "approved" | "applying" | "done" | "cancelled";
export type ContactSetSource = "mcp" | "cli" | "dashboard" | "import" | "undo";

/** Editable name fields. Each ≤ 100 characters, no control characters (C0, C1, U+2028/2029, bidi overrides
 *  U+202A–202E and U+2066–2069); emoji are fine. */
export interface ContactNameFields { given_name?: string; family_name?: string; nickname?: string; org?: string }

/** kind = 'create'. At least one valid handle; ≤ 5 phones and ≤ 5 emails; phones E.164, emails lowercased.
 *  `groups` are extra groups besides the always-added "Outbox imports". */
export interface ContactCreatePayload {
  given_name: string;
  family_name: string;
  nickname?: string;
  org?: string;
  phones: Phone[];
  emails: Email[];
  groups?: string[];          // ≤ 5, each ≤ 100 chars, same character rules
}
/** kind = 'update' (target_macos_id required). At least one effective change. Removing handles, deleting and merging
 *  are out of scope for v1. `from_create` marks an update made from a create whose handle already existed. */
export interface ContactUpdatePayload {
  set?: ContactNameFields;    // replace these fields ("" clears a field)
  add_phones?: Phone[];       // added only if not already on the card
  add_emails?: Email[];
  add_groups?: string[];
  from_create?: boolean;
}
/** kind = 'undo'. Undoing an update restores, field by field, what the target had in `before_vcard` (a canonical JSON snapshot `{"v":1,"given_name",...}` since 2026-11-10; the column keeps its old name), and removes the
 *  handles/groups that change added. Undoing a create deletes the contact. `before_vcard_sha256` (update undo) and
 *  `after_fingerprint` (both) bind the signature to the exact snapshot the executor will act on. */
export interface ContactUndoPayload {
  undo_of: string;            // contact_changes.id of an applied create/update
  undo_kind: "create" | "update";
  before_vcard_sha256: string | null;   // sha256 hex of the UTF-8 text of the original change's before_vcard (null for a create)
  after_fingerprint: string;            // the original change's after_fingerprint
}
export type ContactChangePayload = ContactCreatePayload | ContactUpdatePayload | ContactUndoPayload;

export interface ContactChangeSet {
  id: string; title: string; created_by: string; source: ContactSetSource; status: ContactSetStatus;
  created_at: string; updated_at: string;
}
export interface ContactChange {
  id: string; set_id: string; position: number; kind: ContactChangeKind;
  target_contact_id: string | null; target_macos_id: string | null;
  payload_json: string;       // kept as the exact stored string: it is what gets hashed
  payload: ContactChangePayload;
  requires_approval: boolean; status: ContactChangeStatus; note: string;
  transport: "dry" | "live" | null; before_vcard: string | null; after_fingerprint: string | null;
  result_macos_id: string | null; error: string | null;
  created_at: string; applied_at: string | null; undo_of: string | null;
}

/** Contacts approval manifest. Serialised ONCE with JSON.stringify; sha256(bytes) is the WebAuthn challenge, signed with an
 *  APPROVE passkey. `kind: "contacts"` keeps it apart from send manifests: the executor's send path rejects any manifest
 *  with a `kind`, and the contacts path requires kind == "contacts". */
export interface ContactManifestItem {
  change_id: string;
  kind: ContactChangeKind;
  target_macos_id: string | null;
  payload_sha256: string;     // lowercase hex of sha256(utf8(payload_json))
}
export interface ContactManifest {
  v: 1;
  kind: "contacts";
  /** Applied live ONLY if this is "live" AND the effective pin has policy.contacts_live_allowed. Taken from the
   *  `contacts_transport` setting when the options are built. */
  transport: "dry" | "live";
  approval_id: string;
  set_id: string;
  created_at: string;
  not_after: string;          // fixed 24 h
  rp_id: string;
  origin: string;
  contact_items: ContactManifestItem[];
}
