import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounced, useLoad } from "../hooks";
import { errText, get, post } from "../api";
import { href } from "../router";
import { Chip, Empty, ErrorNote, Spinner, prettyHandle } from "../ui";
import { ContactsNav } from "./ContactChanges";

const PAGE = 100;
interface ContactsPage { contacts: any[]; total: number; matched: number; offset: number; limit: number; has_more: boolean }

/** The whole address book, a page at a time: the next page loads when the end of the list scrolls into view ("Show more" is the fallback).
 *  A new search starts over; a page that comes back after the query changed is dropped, never appended to the new list. */
function useContactPages(q: string) {
  const [items, setItems] = useState<any[]>([]);
  const [counts, setCounts] = useState<{ total: number; matched: number; more: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState(0);   // pages that arrived (not errors): the "load more" observer re-arms on each, even when dedupe added nothing
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);          // bumped on every new query; responses from older ones are ignored
  const busy = useRef(false);
  const next = useRef(0);         // server offset of the next page

  const fetchPage = useCallback(async (g: number, offset: number) => {
    busy.current = true; setLoading(true);
    try {
      const r = await get<ContactsPage>(`/api/contacts?q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`);
      if (g !== gen.current) return;
      next.current = r.offset + r.contacts.length;
      // Contacts can change between pages and shift the offsets; never show one twice.
      setItems((prev) => { const have = new Set(prev.map((c) => c.id)); return [...prev, ...r.contacts.filter((c) => !have.has(c.id))]; });
      setCounts({ total: r.total, matched: r.matched, more: r.has_more }); setError(null); setPages((n) => n + 1);
    } catch (e) { if (g === gen.current) setError(errText(e)); }
    finally { if (g === gen.current) { busy.current = false; setLoading(false); } }
  }, [q]);

  useEffect(() => {
    const g = ++gen.current;
    busy.current = false; next.current = 0;
    setItems([]); setCounts(null); setError(null);
    void fetchPage(g, 0);
  }, [fetchPage]);

  const more = useCallback(() => { if (!busy.current && counts?.more) void fetchPage(gen.current, next.current); }, [fetchPage, counts?.more]);
  return { items, counts, loading, error, more, pages };
}

export function Contacts() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const book = useContactPages(dq);
  const pending = useLoad<{ pending: any[] }>("/api/contacts/pending");
  const sentinel = useRef<HTMLDivElement>(null);
  // Re-observed after every page that arrives (not after every new item: a page that is all repeats adds none, and the
  // sentinel, still on screen, would then never fire again), so a short list or a tall window keeps loading.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !book.counts?.more || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) book.more(); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [book.counts?.more, book.pages, book.more]);
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
        <h2 className="section-title" data-testid="book-title">
          {dq ? (book.counts ? `${book.counts.matched} ${book.counts.matched === 1 ? "match" : "matches"}` : "Searching") : `Address book${book.counts ? ` (${book.counts.total})` : ""}`}
        </h2>
        {book.error && <ErrorNote>{book.error}</ErrorNote>}
        {book.loading && book.items.length === 0 && <Spinner />}
        {book.counts && book.items.length === 0 && <Empty title={dq ? "No matches" : "No contacts yet"}>{dq ? "Try a different spelling or part of a number." : "Contacts appear after the sender exports your address book (Contacts access isn't granted yet) or after an approved batch creates them."}</Empty>}
        <div className="stack" data-testid="book-list">
          {book.items.map((c) => (
            <div key={c.id} className="card" data-testid="contact-card">
              <div className="card-row"><strong>{c.display_name || "(no name)"}</strong><span className="muted small">{c.source}</span></div>
              <div className="muted small">{[...c.phones.map((p: any) => prettyHandle(p.e164)), ...c.emails.map((e: any) => e.email)].join(" · ")}{c.org ? ` · ${c.org}` : ""}</div>
            </div>
          ))}
        </div>
        {book.counts?.more && (
          <div ref={sentinel} className="card-row" style={{ justifyContent: "center", marginTop: 12 }}>
            {/* The scroll sentinel and the fallback in one: tapping works where scrolling doesn't load the next page. */}
            <button className="btn" onClick={book.more} disabled={book.loading} data-testid="show-more">{book.loading ? "Loading…" : "Show more"}</button>
          </div>
        )}
      </section>
    </>
  );
}
