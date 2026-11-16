import { startAuthentication } from "@simplewebauthn/browser";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errText, patch, post } from "../api";
import { useLoad } from "../hooks";
import { passkeyError } from "../passkeys";
import { href } from "../router";
import { fmtSpan, fmtWhen, fmtWindow, nextSendLine } from "../pacing";
import { Chip, Empty, ErrorNote, Sheet, Spinner, Switch, fmtDateTime, fmtShort, prettyHandle, timeAgo, useToast } from "../ui";

type Draft = any;
/** Warnings that make a message impossible to approve (nothing, or nowhere, to send). Mirrors UNSENDABLE_WARNINGS in src/owner-api/approval.ts. */
const UNSENDABLE = ["empty_body", "invalid_handle"];
/** Warnings that hold a message back until the owner turns on the one batch-level "include anyway" switch. Mirrors HELD_WARNINGS in src/owner-api/approval.ts.
 *  Every other warning is advisory and never holds anything back. */
const HELD = ["unresolved_var", "duplicate_recipient"];
/** Short phrase per warning for the approve sheet summary ("40 have a link"). */
const WARNING_PHRASE: Record<string, string> = {
  unresolved_var: "with an unfilled field", empty_var: "with an empty field", duplicate_recipient: "exact duplicates", pending_elsewhere: "pending in another batch",
  recently_messaged: "messaged recently", invalid_handle: "with an invalid number", non_mobile: "not a mobile", too_long: "very long",
  identical_to_template: "same as the template", empty_body: "empty", ambiguous_contact: "with an ambiguous contact", link_in_first_message: "have a link", group_contact_changed: "whose contact changed",
};
const WARNING_LABEL: Record<string, string> = {
  unresolved_var: "Unfilled field", empty_var: "Empty field", duplicate_recipient: "Duplicate", pending_elsewhere: "Pending elsewhere",
  recently_messaged: "Messaged recently", invalid_handle: "Invalid number", non_mobile: "Not a mobile", too_long: "Very long",
  identical_to_template: "Same as template", empty_body: "Empty", new_contact: "New contact", ambiguous_contact: "Ambiguous contact",
  link_in_first_message: "Has a link", group_contact_changed: "Contact changed",
};
const warningsOf = (d: Draft): { code: string; message: string }[] => (d.warnings ?? []).filter((w: any) => w.code !== "new_contact");
const isHeld = (d: Draft): boolean => (d.warnings ?? []).some((w: any) => HELD.includes(w.code));
const isUnsendable = (d: Draft): boolean => (d.warnings ?? []).some((w: any) => UNSENDABLE.includes(w.code));
const warnTone = (code: string): "bad" | "warn" => (HELD.includes(code) || UNSENDABLE.includes(code) ? "bad" : "warn");
/** In the selection: waiting for approval and not inside a LIVE approval. (An `approved` draft whose approval expired or was revoked has covered_by null, so it is approvable again.) */
const wantsApproval = (d: Draft): boolean => !d.covered_by && (["review", "failed"].includes(d.status) || d.status === "approved");
const isApprovable = (d: Draft): boolean => wantsApproval(d) && !!d.body.trim() && !isUnsendable(d);
const isTogglable = (d: Draft): boolean => ["draft", "review", "failed", "skipped"].includes(d.status);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Consecutive messages (by position) to the same handle: one recipient, one box. */
interface Group { key: string; handle: string; name: string; drafts: Draft[] }
function groupDrafts(ds: Draft[]): Group[] {
  const out: Group[] = [];
  for (const d of [...ds].sort((a, b) => a.position - b.position)) {
    const g = out[out.length - 1];
    if (g && g.handle === d.handle) { g.drafts.push(d); if (!g.name && d.recipient_name) g.name = d.recipient_name; }
    else out.push({ key: d.id, handle: d.handle, name: d.recipient_name ?? "", drafts: [d] });
  }
  return out;
}
const peopleCount = (ds: Draft[]): number => new Set(ds.map((d) => d.handle)).size;
/** Warnings of a group merged by code (the chips and list in its header). */
function mergedWarnings(ds: Draft[]): { code: string; message: string }[] {
  const m = new Map<string, Set<string>>();
  for (const d of ds) for (const w of warningsOf(d)) { if (!m.has(w.code)) m.set(w.code, new Set()); m.get(w.code)!.add(w.message); }
  return [...m].map(([code, msgs]) => ({ code, message: [...msgs].join("\n") }));
}
type Filter = "all" | "warnings" | "new" | "skipped";

export function BatchPage({ id, status }: { id: string; status: any }) {
  const q = useLoad<any>(`/api/batches/${encodeURIComponent(id)}`);
  const toast = useToast();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sheet, setSheet] = useState(false);
  const [saving, setSaving] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const flushers = useRef(new Map<string, () => Promise<void>>());
  useEffect(() => { if (q.data) setDrafts(q.data.drafts); }, [q.data]);

  const update = useCallback((d: Draft) => setDrafts((ds) => ds.map((x) => (x.id === d.id ? { ...x, ...d } : x))), []);
  const register = useCallback((did: string, fn: (() => Promise<void>) | null) => { if (fn) flushers.current.set(did, fn); else flushers.current.delete(did); }, []);

  if (q.loading && !q.data) return <Spinner />;
  if (q.error && !q.data) return <><BackLink /><ErrorNote>{q.error}</ErrorNote></>;
  const { batch, settings, approvals } = q.data;

  // Everything below is driven by the DRAFTS, not by batch.status: a batch marked done can still hold unapproved drafts.
  const selected = drafts.filter(isApprovable);
  const noText = drafts.filter((d) => wantsApproval(d) && !isApprovable(d)).length; // empty or invalid number: can't be sent
  const held = selected.filter(isHeld);
  const warned = selected.filter((d) => warningsOf(d).length > 0);
  const killed = !!status?.kill_switch;
  const cancelled = batch.status === "cancelled";
  const counts = countBy(drafts);
  const toReview = selected.length;
  const shownStatus = cancelled ? "cancelled" : toReview > 0 ? "review" : (counts.approved ?? 0) + (counts.sending ?? 0) > 0 ? "approved" : batch.status;
  const showBar = !cancelled && (toReview > 0 || (batch.status !== "done" && noText === 0 && drafts.some(wantsApproval)) || noText > 0);
  const approvalById = new Map<string, any>(approvals.map((a: any) => [a.id, a]));

  // A filter shows whole groups: any group that contains a matching message.
  const matches = (f: Filter, d: Draft): boolean => (f === "all" ? true : f === "warnings" ? warningsOf(d).length > 0 : f === "new" ? !!d.proposed_contact : d.status === "skipped");
  const groups = groupDrafts(drafts);
  const filtered = groups.filter((g) => g.drafts.some((d) => matches(filter, d)));
  const fcount = (f: Filter) => groups.filter((g) => g.drafts.some((d) => matches(f, d))).length;

  const toggle = async (d: Draft, on: boolean) => {
    const before = d.status;
    update({ ...d, status: on ? "review" : "skipped" });
    try {
      const r = await post(`/api/drafts/${d.id}/${on ? "include" : "skip"}`);
      if (r.revoked_approvals) { toast("Approval cancelled; the other messages need approving again."); await q.reload(); }
    } catch (e) { update({ ...d, status: before }); toast(errText(e), "bad"); }
  };
  /** One request for a whole group: on = include every skipped message, off = skip every included one. */
  const toggleGroup = async (g: Group, on: boolean) => {
    const targets = g.drafts.filter((d) => isTogglable(d) && (on ? d.status === "skipped" : d.status !== "skipped"));
    if (targets.length === 0) return;
    const before = new Map(targets.map((d) => [d.id, d.status]));
    setDrafts((ds) => ds.map((x) => (before.has(x.id) ? { ...x, status: on ? "review" : "skipped" } : x)));
    try {
      await post(`/api/batches/${batch.id}/skip`, { draft_ids: targets.map((d) => d.id), skipped: !on });
      await q.reload();
    } catch (e) { setDrafts((ds) => ds.map((x) => (before.has(x.id) ? { ...x, status: before.get(x.id) } : x))); toast(errText(e), "bad"); }
  };
  // Leaving out one message of a chain would send half of it, so a group with any warned message goes out whole.
  const warnedGroups = groups.filter((g) => g.drafts.some((d) => warned.includes(d)));
  const warnedIds = warnedGroups.flatMap((g) => g.drafts.filter(isTogglable).filter((d) => d.status !== "skipped").map((d) => d.id));
  const excludeWarned = async () => {
    try {
      const r = await post(`/api/batches/${batch.id}/skip`, { draft_ids: warnedIds, skipped: true });
      toast(`${plural(r.changed, "message")} with warnings left out.`);
      await q.reload();
    } catch (e) { toast(errText(e), "bad"); }
  };

  const openApprove = async () => {
    // Make sure every autosave has landed before the manifest is built.
    await Promise.all([...flushers.current.values()].map((f) => f()));
    await q.reload();
    setSheet(true);
  };
  const cancelBatch = async () => {
    if (!confirm(`Cancel "${batch.title}"? Its messages won't be sent and any approval is revoked.`)) return;
    try { await post(`/api/batches/${batch.id}/cancel`); toast("Batch cancelled."); await q.reload(); } catch (e) { toast(errText(e), "bad"); }
  };

  return (
    <>
      <BackLink />
      <h1 className="page-title">{batch.title}</h1>
      <div className="chips tight">
        <Chip tone={shownStatus === "review" ? "info" : shownStatus === "cancelled" ? "neutral" : "good"}>{shownStatus}</Chip>
        {Object.entries(counts).map(([k, n]) => <Chip key={k} tone={k === "failed" ? "bad" : k === "sent" ? "good" : "neutral"}>{n} {k}</Chip>)}
      </div>
      <p className="muted small">From {batch.created_by.replace(/^agent:/, "")} · {timeAgo(batch.created_at)} · {batch.source}</p>
      {!killed && !cancelled && status?.pacing?.enabled && status?.exec?.alive && ((counts.approved ?? 0) + (counts.sending ?? 0)) > 0 && (
        <p className="small" data-testid="next-send">{nextSendLine(status.pacing.hold)}</p>
      )}
      {(batch.template || batch.instructions) && (
        <details className="details">
          <summary>{batch.template ? "Template" : "Instructions"}</summary>
          <pre className="pre">{batch.template ?? batch.instructions}</pre>
        </details>
      )}
      {batch.import_id && <p className="small"><a href={href("imports", batch.import_id)}>From an import</a></p>}

      {drafts.length > 1 && (
        <div className="filterbar" role="group" aria-label="Filter messages">
          {([["all", "All"], ["warnings", "Warnings"], ["new", "New contacts"], ["skipped", "Skipped"]] as [Filter, string][]).map(([k, label]) => (
            <button key={k} className={`filter ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)} data-filter={k}>{label} <span className="count">{fcount(k)}</span></button>
          ))}
        </div>
      )}
      {warnedIds.length > 0 && !cancelled && (
        <button className="btn btn-small btn-wide btn-warnline" onClick={excludeWarned} data-testid="exclude-warned">Exclude all with warnings ({warnedIds.length})</button>
      )}

      {drafts.length === 0 && <Empty title="No messages yet" />}
      {drafts.length > 0 && filtered.length === 0 && <Empty title="Nothing in this filter" />}
      <div className="stack">
        {filtered.map((g) => {
          const card = (d: Draft, grouped: boolean) => (
            <DraftCard key={d.id} d={d} grouped={grouped} approval={d.covered_by ? approvalById.get(d.covered_by) : null} onUpdate={update} onToggle={toggle} onReload={() => void q.reload()} register={register} onSaving={(n) => setSaving((s) => s + n)} />
          );
          return g.drafts.length === 1 ? card(g.drafts[0]!, false) : <GroupBox key={g.key} g={g} onToggleGroup={toggleGroup} card={card} />;
        })}
      </div>

      {approvals.length > 0 && (
        <section className="section">
          <h2 className="section-title">Approvals</h2>
          <div className="stack">
            {approvals.map((a: any) => (
              <div key={a.id} className="card small">
                {a.items} message{a.items === 1 ? "" : "s"} · signed {timeAgo(a.created_at)} · {a.transport === "live" ? <Chip tone="warn">live</Chip> : <Chip>dry run</Chip>}{" "}
                {a.revoked_at ? <Chip>revoked</Chip> : Date.parse(a.not_after) < Date.now() ? <Chip>expired</Chip> : <Chip tone="good">valid until {fmtDateTime(a.not_after)}</Chip>}
              </div>
            ))}
          </div>
        </section>
      )}
      {!cancelled && batch.status !== "done" && <button className="btn btn-danger-text" onClick={cancelBatch}>Cancel this batch</button>}

      <div className="approve-spacer" />
      {showBar && (
        <div className="approvebar">
          {held.length > 0 && <div className="approve-est small bad">{plural(held.length, "message")} with unfilled fields or exact duplicates will be held back unless you include {held.length === 1 ? "it" : "them"}.</div>}
          {killed && <div className="approve-est small bad">Sending is stopped. You can still approve; it goes out after you resume.</div>}
          {noText > 0 && <div className="approve-est small bad">{plural(noText, "message")} can't be sent (empty or invalid number).</div>}
          <button className="btn btn-primary btn-wide" disabled={selected.length === 0 || saving > 0} onClick={openApprove}>
            {saving > 0 ? "Saving…" : selected.length === 0 ? "Nothing to approve" : `Approve ${plural(selected.length, "message")} to ${plural(peopleCount(selected), "person", "people")}`}
          </button>
        </div>
      )}

      {sheet && (
        <ApproveSheet batchId={batch.id} drafts={selected} transport={status?.transport ?? settings.transport}
          onClose={() => { setSheet(false); void q.reload(); }} />
      )}
    </>
  );
}

const BackLink = () => <a className="back" href={href()}>‹ Inbox</a>;
function countBy(ds: Draft[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const d of ds) c[d.status] = (c[d.status] ?? 0) + 1;
  return c;
}

/** Name and number with equal weight: the number is what the message really goes to. */
function Recipient({ name, handle, className = "" }: { name: string; handle: string; className?: string }) {
  return (
    <div className={`who ${className}`}>
      {name && <div className="name">{name}</div>}
      <div className="name handle-line" data-testid="recipient-handle">{prettyHandle(handle)}</div>
    </div>
  );
}

// ---------- one recipient with several messages ----------
/** One bordered box per recipient: ONE Include switch for all of its messages, merged warnings, then the messages in order. */
function GroupBox({ g, onToggleGroup, card }: { g: Group; onToggleGroup: (g: Group, on: boolean) => void; card: (d: Draft, grouped: boolean) => ReactNode }) {
  const togglable = g.drafts.filter(isTogglable);
  const left = togglable.filter((d) => d.status === "skipped").length;
  const checked = togglable.length > 0 && left === 0;
  const mixed = left > 0 && left < togglable.length;
  const warnings = mergedWarnings(g.drafts);
  const first = g.drafts.find((d) => d.contact) ?? g.drafts[0]!;
  const hasNew = g.drafts.some((d) => !!d.proposed_contact);
  const who = g.name || prettyHandle(g.handle);
  return (
    <article className={`card group ${togglable.length > 0 && left === togglable.length ? "dim" : ""}`} data-group={g.key} data-count={g.drafts.length}>
      <div className="draft-head">
        <div className="who-group">
          <Recipient name={g.name} handle={g.handle} />
          <div className="small muted">{plural(g.drafts.length, "message")}</div>
        </div>
        {togglable.length > 0 && (
          <label className="inc"><span>Include</span><Switch checked={checked} onChange={(v) => onToggleGroup(g, v)} label={`Include all ${g.drafts.length} messages to ${who}`} /></label>
        )}
      </div>
      {mixed && <div className="small muted group-mixed" data-testid="group-mixed">Some messages are left out.</div>}
      <div className="chips tight">
        {first.contact && <Chip tone="info" title="Linked contact">Contact: {first.contact.display_name || "(no name)"}</Chip>}
        {first.contact && first.number_in_contact === false && <Chip tone="bad" title={`This contact's numbers: ${first.contact.handles.map(prettyHandle).join(", ") || "none"}`}>Number not in contact</Chip>}
        {hasNew && <Chip tone="info">New contact</Chip>}
        {warnings.map((w) => <Chip key={w.code} tone={warnTone(w.code)} title={w.message}>{WARNING_LABEL[w.code] ?? w.code}</Chip>)}
      </div>
      {warnings.length > 0 && <ul className="warn-list small">{warnings.flatMap((w) => w.message.split("\n")).map((m, i) => <li key={i}>{m}</li>)}</ul>}
      <div className="group-msgs">{g.drafts.map((d) => card(d, true))}</div>
    </article>
  );
}

// ---------- one draft ----------
function DraftCard({ d, grouped = false, approval, onUpdate, onToggle, onReload, register, onSaving }: {
  d: Draft; grouped?: boolean; approval: any; onUpdate: (d: Draft) => void; onToggle: (d: Draft, on: boolean) => void; onReload: () => void;
  register: (id: string, fn: (() => Promise<void>) | null) => void; onSaving: (delta: number) => void;
}) {
  const [text, setText] = useState<string>(d.body);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState("");
  const dirty = useRef(false);
  const latest = useRef(d.body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const editable = ["draft", "review", "approved", "skipped", "failed"].includes(d.status); // never sending, sent, unknown or rejected

  // Auto-grow.
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }, [text]);
  // Pick up server-side changes (an agent edit, a reload) unless the owner has unsaved typing.
  useEffect(() => { if (!dirty.current && d.body !== latest.current) { latest.current = d.body; setText(d.body); } }, [d.body]);

  const doSave = useCallback(async () => {
    if (!dirty.current) return;
    const body = latest.current;
    dirty.current = false;
    setSave("saving"); onSaving(1);
    const run = (async () => {
      try {
        const r = await patch(`/api/drafts/${d.id}`, { body });
        onUpdate(r.draft); setSave("saved"); setErr("");
      } catch (e) { dirty.current = true; setSave("error"); setErr(errText(e)); }
      finally { onSaving(-1); }
    })();
    inflight.current = run;
    await run;
    if (inflight.current === run) inflight.current = null;
  }, [d.id, onUpdate, onSaving]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    for (let i = 0; i < 5 && (dirty.current || inflight.current); i++) {
      if (inflight.current) await inflight.current;
      if (dirty.current) await doSave();
    }
  }, [doSave]);
  useEffect(() => { register(d.id, flush); return () => register(d.id, null); }, [d.id, flush, register]);

  const onChange = (v: string) => {
    setText(v); latest.current = v; dirty.current = true; setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSave(), 700);
  };
  const apply = async (body: Record<string, unknown>) => {
    try { onUpdate((await patch(`/api/drafts/${d.id}`, body)).draft); setErr(""); onReload(); } catch (x) { setErr(errText(x)); }
  };

  const warnings = warningsOf(d);
  const hasNew = !!d.proposed_contact;
  const included = d.status !== "skipped";
  const togglable = isTogglable(d);
  const ambiguous = (d.warnings ?? []).some((w: any) => w.code === "ambiguous_contact") && editable && d.status !== "skipped";
  const pc = d.proposed_contact;
  const pcName = pc ? [pc.given_name, pc.family_name].filter(Boolean).join(" ") : "";
  const expiredApproval = d.status === "approved" && !d.covered_by;

  const Root = grouped ? "div" : "article";
  const approvedChips = <>
    {d.covered_by && <Chip tone="good">{approval ? `Approved until ${fmtShort(approval.not_after)}` : "Approved"}</Chip>}
    {expiredApproval && <Chip tone="warn" title="Its approval ran out or was cancelled. Approve it again.">Approval ended</Chip>}
  </>;

  return (
    <Root className={grouped ? `msg ${!included ? "dim" : ""}` : `card draft ${!included ? "dim" : ""}`} data-draft={d.id} data-status={d.status} data-covered={d.covered_by ? "1" : "0"}>
      {!grouped && (
        <div className="draft-head">
          <Recipient name={d.recipient_name} handle={d.handle} />
          {togglable && <label className="inc"><span>Include</span><Switch checked={included} onChange={(v) => onToggle(d, v)} label={`Include message to ${d.recipient_name || d.handle}`} /></label>}
          {approvedChips}
        </div>
      )}

      <div className="chips tight">
        {grouped && approvedChips}
        {editable && d.status !== "approved" && d.status !== "sending" ? (
          <label className="svc-pick" aria-label="Service">
            <select value={d.service} onChange={(e) => void apply({ service: e.target.value })}>
              <option value="auto">Auto (iMessage, then SMS)</option><option value="iMessage">iMessage</option><option value="SMS">SMS</option>
            </select>
          </label>
        ) : <Chip>{d.service}</Chip>}
        {!grouped && d.contact && <Chip tone="info" title="Linked contact">Contact: {d.contact.display_name || "(no name)"}</Chip>}
        {!grouped && d.contact && d.number_in_contact === false && <Chip tone="bad" title={`This contact's numbers: ${d.contact.handles.map(prettyHandle).join(", ") || "none"}`}>Number not in contact</Chip>}
        {!grouped && hasNew && <Chip tone="info">New contact</Chip>}
        {!grouped && warnings.map((w, i) => <Chip key={i} tone={warnTone(w.code)} title={w.message}>{WARNING_LABEL[w.code] ?? w.code}</Chip>)}
        {["sent", "failed", "unknown", "sending", "rejected", "skipped"].includes(d.status) && <Chip tone={d.status === "sent" ? "good" : d.status === "failed" ? "bad" : d.status === "unknown" ? "warn" : "neutral"}>{d.status === "unknown" ? "unconfirmed" : d.status}</Chip>}
      </div>

      <textarea ref={ta} className="body-edit" value={text} rows={2} spellCheck
        disabled={!editable} onChange={(e) => onChange(e.target.value)} onBlur={() => void flush()} aria-label={`Message to ${d.recipient_name || d.handle}`} />
      <div className="draft-foot small">
        <span className={`save save-${save}`} role="status">
          {save === "saving" ? "Saving…" : save === "error" ? "Couldn't save" : save === "saved" ? `Saved · revision ${d.version}` : `Revision ${d.version}`}
        </span>
        <span className="muted">{text.length} characters</span>
      </div>
      {err && <div className="note note-bad small" role="alert">{err}</div>}
      {!grouped && warnings.length > 0 && (
        <ul className="warn-list small">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
      )}
      {ambiguous && <ContactPicker d={d} onPick={apply} />}
      {hasNew && editable && !ambiguous && (
        <div className="newcontact small" data-testid="new-contact">
          <label className="inline-row">
            <Switch checked={!!d.create_contact} onChange={(v) => void apply({ create_contact: v })} label="Add to Contacts" />
            <span>Add {pcName || d.handle} to Contacts when approved</span>
          </label>
          {d.create_contact && <ProposedContactView pc={pc} handle={d.handle} />}
        </div>
      )}
      {d.last_send && (
        <div className="small muted">
          Last attempt: {d.last_send.result ?? "in progress"} ({d.last_send.transport}){d.last_send.error ? ` · ${d.last_send.error}` : ""} · {timeAgo(d.last_send.finished_at ?? d.last_send.started_at)}
        </div>
      )}
    </Root>
  );
}

/** "This might be someone you already have": use an existing contact (and its number), or keep this number and create a new one. */
function ContactPicker({ d, onPick }: { d: Draft; onPick: (patch: Record<string, unknown>) => void }) {
  const opts: { contact_id: string; name: string; org: string; handle: string }[] = (d.candidates ?? []).flatMap((c: any) =>
    c.handles.slice(0, 2).map((h: string) => ({ contact_id: c.contact_id, name: c.display_name, org: c.org, handle: h }))).slice(0, 5);
  return (
    <div className="picker" data-testid="contact-picker">
      <div className="small"><strong>This might be someone you already have.</strong> Pick one:</div>
      {opts.map((o) => (
        <button key={`${o.contact_id}${o.handle}`} className="btn btn-small btn-wide pick-btn" onClick={() => onPick({ contact_id: o.contact_id, handle: o.handle })}>
          Use {o.name || "(no name)"}{o.org ? ` (${o.org})` : ""} · {prettyHandle(o.handle)}
        </button>
      ))}
      <button className="btn btn-small btn-wide pick-btn" onClick={() => onPick({ create_contact: true })}>Keep {prettyHandle(d.handle)} + create new contact</button>
    </div>
  );
}

/** The whole proposed contact: name, company, the one handle it will be created with, tags and note. */
function ProposedContactView({ pc, handle }: { pc: any; handle: string }) {
  const name = [pc.given_name, pc.family_name].filter(Boolean).join(" ");
  const handles = [...(pc.phones ?? []).map((p: any) => prettyHandle(p.e164)), ...(pc.emails ?? []).map((e: any) => e.email)];
  return (
    <dl className="pcard" data-testid="proposed-contact">
      <dt>Name</dt><dd>{name || "(no name)"}</dd>
      {pc.org && <><dt>Company</dt><dd>{pc.org}</dd></>}
      <dt>{(pc.emails ?? []).length ? "Email" : "Number"}</dt><dd>{handles.join(", ") || prettyHandle(handle)}</dd>
      {(pc.tags ?? []).length > 0 && <><dt>Tags</dt><dd>{pc.tags.join(", ")}</dd></>}
      {pc.note && <><dt>Note</dt><dd>{pc.note}</dd></>}
    </dl>
  );
}

// ---------- approve sheet ----------
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }

/** Handles of a proposed contact must be exactly the message's own: a mismatch means someone else's number under a trusted name. */
function contactExact(pc: any, to: string): boolean {
  const phones = pc.phones ?? [], emails = pc.emails ?? [];
  return to.includes("@") ? phones.length === 0 && emails.length === 1 && String(emails[0].email).toLowerCase() === to.toLowerCase() : emails.length === 0 && phones.length === 1 && phones[0].e164 === to;
}

/** What "Spread out messages" means for this approval: how long it takes and, if it can't all fit in 7 days, how many would. */
function PlanNote({ plan }: { plan: any }) {
  const span = Math.max(0, Date.parse(plan.expected_finish) - Date.now());
  const over = plan.fits < plan.count;
  return (
    <div className="plan" data-testid="sheet-plan">
      <p className="small"><strong>Sends over about {fmtSpan(span)}</strong> (done around {fmtWhen(plan.expected_finish)}), one message at a time with a pause between them.
        {plan.queued_ahead > 0 && ` ${plural(plan.queued_ahead, "message")} already waiting go first.`}</p>
      {over && (
        <div className="note note-warn small" role="alert" data-testid="sheet-plan-over">
          At this pace only {plan.fits} of these {plan.count} would go out within 7 days, the longest an approval can last. The other {plan.count - plan.fits} would expire unsent. Approve fewer, or loosen "Spread out messages" in Settings.
        </div>
      )}
    </div>
  );
}

function ApproveSheet({ batchId, drafts, transport, onClose }: {
  batchId: string; drafts: Draft[]; transport: string; onClose: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "confirm" | "signing" | "done" | "error" | "empty">("loading");
  const [opt, setOpt] = useState<any>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<any>(null);
  const [attempt, setAttempt] = useState(0);
  const [anyway, setAnyway] = useState(false); // ONE switch for every held message
  const bodies = useMemo(() => new Map<string, string>((opt?.drafts ?? []).map((x: any) => [x.draft_id, x.body])), [opt]);
  const info = useMemo(() => new Map<string, any>((opt?.drafts ?? []).map((x: any) => [x.draft_id, x])), [opt]);

  const held = drafts.filter(isHeld);
  // Messages with unfilled fields or that are exact duplicates are OUT unless the owner turns the one switch on.
  const ids = drafts.filter((d) => !isHeld(d) || anyway).map((d) => d.id);
  const idsKey = ids.join(",");
  const includeAnyway = anyway ? held.map((d) => d.id) : [];
  const picked = drafts.filter((d) => ids.includes(d.id));

  useEffect(() => {
    let dead = false;
    setErr("");
    if (ids.length === 0) { setOpt(null); setPhase("empty"); return; }
    setPhase("loading");
    (async () => {
      try {
        const r = await post(`/api/batches/${encodeURIComponent(batchId)}/approve/options`, { draft_ids: ids, include_anyway: includeAnyway });
        // The text on screen must be exactly what the manifest (and so the passkey signature) commits to.
        const map = new Map<string, string>(r.drafts.map((x: any) => [x.draft_id, x.body]));
        for (const item of r.manifest.items) {
          const body = map.get(item.draft_id);
          if (body === undefined || (await sha256Hex(body)) !== item.body_sha256) throw new Error("The text shown doesn't match what would be signed. Nothing was approved; reload and try again.");
        }
        if (!dead) { setOpt(r); setPhase("confirm"); }
      } catch (e) { if (!dead) { setErr(errText(e)); setPhase("error"); } }
    })();
    return () => { dead = true; };
  }, [batchId, idsKey, attempt]);

  const sign = async () => {
    setPhase("signing"); setErr("");
    try {
      const response = await startAuthentication({ optionsJSON: opt.options });
      const r = await post(`/api/batches/${encodeURIComponent(batchId)}/approve/verify`, { challenge_id: opt.challenge_id, response });
      setResult(r); setPhase("done");
    } catch (e: any) {
      setErr(e?.status ? errText(e) : passkeyError(e)); setPhase("error");
    }
  };

  const m = opt?.manifest;
  const plan = opt?.plan;
  const liveNow = (m?.transport ?? transport) === "live";
  const pinOk = opt ? !!opt.pin_live_allowed : true;
  const badContact = !!m && m.items.some((it: any) => it.create_contact && !contactExact(it.create_contact, it.to));
  // Summary: how many messages and people, which warnings (by type, compact), how many new contacts.
  const summary = useMemo(() => {
    const c: Record<string, number> = {};
    let newContacts = 0;
    for (const x of opt?.drafts ?? []) for (const w of x.warnings ?? []) if (w.code !== "new_contact") c[w.code] = (c[w.code] ?? 0) + 1;
    for (const it of opt?.manifest.items ?? []) if (it.create_contact) newContacts++;
    const people = new Set((opt?.manifest.items ?? []).map((it: any) => it.to)).size;
    return { c, newContacts, people };
  }, [opt]);
  // The manifest in order, consecutive items to one recipient shown together.
  const rows = useMemo(() => {
    const out: { to: string; name: string; items: any[] }[] = [];
    for (const it of opt?.manifest.items ?? []) {
      const r = out[out.length - 1];
      if (r && r.to === it.to) r.items.push(it); else out.push({ to: it.to, name: it.name, items: [it] });
    }
    return out;
  }, [opt]);
  const nPeople = peopleCount(picked);

  return (
    <Sheet open onClose={onClose} title={phase === "done" ? "Approved" : `Approve ${plural(ids.length, "message")}${ids.length ? ` to ${plural(nPeople, "person", "people")}` : ""}`}
      footer={
        phase === "confirm" ? <><button className="btn btn-primary btn-wide" onClick={sign} disabled={badContact}>Approve with Touch ID</button><button className="btn btn-wide" onClick={onClose}>Go back</button></>
        : phase === "signing" ? <button className="btn btn-primary btn-wide" disabled>Waiting for Touch ID…</button>
        : phase === "done" ? <button className="btn btn-primary btn-wide" onClick={() => { onClose(); }}>Done</button>
        : phase === "error" ? <><button className="btn btn-primary btn-wide" onClick={() => setAttempt((a) => a + 1)}>Start again</button><button className="btn btn-wide" onClick={onClose}>Close</button></>
        : phase === "empty" ? <button className="btn btn-wide" onClick={onClose}>Go back</button> : null
      }>
      {phase !== "done" && (
        !opt
          ? liveNow
            ? <div className="live-banner live-banner-off" data-testid="live-banner-pending"><strong>Live transport is on.</strong> Checking what this approval will do…</div>
            : <div className="dry-banner" data-testid="dry-banner">Dry run: nothing will be sent. The sender only logs what it would send.</div>
          : liveNow
            ? pinOk
              ? <div className="live-banner" data-testid="live-banner" role="alert"><strong>LIVE</strong> These messages will really be sent from your number.</div>
              : <div className="live-banner live-banner-off" data-testid="live-banner" role="alert"><strong>Live is on, but the installed pin doesn't allow it.</strong> The sender will not really send these. Fix the pin in Settings.</div>
            : <div className="dry-banner" data-testid="dry-banner">Dry run: nothing will be sent. The sender only logs what it would send.</div>
      )}
      {phase !== "done" && opt && !opt.plan?.enabled && liveNow && pinOk && <p className="small" data-testid="sheet-sends"><strong>Sends right away.</strong> The moment you approve, one message at a time.</p>}
      {phase !== "done" && opt?.plan?.enabled && <PlanNote plan={opt.plan} />}
      {phase === "loading" && <Spinner />}
      {phase === "error" && <ErrorNote>{err}</ErrorNote>}
      {phase === "done" && (
        <div className="success" data-testid="approve-success">
          <div className="check" aria-hidden="true">✓</div>
          <h3>{result.count} message{result.count === 1 ? "" : "s"} approved</h3>
          <p className="muted">{plan?.enabled ? `They go out slowly${plan.latest_finish ? `, over about ${fmtSpan(Date.parse(plan.expected_finish) - Date.now())}` : ""}.` : result.transport === "live" ? "They go out right away." : "Dry run: the sender logs them without sending."}</p>
          <p className="fine">Approval valid until {fmtDateTime(result.not_after)}.</p>
        </div>
      )}

      {phase !== "done" && held.length > 0 && (
        <div className="held" data-testid="held-back">
          <div className="card-row">
            <div>
              <h3 className="mini-title">Include {held.length} with unfilled fields / exact duplicates anyway</h3>
              <p className="small muted">{anyway ? "They are in this approval." : "They are left out unless you turn this on."}</p>
            </div>
            <Switch checked={anyway} onChange={setAnyway} label={`Include ${held.length} with unfilled fields or exact duplicates anyway`} />
          </div>
          <ul className="held-list small">
            {groupDrafts(held).map((g) => (
              <li key={g.key} data-held={g.key}>
                <strong>{g.name || prettyHandle(g.handle)}</strong>{" "}
                {mergedWarnings(g.drafts).filter((w) => HELD.includes(w.code)).map((w) => <Chip key={w.code} tone="bad" title={w.message}>{WARNING_LABEL[w.code] ?? w.code}</Chip>)}
                <div className="muted held-body">{g.drafts.map((d) => d.body).join(" / ")}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {phase === "empty" && <p className="muted">Nothing is selected. Turn on the switch above to include the held-back messages, or go back.</p>}

      {(phase === "confirm" || phase === "signing") && opt && (
        <>
          <div className="summary chips tight" data-testid="sheet-summary">
            <Chip tone="info">{plural(ids.length, "message")}</Chip>
            <Chip tone="info">{plural(summary.people, "person", "people")}</Chip>
            {summary.newContacts > 0 && <Chip tone="info">{plural(summary.newContacts, "new contact")}</Chip>}
            {held.length > 0 && !anyway && <Chip tone="neutral">{held.length} held back</Chip>}
          </div>
          {Object.keys(summary.c).length > 0 && (
            <p className="small muted" data-testid="sheet-warnings">
              {Object.entries(summary.c).map(([code, n]) => `${n} ${WARNING_PHRASE[code] ?? (WARNING_LABEL[code] ?? code).toLowerCase()}`).join(" · ")}
            </p>
          )}
          <p className="muted small">You are signing exactly this list. Check each recipient and message.</p>
          <ol className="manifest" data-testid="manifest-list">
            {rows.map((r) => {
              const infos = r.items.map((it) => info.get(it.draft_id));
              const ws = mergedWarnings(infos.map((x) => ({ warnings: x?.warnings ?? [] })));
              return (
                <li key={r.items[0].draft_id} data-recipient={r.to} data-count={r.items.length}>
                  <Recipient name={r.name} handle={r.to} className="m-head" />
                  <div className="chips tight">
                    {[...new Set(r.items.map((it) => it.service))].map((sv) => <Chip key={sv}>{sv}</Chip>)}
                    {infos.some((x) => x?.number_in_contact === false) && <Chip tone="bad">Number not in contact</Chip>}
                    {ws.map((w, i) => <Chip key={i} tone={warnTone(w.code)} title={w.message}>{WARNING_LABEL[w.code] ?? w.code}</Chip>)}
                  </div>
                  {r.items.map((it) => (
                    <div key={it.draft_id} data-item={it.draft_id}>
                      <blockquote>{bodies.get(it.draft_id)}</blockquote>
                      {it.create_contact && (
                        <div className="small">
                          <Chip tone="info">Adds to Contacts</Chip>
                          <ProposedContactView pc={it.create_contact} handle={it.to} />
                          {!contactExact(it.create_contact, it.to) && <div className="note note-bad" role="alert">This contact's number doesn't match the recipient. Don't approve this.</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>

          <p className="fine">Valid for {plan?.enabled ? fmtWindow(plan.window_hours) : "24 hours"}, until {fmtDateTime(opt.manifest.not_after)}. Edits after this make a message need approval again.</p>
        </>
      )}
    </Sheet>
  );
}
