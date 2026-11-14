import { useState } from "react";
import { useDebounced, useLoad } from "../hooks";
import { errText, post } from "../api";
import { href } from "../router";
import { Chip, Empty, ErrorNote, Spinner, prettyHandle } from "../ui";
import { ContactsNav } from "./ContactChanges";

export function Contacts() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const list = useLoad<{ contacts: any[]; total: number }>(`/api/contacts?q=${encodeURIComponent(dq)}&limit=80`);
  const pending = useLoad<{ pending: any[] }>("/api/contacts/pending");
  const [sync, setSync] = useState("");
  const requestSync = async () => {
    try {
      const r = await post<{ already_pending: boolean }>("/api/contacts/sync");
      setSync(r.already_pending ? "A sync is already waiting for the sender." : "Sync requested. The first time, allow Contacts when macOS asks, then tap Sync again.");
    } catch (e) { setSync(errText(e)); }
  };
  return (
    <>
      <h1 className="page-title">Contacts</h1>
      <ContactsNav active="book" />
      <div className="card-row"><button className="btn" onClick={requestSync}>Sync contacts from the Mac</button></div>
      {sync && <p className="muted small" role="status">{sync}</p>}
      <input type="search" className="search" placeholder="Search name, number, company" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
      {(pending.data?.pending.length ?? 0) > 0 && !dq && (
        <section className="section">
          <h2 className="section-title">Waiting to be created</h2>
          <p className="muted small">Added to your address book only when the batch they belong to is approved.</p>
          <div className="stack">
            {pending.data!.pending.map((p) => (
              <a key={p.draft_id} className="card card-link" href={href("batch", p.batch_id)}>
                <div className="card-row"><strong>{[p.proposed_contact.given_name, p.proposed_contact.family_name].filter(Boolean).join(" ") || p.recipient_name || p.handle}</strong>
                  <Chip tone={p.create_contact ? "info" : "neutral"}>{p.create_contact ? "will be added" : "not added"}</Chip></div>
                <div className="muted small">{prettyHandle(p.handle)} · {p.batch_title}</div>
              </a>
            ))}
          </div>
        </section>
      )}
      <section className="section">
        <h2 className="section-title">{dq ? "Results" : `Address book${list.data ? ` (${list.data.total})` : ""}`}</h2>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {list.loading && !list.data && <Spinner />}
        {list.data && list.data.contacts.length === 0 && <Empty title={dq ? "No matches" : "No contacts yet"}>{dq ? "Try a different spelling or part of a number." : "Contacts appear after the sender exports your address book (Contacts access isn't granted yet) or after an approved batch creates them."}</Empty>}
        <div className="stack">
          {list.data?.contacts.map((c) => (
            <div key={c.id} className="card">
              <div className="card-row"><strong>{c.display_name || "(no name)"}</strong><span className="muted small">{c.source}</span></div>
              <div className="muted small">{[...c.phones.map((p: any) => prettyHandle(p.e164)), ...c.emails.map((e: any) => e.email)].join(" · ")}{c.org ? ` · ${c.org}` : ""}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
