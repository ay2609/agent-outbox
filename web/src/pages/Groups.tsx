// Saved groups: Agent Outbox's own lists of people (not Contacts-app groups). A Claude session can make and use them
// through its tools; here you can look at them, tidy them and delete them.
import { useState } from "react";
import { ApiErr, api, errText, patch, post } from "../api";
import { useDebounced, useLoad } from "../hooks";
import { href, navigate } from "../router";
import { Chip, Empty, ErrorNote, Sheet, Spinner, copyText, prettyHandle, timeAgo, useToast } from "../ui";
import { ContactsNav } from "./ContactChanges";

const people = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;

// ---------- list ----------
export function GroupsList() {
  const q = useLoad<{ groups: any[] }>("/api/groups");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try { const r = await post("/api/groups", { name }); navigate("contacts", "groups", r.group.id); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const groups = q.data?.groups ?? [];
  return (
    <>
      <h1 className="page-title">Contacts</h1>
      <ContactsNav active="groups" />
      <p className="muted small">Saved lists of people. A Claude session can make one ("save these as my book club") and use it later. They are not groups in the Contacts app.</p>
      {!open
        ? <button className="btn" style={{ margin: "10px 0" }} onClick={() => setOpen(true)} data-testid="new-group">New group</button>
        : (
          <form className="card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
            <label className="field"><span>Group name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Book club" data-testid="new-group-name" /></label>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()} data-testid="new-group-create">{busy ? "Creating…" : "Create"}</button>
              <button className="btn" type="button" onClick={() => { setOpen(false); setName(""); setErr(null); }}>Cancel</button>
            </div>
          </form>
        )}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Spinner />}
      {q.data && groups.length === 0 && <Empty title="No groups yet">Make one here, or ask a Claude session to save a list of people as a group.</Empty>}
      <div className="stack">
        {groups.map((g) => (
          <a key={g.id} className="card card-link" href={href("contacts", "groups", g.id)} data-testid="group-card">
            <div className="card-row"><h3 className="card-title">{g.name}</h3><Chip>{people(g.members)}</Chip></div>
            {g.description && <div className="muted small">{g.description}</div>}
            <div className="muted small">Updated {timeAgo(g.updated_at)} · by {g.created_by.replace(/^agent:/, "")}</div>
          </a>
        ))}
      </div>
    </>
  );
}

// ---------- detail ----------
export function GroupDetail({ id }: { id: string }) {
  const q = useLoad<{ group: any; members: any[] }>(`/api/groups/${encodeURIComponent(id)}`);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (q.loading && !q.data) return <Spinner />;
  if (q.error && !q.data) return <><a className="back" href={href("contacts", "groups")}>‹ Groups</a><ErrorNote>{q.error}</ErrorNote></>;
  const { group, members } = q.data!;

  const startEdit = () => { setName(group.name); setDesc(group.description); setErr(null); setEditing(true); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { await patch(`/api/groups/${group.id}`, { name, description: desc }); setEditing(false); await q.reload(); toast("Saved."); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (m: any) => {
    try { await post(`/api/groups/${group.id}/remove`, { handles: [m.handle] }); await q.reload(); toast(`Removed ${m.contact?.display_name || m.name || prettyHandle(m.handle)}.`); }
    catch (e) { toast(errText(e), "bad"); }
  };
  const del = async () => {
    setBusy(true);
    try { await api("DELETE", `/api/groups/${group.id}`); toast("Group deleted."); navigate("contacts", "groups"); }
    catch (e) { toast(errText(e), "bad"); setConfirmDelete(false); } finally { setBusy(false); }
  };
  const prompt = `Draft a personalised message to everyone in my agent-outbox group '${group.name}': [what to say]`;

  return (
    <>
      <a className="back" href={href("contacts", "groups")}>‹ Groups</a>
      {!editing ? (
        <>
          <h1 className="page-title" data-testid="group-name">{group.name}</h1>
          {group.description && <p className="muted" data-testid="group-desc">{group.description}</p>}
          <div className="chips tight"><Chip>{people(group.members)}</Chip><Chip>made by {group.created_by.replace(/^agent:/, "")}</Chip></div>
          <button className="btn btn-small" onClick={startEdit} data-testid="group-rename">Rename or describe</button>
        </>
      ) : (
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus data-testid="group-name-input" /></label>
          <label className="field"><span>Description (optional)</span><textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></label>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="row-gap" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()} data-testid="group-save">{busy ? "Saving…" : "Save"}</button>
            <button className="btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="section">
        <h2 className="section-title">Use it</h2>
        <p className="small">Paste this into Claude Code (or any agent with the agent-outbox tools). Fill in the bracket; the messages land in your Inbox for you to approve.</p>
        <div className="cmd" data-testid="group-prompt"><code>{prompt}</code><button className="btn btn-small" onClick={async () => { const ok = await copyText(prompt); toast(ok ? "Copied." : "Copy failed.", ok ? "good" : "bad"); }}>Copy</button></div>
      </section>

      <section className="section">
        <h2 className="section-title">People ({members.length})</h2>
        {members.length === 0 && <Empty title="Nobody in this group yet">Add people from your address book below.</Empty>}
        <div className="stack" data-testid="group-members">
          {members.map((m) => (
            <div key={m.handle} className="card" data-handle={m.handle}>
              <div className="card-row">
                <strong>{m.contact?.display_name || m.name || "(no name)"}</strong>
                <button className="btn btn-small" onClick={() => void remove(m)} aria-label={`Remove ${m.contact?.display_name || m.name || m.handle}`}>Remove</button>
              </div>
              <div className="muted small">{prettyHandle(m.handle)}{m.contact?.org ? ` · ${m.contact.org}` : ""}{!m.contact ? " · not in your address book" : ""}</div>
            </div>
          ))}
        </div>
      </section>

      <AddPeople group={group} members={members} onAdded={q.reload} />

      <section className="section">
        <button className="btn-danger-text" onClick={() => setConfirmDelete(true)} data-testid="group-delete">Delete this group</button>
      </section>
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this group?"
        footer={<><button className="btn btn-danger btn-wide" disabled={busy} onClick={del} data-testid="group-delete-confirm">{busy ? "Deleting…" : "Delete group"}</button><button className="btn btn-wide" onClick={() => setConfirmDelete(false)}>Keep it</button></>}>
        <p>"{group.name}" and its list of {people(group.members)} will be deleted. Nobody is removed from your address book, and messages already drafted are not affected.</p>
      </Sheet>
    </>
  );
}

/** Search the address book and add a contact with one tap. */
function AddPeople({ group, members, onAdded }: { group: any; members: any[]; onAdded: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const found = useLoad<{ contacts: any[] }>(dq ? `/api/contacts?q=${encodeURIComponent(dq)}&limit=12` : null);
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const have = new Set(members.flatMap((m) => [m.handle, m.contact_id].filter(Boolean)));
  const isIn = (c: any): boolean => have.has(c.id) || [...c.phones.map((p: any) => p.e164), ...c.emails.map((e: any) => String(e.email).toLowerCase())].some((h: string) => have.has(h));
  const add = async (c: any) => {
    setErr(null);
    try {
      const r = await post(`/api/groups/${group.id}/members`, { contact_ids: [c.id] });
      if (r.invalid?.length) setErr(`${c.display_name || "That contact"} wasn't added: ${r.invalid[0].reason}`);
      else toast(`Added ${c.display_name || "contact"}.`);
      await onAdded();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <section className="section">
      <h2 className="section-title">Add people</h2>
      <input type="search" className="search" placeholder="Search your address book" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts to add" data-testid="group-add-search" />
      {err && <ErrorNote>{err}</ErrorNote>}
      {dq && found.loading && !found.data && <Spinner />}
      {dq && found.data && found.data.contacts.length === 0 && <p className="muted small">No matches.</p>}
      <div className="stack">
        {dq && found.data?.contacts.map((c) => {
          const inside = isIn(c);
          const reachable = c.phones.length + c.emails.length > 0;
          return (
            <div key={c.id} className="card" data-testid="group-add-result">
              <div className="card-row">
                <strong>{c.display_name || "(no name)"}</strong>
                {inside ? <Chip tone="good">in the group</Chip> : <button className="btn btn-small" disabled={!reachable} onClick={() => void add(c)}>Add</button>}
              </div>
              <div className="muted small">{reachable ? [...c.phones.map((p: any) => prettyHandle(p.e164)), ...c.emails.map((e: any) => e.email)].join(" · ") : "No phone number or email"}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- Imports page: save the rows as a group ----------
export function SaveRowsAsGroup({ importId, filename }: { importId: string; filename: string }) {
  const [name, setName] = useState(() => String(filename).replace(/\.[^.]+$/, ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      // A group with that name already? Add the rows to it instead of failing.
      let gid: string;
      try { gid = (await post("/api/groups", { name })).group.id; }
      catch (e) { if (e instanceof ApiErr && e.code === "group_exists" && e.data?.id) gid = e.data.id; else throw e; }
      const r = await post(`/api/groups/${gid}/members`, { from_import: { import_id: importId } });
      const skipped = r.invalid?.length ?? 0;
      toast(`${r.added.length} added${r.already.length ? `, ${r.already.length} already there` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
      navigate("contacts", "groups", gid);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="section">
      <h2 className="section-title">Save as a group</h2>
      <p className="small muted">Keep these people as a group so you can message them again later. Rows without a usable number are skipped.</p>
      <label className="field"><span>Group name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="import-group-name" /></label>
      {err && <ErrorNote>{err}</ErrorNote>}
      <button className="btn btn-wide" disabled={busy || !name.trim()} onClick={save} data-testid="import-group-save">{busy ? "Saving…" : "Save rows as a group"}</button>
    </section>
  );
}
