import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useMemo, useState } from "react";
import { errText, post } from "../api";
import { useLoad } from "../hooks";
import { passkeyError } from "../passkeys";
import { href, navigate } from "../router";
import { Chip, Empty, ErrorNote, Sheet, Spinner, Switch, fmtDateTime, prettyHandle, timeAgo, useToast } from "../ui";

type Change = any;

const FIELD_LABEL: Record<string, string> = { given_name: "First name", family_name: "Last name", nickname: "Nickname", org: "Company" };
const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting", review: "Needs approval", approved: "Approved, applying", applied: "Done",
  failed: "Failed", rejected: "Rejected", undone: "Undone",
};
const STATUS_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = {
  pending: "neutral", review: "info", approved: "good", applied: "good", failed: "bad", rejected: "neutral", undone: "neutral",
};
const SET_LABEL: Record<string, string> = { drafting: "waiting", review: "needs approval", approved: "approved", applying: "applying", done: "done", cancelled: "cancelled" };

/** Needs the owner: waiting for a signature, or approved but its approval ended (expired, revoked) so it can be signed again. */
const needsApproval = (c: Change): boolean => c.status === "review" || (c.status === "approved" && !c.covered_by);
const canUndo = (c: Change): boolean => c.status === "applied" && !c.undo_blocked;

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }

/** Address book | Groups | Changes, shared by the Contacts pages. */
export function ContactsNav({ active }: { active: "book" | "groups" | "changes" }) {
  const q = useLoad<{ sets: any[] }>("/api/contact-changes?status=review");
  const n = q.data?.sets.length ?? 0;
  return (
    <div className="seg" role="tablist" aria-label="Contacts sections">
      <a role="tab" aria-selected={active === "book"} className={active === "book" ? "on" : ""} href={href("contacts")}>Address book</a>
      <a role="tab" aria-selected={active === "groups"} className={active === "groups" ? "on" : ""} href={href("contacts", "groups")} data-testid="contacts-groups-tab">Groups</a>
      <a role="tab" aria-selected={active === "changes"} className={active === "changes" ? "on" : ""} href={href("contacts", "changes")} data-testid="contacts-changes-tab">Changes{n > 0 ? ` (${n})` : ""}</a>
    </div>
  );
}

// ---------- what a change does, as lines ----------
function nameOf(c: Change): string {
  if (c.kind === "create") return [c.payload.given_name, c.payload.family_name].filter(Boolean).join(" ") || "New contact";
  return c.before?.display_name || "Contact";
}
const kindLabel = (c: Change): string => (c.kind === "create" ? "New contact" : c.kind === "undo" ? "Undo" : "Edit");

/** before -> after for an edit, or the whole card for a new contact. `payload` is the parsed payload; `before` the cached card (display only). */
function Diff({ kind, payload, before, original }: { kind: string; payload: any; before: any; original?: { kind: string; payload: any } | null }) {
  if (kind === "create") {
    const p = payload ?? {};
    return (
      <dl className="pcard" data-testid="change-diff">
        <dt>Name</dt><dd>{[p.given_name, p.family_name].filter(Boolean).join(" ") || "(no name)"}</dd>
        {p.nickname && <><dt>Nickname</dt><dd>{p.nickname}</dd></>}
        {p.org && <><dt>Company</dt><dd>{p.org}</dd></>}
        {(p.phones ?? []).length > 0 && <><dt>Phone</dt><dd>{p.phones.map((x: any) => prettyHandle(x.e164)).join(", ")}</dd></>}
        {(p.emails ?? []).length > 0 && <><dt>Email</dt><dd>{p.emails.map((x: any) => x.email).join(", ")}</dd></>}
        <dt>Groups</dt><dd>{["Outbox imports", ...(p.groups ?? [])].join(", ")}</dd>
      </dl>
    );
  }
  if (kind === "undo") {
    const created = payload?.undo_kind === "create";
    return (
      <div className="diff" data-testid="change-diff">
        <p className="small">{created ? "Removes the contact that was added, but only if it hasn't been edited since." : "Puts the card back the way it was before the change, but only if it hasn't been edited since."}</p>
        {original && original.kind === "update" && <Diff kind="update" payload={original.payload} before={null} />}
        {original && original.kind === "create" && <Diff kind="create" payload={original.payload} before={null} />}
      </div>
    );
  }
  const p = payload ?? {};
  const rows: React.ReactNode[] = [];
  for (const [k, v] of Object.entries<string>(p.set ?? {})) {
    const was = before ? before[k] : undefined;
    rows.push(
      <div key={k} className="diff-row">
        <span className="diff-k">{FIELD_LABEL[k] ?? k}</span>
        {before && <><span className="from">{was ? was : "empty"}</span><span className="arrow" aria-hidden="true">→</span></>}
        <span className="to">{v === "" ? "cleared" : v}</span>
      </div>,
    );
  }
  for (const x of p.add_phones ?? []) rows.push(<div key={`p${x.e164}`} className="diff-row add"><span className="diff-k">Phone</span><span className="to">+ {prettyHandle(x.e164)}</span></div>);
  for (const x of p.add_emails ?? []) rows.push(<div key={`e${x.email}`} className="diff-row add"><span className="diff-k">Email</span><span className="to">+ {x.email}</span></div>);
  for (const g of p.add_groups ?? []) rows.push(<div key={`g${g}`} className="diff-row add"><span className="diff-k">Group</span><span className="to">+ {g}</span></div>);
  return <div className="diff" data-testid="change-diff">{rows}</div>;
}

// ---------- list ----------
export function ContactChangesList() {
  const q = useLoad<{ sets: any[] }>("/api/contact-changes", { poll: 8000 });
  useEffect(() => {
    const f = () => void q.reload();
    window.addEventListener("outbox:refresh", f);
    return () => window.removeEventListener("outbox:refresh", f);
  }, [q.reload]);
  const sets = q.data?.sets ?? [];
  const review = sets.filter((s) => s.status === "review");
  const running = sets.filter((s) => ["drafting", "approved", "applying"].includes(s.status));
  const closed = sets.filter((s) => !review.includes(s) && !running.includes(s));
  return (
    <>
      <h1 className="page-title">Contacts</h1>
      <ContactsNav active="changes" />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Spinner />}
      {q.data && sets.length === 0 && <Empty title="No contact changes">When a Claude session proposes new contacts or edits, they show up here. New people are never added automatically: every new contact and every edit waits here for your Touch ID approval, and nothing reaches your address book before that. You can undo any change after it is applied.</Empty>}
      {review.length > 0 && <section className="section"><h2 className="section-title">Needs your approval</h2><div className="stack">{review.map((s) => <SetCard key={s.id} s={s} />)}</div></section>}
      {running.length > 0 && <section className="section"><h2 className="section-title">Approved, applying</h2><div className="stack">{running.map((s) => <SetCard key={s.id} s={s} />)}</div></section>}
      {closed.length > 0 && <section className="section"><h2 className="section-title">History</h2><div className="stack">{closed.slice(0, 40).map((s) => <SetCard key={s.id} s={s} muted />)}</div></section>}
    </>
  );
}

/** One set, as a card. Also used by the Inbox. */
export function SetCard({ s, muted }: { s: any; muted?: boolean }) {
  const c = s.counts ?? {};
  return (
    <a className={`card card-link ${muted ? "muted-card" : ""}`} href={href("contacts", "changes", s.id)} data-testid="contact-set-card">
      <div className="card-row"><h3 className="card-title">{s.title}</h3><span className="muted nowrap">{timeAgo(s.created_at)}</span></div>
      <div className="chips">
        {(c.review ?? 0) > 0 && <Chip tone="info">{c.review} to approve</Chip>}
        {(c.approved ?? 0) > 0 && <Chip tone="good">{c.approved} approved</Chip>}
        {(c.applied ?? 0) > 0 && <Chip tone="good">{c.applied} done</Chip>}
        {(c.undone ?? 0) > 0 && <Chip>{c.undone} undone</Chip>}
        {(c.failed ?? 0) > 0 && <Chip tone="bad">{c.failed} failed</Chip>}
        {(c.rejected ?? 0) > 0 && <Chip>{c.rejected} rejected</Chip>}
        {s.source === "undo" && <Chip tone="warn">Undo</Chip>}
        {s.status === "cancelled" && <Chip>cancelled</Chip>}
      </div>
      <div className="muted small">Contacts · from {s.created_by.replace(/^agent:/, "")} · {SET_LABEL[s.status] ?? s.status}</div>
    </a>
  );
}

// ---------- detail ----------
export function ContactChangeDetail({ id, status }: { id: string; status: any }) {
  const q = useLoad<any>(`/api/contact-changes/${encodeURIComponent(id)}`, { poll: 6000 });
  const toast = useToast();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <Spinner />;
  if (q.error && !q.data) return <><BackLink /><ErrorNote>{q.error}</ErrorNote></>;
  const { set, changes, approvals } = q.data as { set: any; changes: Change[]; approvals: any[] };
  const killed = !!status?.kill_switch;

  const pending = changes.filter(needsApproval);
  const selected = pending.filter((c) => !excluded.has(c.id));
  const waiting = changes.filter((c) => (c.status === "pending" || (c.status === "approved" && c.covered_by)));
  const history = changes.filter((c) => !pending.includes(c) && !waiting.includes(c));
  const undoable = changes.filter(canUndo);
  const cancelled = set.status === "cancelled";
  const flip = (cid: string, on: boolean) => setExcluded((s) => { const n = new Set(s); if (on) n.delete(cid); else n.add(cid); return n; });

  const reject = async (cids: string[]) => {
    setBusy(true);
    try { const r = await post(`/api/contact-changes/${set.id}/reject`, { change_ids: cids }); toast(`${r.rejected} change${r.rejected === 1 ? "" : "s"} rejected.`); await q.reload(); }
    catch (e) { toast(errText(e), "bad"); await q.reload(); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!confirm(`Cancel "${set.title}"? Nothing that hasn't been applied yet will be.`)) return;
    try { await post(`/api/contact-changes/${set.id}/cancel`); toast("Set cancelled."); await q.reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  const undo = async (cids: string[]) => {
    setBusy(true);
    try {
      const r = await post("/api/contact-changes/undo", { change_ids: cids });
      toast("Undo is ready. Approve it with Touch ID.");
      navigate("contacts", "changes", r.set_id);
    } catch (e) { toast(errText(e), "bad"); await q.reload(); } finally { setBusy(false); }
  };

  return (
    <>
      <BackLink />
      <h1 className="page-title">{set.title}</h1>
      <div className="chips tight">
        <Chip tone={set.status === "review" ? "info" : set.status === "cancelled" ? "neutral" : "good"}>{SET_LABEL[set.status] ?? set.status}</Chip>
        {set.source === "undo" && <Chip tone="warn">Undo</Chip>}
        {Object.entries(q.data.counts as Record<string, number>).map(([k, n]) => <Chip key={k} tone={STATUS_TONE[k] ?? "neutral"}>{n} {(STATUS_LABEL[k] ?? k).toLowerCase()}</Chip>)}
      </div>
      <p className="muted small">From {set.created_by.replace(/^agent:/, "")} · {timeAgo(set.created_at)} · {set.source}</p>
      {q.data.contacts_transport === "live"
        ? <div className="note note-warn small" data-testid="contacts-live-note">Contact changes are <strong>live</strong>: approved changes really edit your Contacts{q.data.pin_contacts_live_allowed ? "." : ", but the installed pin doesn't allow it yet, so the sender will only log them."}</div>
        : <p className="fine">Dry run: approved changes are only logged, your Contacts are not touched.</p>}

      {pending.length > 0 && (
        <section className="section">
          <h2 className="section-title">Needs your approval ({pending.length})</h2>
          <div className="stack">
            {pending.map((c) => (
              <article key={c.id} className={`card change ${excluded.has(c.id) ? "dim" : ""}`} data-change={c.id} data-kind={c.kind} data-status={c.status}>
                <div className="draft-head">
                  <div className="who"><div className="name">{nameOf(c)}</div></div>
                  <label className="inc"><span>Include</span><Switch checked={!excluded.has(c.id)} onChange={(v) => flip(c.id, v)} label={`Include ${nameOf(c)}`} /></label>
                </div>
                <div className="chips tight">
                  <Chip tone={c.kind === "undo" ? "warn" : "info"}>{kindLabel(c)}</Chip>
                  {c.note && c.note !== "new contact" && <Chip tone="warn">{c.note}</Chip>}
                  {c.status === "approved" && <Chip tone="warn" title="Its approval ran out or was cancelled. Approve it again.">Approval ended</Chip>}
                </div>
                <Diff kind={c.kind} payload={c.payload} before={c.before} original={c.original} />
                {c.error && <div className="note note-bad small">Last attempt: {c.error}</div>}
                <button className="btn btn-small reject-btn" disabled={busy || c.status !== "review"} onClick={() => reject([c.id])} data-testid="reject-change">Reject</button>
              </article>
            ))}
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="section">
          <h2 className="section-title">Waiting to apply ({waiting.length})</h2>
          <div className="stack">{waiting.map((c) => <HistoryRow key={c.id} c={c} onUndo={undo} busy={busy} />)}</div>
        </section>
      )}

      {history.length > 0 && (
        <section className="section" data-testid="contact-history">
          <div className="card-row"><h2 className="section-title">History</h2>
            {undoable.length > 1 && <button className="btn btn-small" disabled={busy} onClick={() => undo(undoable.map((c) => c.id))} data-testid="undo-all">Undo all ({undoable.length})</button>}
          </div>
          <div className="stack">{history.map((c) => <HistoryRow key={c.id} c={c} onUndo={undo} busy={busy} />)}</div>
        </section>
      )}

      {approvals.length > 0 && (
        <section className="section">
          <h2 className="section-title">Approvals</h2>
          <div className="stack">
            {approvals.map((a: any) => (
              <div key={a.id} className="card small">
                {a.items} change{a.items === 1 ? "" : "s"} · signed {timeAgo(a.created_at)} · {a.transport === "live" ? <Chip tone="warn">live</Chip> : <Chip>dry run</Chip>}{" "}
                {a.revoked_at ? <Chip>revoked</Chip> : Date.parse(a.not_after) < Date.now() ? <Chip>expired</Chip> : <Chip tone="good">valid until {fmtDateTime(a.not_after)}</Chip>}
              </div>
            ))}
          </div>
        </section>
      )}
      {!cancelled && set.status !== "done" && changes.some((c) => ["pending", "review", "approved"].includes(c.status)) && (
        <button className="btn btn-danger-text" onClick={cancel} data-testid="cancel-set">Cancel this set</button>
      )}

      <div className="approve-spacer" />
      {pending.length > 0 && !cancelled && (
        <div className="approvebar">
          {killed && <div className="approve-est small bad">Sending is stopped. Contact changes are stopped too until you resume.</div>}
          <button className="btn btn-primary btn-wide" disabled={selected.length === 0 || busy} onClick={() => setSheet(true)} data-testid="contacts-approve">
            {selected.length === 0 ? "Nothing to approve" : `Approve ${selected.length} with Touch ID`}
          </button>
        </div>
      )}

      {sheet && <ContactApproveSheet setId={set.id} changeIds={selected.map((c) => c.id)} onClose={() => { setSheet(false); void q.reload(); }} />}
    </>
  );
}

const BackLink = () => <a className="back" href={href("contacts", "changes")}>‹ Contact changes</a>;

function HistoryRow({ c, onUndo, busy }: { c: Change; onUndo: (ids: string[]) => void; busy: boolean }) {
  return (
    <div className="card change-row" data-change={c.id} data-kind={c.kind} data-status={c.status}>
      <div className="card-row">
        <div className="who"><div className="name">{nameOf(c)}</div><div className="muted small">{kindLabel(c)}{c.note ? ` · ${c.note}` : ""}</div></div>
        <Chip tone={STATUS_TONE[c.status] ?? "neutral"}>{STATUS_LABEL[c.status] ?? c.status}{c.status === "applied" && c.transport === "dry" ? " (dry run)" : ""}</Chip>
      </div>
      <Diff kind={c.kind} payload={c.payload} before={null} original={c.original} />
      {c.error && <div className="note note-bad small">{c.error}</div>}
      {c.status === "applied" && (canUndo(c)
        ? <button className="btn btn-small" disabled={busy} onClick={() => onUndo([c.id])} data-testid="undo-change">Undo</button>
        : c.undo_blocked ? <p className="fine">Can't undo: {c.undo_blocked}.</p> : null)}
    </div>
  );
}

// ---------- approve sheet ----------
function ContactApproveSheet({ setId, changeIds, onClose }: { setId: string; changeIds: string[]; onClose: () => void }) {
  const [phase, setPhase] = useState<"loading" | "confirm" | "signing" | "done" | "error">("loading");
  const [opt, setOpt] = useState<any>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<any>(null);
  const [attempt, setAttempt] = useState(0);
  const idsKey = changeIds.join(",");

  useEffect(() => {
    let dead = false;
    setErr(""); setPhase("loading");
    (async () => {
      try {
        const r = await post(`/api/contact-changes/${encodeURIComponent(setId)}/approve/options`, { change_ids: changeIds });
        // What is shown must be exactly what the passkey signature commits to: re-hash every payload against the manifest.
        const m = r.manifest;
        if (m.kind !== "contacts" || m.set_id !== setId) throw new Error("This isn't the approval you asked for. Nothing was approved; reload and try again.");
        const seen = new Set<string>();
        for (const item of m.contact_items) {
          const payload = r.payloads[item.change_id];
          if (payload === undefined || (await sha256Hex(payload)) !== item.payload_sha256) throw new Error("The changes shown don't match what would be signed. Nothing was approved; reload and try again.");
          seen.add(item.change_id);
        }
        if (seen.size !== changeIds.length) throw new Error("The list shown doesn't match what would be signed. Nothing was approved; reload and try again.");
        if (!dead) { setOpt(r); setPhase("confirm"); }
      } catch (e) { if (!dead) { setErr(errText(e)); setPhase("error"); } }
    })();
    return () => { dead = true; };
  }, [setId, idsKey, attempt]);

  const sign = async () => {
    setPhase("signing"); setErr("");
    try {
      const response = await startAuthentication({ optionsJSON: opt.options });
      const r = await post(`/api/contact-changes/${encodeURIComponent(setId)}/approve/verify`, { challenge_id: opt.challenge_id, response });
      setResult(r); setPhase("done");
    } catch (e: any) { setErr(e?.status ? errText(e) : passkeyError(e)); setPhase("error"); }
  };

  const m = opt?.manifest;
  const live = m?.transport === "live";
  const undoLive = opt?.live_reason === "undo_of_live"; // live only because it undoes changes that were made live
  const pinOk = !!opt?.pin_contacts_live_allowed;
  // Rendered from the verified payload bytes, never from the cards behind the sheet.
  const items = useMemo(() => (m?.contact_items ?? []).map((it: any) => ({ it, payload: JSON.parse(opt.payloads[it.change_id]), d: opt.display?.[it.change_id] })), [opt]);
  const counts = useMemo(() => {
    const c = { create: 0, update: 0, undo: 0 };
    for (const x of items) c[x.it.kind as "create" | "update" | "undo"]++;
    return c;
  }, [items]);

  return (
    <Sheet open onClose={onClose} title={phase === "done" ? "Approved" : `Approve ${changeIds.length} contact change${changeIds.length === 1 ? "" : "s"}`}
      footer={
        phase === "confirm" ? <><button className="btn btn-primary btn-wide" onClick={sign} data-testid="contacts-sign">Approve with Touch ID</button><button className="btn btn-wide" onClick={onClose}>Go back</button></>
        : phase === "signing" ? <button className="btn btn-primary btn-wide" disabled>Waiting for Touch ID…</button>
        : phase === "done" ? <button className="btn btn-primary btn-wide" onClick={onClose} data-testid="contacts-done">Done</button>
        : phase === "error" ? <><button className="btn btn-primary btn-wide" onClick={() => setAttempt((a) => a + 1)}>Start again</button><button className="btn btn-wide" onClick={onClose}>Close</button></>
        : null
      }>
      {phase !== "done" && opt && (live
        ? pinOk
          ? <div className="live-banner" data-testid="contacts-live-banner" role="alert"><strong>LIVE</strong> These changes will really edit your Contacts.{undoLive && " It is live because it undoes changes that were made live."}</div>
          : <div className="live-banner live-banner-off" data-testid="contacts-live-banner" role="alert"><strong>Live is on, but the installed pin doesn't allow it.</strong> The sender will only log these changes. Fix the pin in Settings.</div>
        : <div className="dry-banner" data-testid="contacts-dry-banner">Dry run: your Contacts are not touched. The sender only logs what it would change.</div>)}
      {phase === "loading" && <Spinner />}
      {phase === "error" && <ErrorNote>{err}</ErrorNote>}
      {phase === "done" && (
        <div className="success" data-testid="contacts-approve-success">
          <div className="check" aria-hidden="true">✓</div>
          <h3>{result.count} change{result.count === 1 ? "" : "s"} approved</h3>
          <p className="muted">{result.transport === "live" ? "They are applied to your Contacts within a few seconds." : "Dry run: the sender logs them without touching Contacts."}</p>
          <p className="fine">Approval valid until {fmtDateTime(result.not_after)}. You can undo any change afterwards.</p>
        </div>
      )}
      {(phase === "confirm" || phase === "signing") && opt && (
        <>
          <div className="summary chips tight" data-testid="contacts-sheet-summary">
            {counts.update > 0 && <Chip tone="info">{counts.update} edit{counts.update === 1 ? "" : "s"}</Chip>}
            {counts.create > 0 && <Chip tone="info">{counts.create} new contact{counts.create === 1 ? "" : "s"}</Chip>}
            {counts.undo > 0 && <Chip tone="warn">{counts.undo} undo</Chip>}
          </div>
          <p className="muted small">You are signing exactly this list. Check each contact and change.</p>
          <ol className="manifest" data-testid="contacts-manifest-list">
            {items.map(({ it, payload, d }: any) => (
              <li key={it.change_id} data-change={it.change_id} data-kind={it.kind}>
                <div className="who m-head"><div className="name">{it.kind === "create" ? [payload.given_name, payload.family_name].filter(Boolean).join(" ") || "New contact" : d?.before?.display_name || "Contact (not in the cache)"}</div></div>
                <div className="chips tight"><Chip tone={it.kind === "undo" ? "warn" : "info"}>{it.kind === "create" ? "New contact" : it.kind === "undo" ? "Undo" : "Edit"}</Chip></div>
                <Diff kind={it.kind} payload={payload} before={d?.before ?? null} original={d?.original ?? null} />
              </li>
            ))}
          </ol>
          <p className="fine">Valid for 24 hours, until {fmtDateTime(m.not_after)}.</p>
        </>
      )}
    </Sheet>
  );
}
