-- iMessage Outbox schema v1. Authoritative contract shared by outboxd (TypeScript) and outbox-exec (Swift).
-- ids: UUIDv7 text (Bun.randomUUIDv7(), time-sortable). times: ISO-8601 UTC text ("2026-11-10T08:00:00.000Z"). JSON columns: text.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('macos','import','manual')),
  macos_id      TEXT UNIQUE,                 -- CNContact.identifier when source = 'macos' or after creation
  display_name  TEXT NOT NULL DEFAULT '',
  given_name    TEXT NOT NULL DEFAULT '',
  family_name   TEXT NOT NULL DEFAULT '',
  nickname      TEXT NOT NULL DEFAULT '',
  org           TEXT NOT NULL DEFAULT '',
  phones_json   TEXT NOT NULL DEFAULT '[]',  -- [{"e164":"+15551234567","label":"mobile","raw":"(555) 123-4567"}]
  emails_json   TEXT NOT NULL DEFAULT '[]',  -- [{"email":"a@b.com","label":"home"}]
  tags_json     TEXT NOT NULL DEFAULT '[]',
  notes         TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL,
  synced_at     TEXT
);

CREATE TABLE IF NOT EXISTS contact_handles (
  handle      TEXT NOT NULL,                 -- E.164 phone or lowercased email
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (handle, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_handles_contact ON contact_handles(contact_id);

CREATE TABLE IF NOT EXISTS imports (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  kind          TEXT NOT NULL,               -- csv|tsv|xlsx|xls|ods|numbers|vcf|json|jsonl|text
  stored_path   TEXT NOT NULL,
  sheet         TEXT,
  mapping_json  TEXT NOT NULL DEFAULT '{}',  -- {"fields":{"given_name":{"column":"First","confidence":0.95}},"confirmed":false}
  columns_json  TEXT NOT NULL DEFAULT '[]',
  row_count     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,               -- session label, "owner", "cli"
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_rows (
  import_id        TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_index        INTEGER NOT NULL,
  raw_json         TEXT NOT NULL,            -- {"<column>":"<cell text>"}
  normalized_json  TEXT NOT NULL DEFAULT '{}', -- {"given_name","family_name","display_name","phone_e164","email","org","vars":{slug:value}}
  contact_id       TEXT REFERENCES contacts(id),
  match            TEXT NOT NULL CHECK (match IN ('matched','new','ambiguous','invalid','duplicate')),
  issues_json      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (import_id, row_index)
);

CREATE TABLE IF NOT EXISTS batches (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('mcp','cli','dashboard','compose')),
  import_id     TEXT REFERENCES imports(id),
  template      TEXT,
  instructions  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('drafting','review','approved','sending','done','cancelled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id                     TEXT PRIMARY KEY,
  batch_id               TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  position               INTEGER NOT NULL DEFAULT 0,
  contact_id             TEXT REFERENCES contacts(id),
  proposed_contact_json  TEXT,               -- {"given_name","family_name","phones":[{"e164","label"}],"emails":[...],"org","note"}; created on approval only
  create_contact         INTEGER NOT NULL DEFAULT 0, -- owner's choice whether proposed contact is created
  recipient_name         TEXT NOT NULL DEFAULT '',
  handle                 TEXT NOT NULL,      -- E.164 or lowercased email
  service                TEXT NOT NULL CHECK (service IN ('iMessage','SMS','auto')) DEFAULT 'auto',
  body                   TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL CHECK (status IN ('draft','review','approved','sending','sent','failed','unknown','skipped','rejected')),
  confirmed              INTEGER NOT NULL DEFAULT 0, -- delivery confirmed (needs chat.db; 0 in v1)
  warnings_json          TEXT NOT NULL DEFAULT '[]', -- [{"code":"unresolved_var","message":"..."}]
  vars_json              TEXT NOT NULL DEFAULT '{}',
  notes                  TEXT NOT NULL DEFAULT '',
  import_id              TEXT,
  import_row             INTEGER,
  scheduled_for          TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_batch ON drafts(batch_id, position);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_handle ON drafts(handle);

CREATE TABLE IF NOT EXISTS draft_revisions (
  draft_id  TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  body      TEXT NOT NULL,
  actor     TEXT NOT NULL CHECK (actor IN ('agent','owner','compose','template')),
  at        TEXT NOT NULL,
  PRIMARY KEY (draft_id, version)
);

-- One row per owner approval. `manifest` holds the EXACT UTF-8 bytes that were hashed into the WebAuthn challenge.
CREATE TABLE IF NOT EXISTS approvals (
  id                      TEXT PRIMARY KEY,
  batch_id                TEXT NOT NULL REFERENCES batches(id),
  manifest                TEXT NOT NULL,
  manifest_sha256         TEXT NOT NULL,     -- lowercase hex
  credential_id           TEXT NOT NULL,     -- base64url
  authenticator_data_b64  TEXT NOT NULL,     -- base64url
  client_data_json_b64    TEXT NOT NULL,     -- base64url
  signature_b64           TEXT NOT NULL,     -- base64url, DER ECDSA
  not_after               TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  revoked_at              TEXT               -- owner pressed stop / cancelled
);

-- Written by outbox-exec only. UNIQUE(approval_id, draft_id, attempt).
CREATE TABLE IF NOT EXISTS sends (
  id           TEXT PRIMARY KEY,
  draft_id     TEXT NOT NULL REFERENCES drafts(id),
  approval_id  TEXT NOT NULL REFERENCES approvals(id),
  attempt      INTEGER NOT NULL,
  transport    TEXT NOT NULL CHECK (transport IN ('dry','live')),
  service_used TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  result       TEXT CHECK (result IN ('sent','failed','unknown')),
  error        TEXT,
  handle       TEXT,            -- snapshot of what was actually sent
  body_sha256  TEXT,
  UNIQUE (approval_id, draft_id, attempt)
);

-- Written by outbox-exec only.
CREATE TABLE IF NOT EXISTS contact_writes (
  id           TEXT PRIMARY KEY,
  draft_id     TEXT NOT NULL REFERENCES drafts(id),
  approval_id  TEXT NOT NULL REFERENCES approvals(id),
  payload_json TEXT NOT NULL,
  transport    TEXT NOT NULL CHECK (transport IN ('dry','live')),
  result       TEXT CHECK (result IN ('created','failed','skipped')),
  macos_id     TEXT,
  error        TEXT,
  at           TEXT NOT NULL,
  UNIQUE (approval_id, draft_id)
);

-- Requests from outboxd to outbox-exec (contacts sync). exec marks done.
CREATE TABLE IF NOT EXISTS exec_requests (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('contacts_export')),
  created_at  TEXT NOT NULL,
  done_at     TEXT,
  result_json TEXT
);

-- Heartbeat from outbox-exec so the dashboard can show it is alive and which transport it runs.
CREATE TABLE IF NOT EXISTS exec_status (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  heartbeat_at  TEXT NOT NULL,
  version       TEXT NOT NULL,
  transport     TEXT NOT NULL,
  pin_file_ok   INTEGER NOT NULL,
  last_error    TEXT,
  sent_today    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id         TEXT PRIMARY KEY,   -- base64url
  public_key_cose_b64   TEXT NOT NULL,      -- base64url (for @simplewebauthn)
  public_key_x963_b64   TEXT NOT NULL,      -- base64url of 65-byte uncompressed P-256 point (for the pin file)
  counter               INTEGER NOT NULL DEFAULT 0,
  transports_json       TEXT NOT NULL DEFAULT '[]',
  label                 TEXT NOT NULL DEFAULT '',
  purpose               TEXT NOT NULL DEFAULT 'approve' CHECK (purpose IN ('login','approve')),
  user_handle           TEXT NOT NULL DEFAULT '',   -- base64url WebAuthn user.id; differs per purpose
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_sha256  TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register','login','approve')),
  challenge   TEXT NOT NULL,               -- base64url
  approval_id TEXT,                        -- for purpose = 'approve'
  manifest    TEXT,                        -- exact manifest bytes pending signature
  batch_id    TEXT,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('transport','dry'),
  ('kill_switch','0'), ('kill_reason',''),
  ('breaker_on_failure','1');
-- v3: no pacing, daily cap or quiet hours. Approved messages send right away, 2 s apart (fixed in outbox-exec).
DELETE FROM settings WHERE key IN ('pace_min_s','pace_max_s','burst_size_min','burst_size_max','burst_pause_min_s',
  'burst_pause_max_s','daily_cap','quiet_start','quiet_end','timezone');

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,              -- 'agent:<label>' | 'owner' | 'exec' | 'system'
  action        TEXT NOT NULL,
  target        TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}'
);

-- Owned by outbox-exec: pacing state (next send time, burst counters) and "already audited" markers.
CREATE TABLE IF NOT EXISTS exec_state (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Extra attributes from the macOS contacts export (groups → tags, city, birthday). Written by contacts-sync.
CREATE TABLE IF NOT EXISTS contact_attrs (
  contact_id  TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  groups_json TEXT NOT NULL DEFAULT '[]',
  city        TEXT NOT NULL DEFAULT '',
  birthday    TEXT NOT NULL DEFAULT ''
);

-- ===== v4: native contact management =====
-- A change set groups proposed contact changes. EVERY change (create, update, undo) needs a passkey-signed contacts manifest
-- stored in contact_approvals before outbox-exec applies it: contacts are never added automatically.
CREATE TABLE IF NOT EXISTS contact_change_sets (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_by  TEXT NOT NULL,                 -- 'agent:<label>' | 'owner' | 'cli'
  source      TEXT NOT NULL CHECK (source IN ('mcp','cli','dashboard','import','undo')),
  status      TEXT NOT NULL CHECK (status IN ('drafting','review','approved','applying','done','cancelled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_changes (
  id                 TEXT PRIMARY KEY,
  set_id             TEXT NOT NULL REFERENCES contact_change_sets(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  kind               TEXT NOT NULL CHECK (kind IN ('create','update','undo')),
  target_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,  -- cache row, for display only
  target_macos_id    TEXT,                   -- CNContact.identifier; required for update; for undo, the contact being restored/deleted
  payload_json       TEXT NOT NULL,          -- exact bytes hashed into contact manifests (see types.ts ContactChangePayload)
  requires_approval  INTEGER NOT NULL DEFAULT 1,  -- always 1 now; a 0 (old auto-apply rows) is migrated below and the executor never applies it
  status             TEXT NOT NULL CHECK (status IN ('pending','auto_queued','review','approved','applied','failed','rejected','undone')),
  note               TEXT NOT NULL DEFAULT '',    -- why it is in review ("already in Contacts", "same name as an existing contact", ...)
  transport          TEXT CHECK (transport IN ('dry','live')),  -- set by outbox-exec when applied
  before_vcard       TEXT,                   -- outbox-exec: canonical JSON snapshot {"v":1,...} of the target before the write (name kept for history)
  after_fingerprint  TEXT,                   -- outbox-exec: sha256 hex of the canonical contact fields right after the write
  result_macos_id    TEXT,                   -- outbox-exec: identifier created/updated
  error              TEXT,
  created_at         TEXT NOT NULL,
  applied_at         TEXT,
  undo_of            TEXT REFERENCES contact_changes(id)
);
CREATE INDEX IF NOT EXISTS idx_contact_changes_set ON contact_changes(set_id, position);
CREATE INDEX IF NOT EXISTS idx_contact_changes_status ON contact_changes(status);

-- One row per owner approval of contact changes. Same passkey and WebAuthn shape as `approvals`, but a separate table and a
-- separate manifest kind ("contacts"), so a contacts approval can never be read as a send approval or the other way round.
CREATE TABLE IF NOT EXISTS contact_approvals (
  id                      TEXT PRIMARY KEY,
  set_id                  TEXT NOT NULL REFERENCES contact_change_sets(id),
  manifest                TEXT NOT NULL,
  manifest_sha256         TEXT NOT NULL,
  credential_id           TEXT NOT NULL,
  authenticator_data_b64  TEXT NOT NULL,
  client_data_json_b64    TEXT NOT NULL,
  signature_b64           TEXT NOT NULL,
  not_after               TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  revoked_at              TEXT
);

-- Written by outbox-exec only: the consumption record. A change is applied at most once, ever (UNIQUE change_id); no retries.
-- approval_id is the contacts approval that covered the change (always set for new rows; NULL only in old auto-applied records).
CREATE TABLE IF NOT EXISTS contact_applies (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL UNIQUE REFERENCES contact_changes(id),
  approval_id  TEXT REFERENCES contact_approvals(id),
  transport    TEXT NOT NULL CHECK (transport IN ('dry','live')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  result       TEXT CHECK (result IN ('applied','failed','unknown','skipped')),
  error        TEXT,
  macos_id     TEXT
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('contacts_transport','dry');

-- Owner rule 2026-11-16: contacts are NEVER added automatically. 'auto_queued' stays in the CHECK for old data only; any such
-- row that the executor has not touched moves to review and must be approved with Touch ID. Idempotent (runs at every open).
UPDATE contact_changes SET status = 'review', requires_approval = 1, note = CASE WHEN note = '' THEN 'new contact' ELSE note END
  WHERE (status = 'auto_queued' OR (requires_approval = 0 AND status IN ('pending','review')))
    AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = contact_changes.id);
UPDATE contact_change_sets SET status = 'review'
  WHERE status = 'drafting' AND EXISTS (SELECT 1 FROM contact_changes c WHERE c.set_id = contact_change_sets.id AND c.status = 'review');

-- v5: saved groups. Agent Outbox's own named lists of people (NOT macOS Contacts groups, which show up as contact tags).
-- Agents may write these tables: a group only decides who a draft is addressed to, and every draft still needs the owner's approval.
CREATE TABLE IF NOT EXISTS contact_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,          -- lower(trim(name)), collapsed spaces: names are unique, case-insensitively
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,                 -- 'agent:<label>' | 'owner' | 'cli'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id    TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  handle      TEXT NOT NULL,                 -- E.164 or lowercased email: the member's identity within the group
  contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,  -- contacts sync deletes removed contacts
  name        TEXT NOT NULL DEFAULT '',      -- display name when added (used when contact_id is null)
  vars_json   TEXT NOT NULL DEFAULT '{}',    -- per-member template variables, e.g. from an import row
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (group_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_group_members_contact ON contact_group_members(contact_id);
