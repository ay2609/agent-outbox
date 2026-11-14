import { useEffect } from "react";
import { useLoad } from "../hooks";
import { href } from "../router";
import { Chip, Empty, ErrorNote, Spinner, timeAgo } from "../ui";
import { SetCard } from "./ContactChanges";

export function Inbox({ status }: { status: any }) {
  const q = useLoad<{ batches: any[] }>("/api/batches");
  // v4: contact change sets waiting for approval sit above the message batches.
  const cs = useLoad<{ sets: any[] }>("/api/contact-changes?status=review");
  useEffect(() => {
    const f = () => { void q.reload(); void cs.reload(); };
    window.addEventListener("outbox:refresh", f);
    return () => window.removeEventListener("outbox:refresh", f);
  }, [q.reload, cs.reload]);
  const contactSets = cs.data?.sets ?? [];
  const batches = q.data?.batches ?? [];
  // Driven by the draft counts, not batch.status: a batch marked done can still hold drafts that need approving.
  const needs = (b: any) => b.status !== "cancelled" && b.status !== "drafting" && (b.counts.review ?? 0) + (b.counts.draft ?? 0) + (b.counts.failed ?? 0) > 0;
  const review = batches.filter(needs);
  const active = batches.filter((b) => !review.includes(b) && (["approved", "sending"].includes(b.status) || (b.counts.approved ?? 0) + (b.counts.sending ?? 0) > 0 || b.status === "review"));
  const drafting = batches.filter((b) => b.status === "drafting");
  const closed = batches.filter((b) => !review.includes(b) && !active.includes(b) && !drafting.includes(b));

  return (
    <>
      <h1 className="page-title">Inbox</h1>
      <StatusStrip status={status} />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Spinner />}
      {q.data && batches.length === 0 && contactSets.length === 0 && <Empty title="Nothing to review">When a Claude session drafts messages, they show up here. Nothing is ever sent without your approval.</Empty>}
      {(review.length > 0 || contactSets.length > 0) && (
        <Section title="Needs your review">
          {contactSets.map((s) => <SetCard key={s.id} s={s} />)}
          {review.map((b) => <BatchCard key={b.id} b={b} />)}
        </Section>
      )}
      {active.length > 0 && <Section title="Approved and sending">{active.map((b) => <BatchCard key={b.id} b={b} />)}</Section>}
      {drafting.length > 0 && <Section title="Still being drafted">{drafting.map((b) => <BatchCard key={b.id} b={b} />)}</Section>}
      {closed.length > 0 && <Section title="Finished">{closed.slice(0, 20).map((b) => <BatchCard key={b.id} b={b} muted />)}</Section>}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="section"><h2 className="section-title">{title}</h2><div className="stack">{children}</div></section>;
}

function StatusStrip({ status }: { status: any }) {
  if (!status) return null;
  const e = status.exec;
  const pinOk = status.pin?.root?.valid;
  const chips = [
    <Chip key="t" tone={status.transport === "live" ? "warn" : "neutral"}>{status.transport === "live" ? "Live" : "Dry run"}</Chip>,
    <Chip key="e" tone={e?.alive ? "good" : "bad"}>{e ? (e.alive ? `Sender up · ${e.heartbeat_age_s}s` : `Sender silent ${Math.round(e.heartbeat_age_s / 60)} min`) : "Sender not seen"}</Chip>,
    <Chip key="p" tone={pinOk ? "good" : "warn"}>{pinOk ? "Keys pinned" : "Keys not pinned"}</Chip>,
  ];
  return (
    <a className="strip" href={href("settings")} aria-label="Status; open settings">
      {chips}
      <span className="strip-go" aria-hidden="true">›</span>
    </a>
  );
}

function BatchCard({ b, muted }: { b: any; muted?: boolean }) {
  const c = b.counts ?? {};
  const toReview = (c.review ?? 0) + (c.draft ?? 0);
  return (
    <a className={`card card-link ${muted ? "muted-card" : ""}`} href={href("batch", b.id)}>
      <div className="card-row">
        <h3 className="card-title">{b.title}</h3>
        <span className="muted nowrap">{timeAgo(b.created_at)}</span>
      </div>
      <div className="chips">
        {toReview > 0 && <Chip tone="info">{toReview} to review</Chip>}
        {(c.approved ?? 0) + (c.sending ?? 0) > 0 && <Chip tone="good">{(c.approved ?? 0) + (c.sending ?? 0)} approved</Chip>}
        {(c.sent ?? 0) > 0 && <Chip tone="good">{c.sent} sent</Chip>}
        {(c.failed ?? 0) > 0 && <Chip tone="bad">{c.failed} failed</Chip>}
        {(c.unknown ?? 0) > 0 && <Chip tone="warn">{c.unknown} unconfirmed</Chip>}
        {(c.skipped ?? 0) > 0 && <Chip>{c.skipped} skipped</Chip>}
        {b.warnings > 0 && <Chip tone="warn">{b.warnings} warning{b.warnings === 1 ? "" : "s"}</Chip>}
        {b.new_contacts > 0 && <Chip tone="info">{b.new_contacts} new contact{b.new_contacts === 1 ? "" : "s"}</Chip>}
        {b.status === "cancelled" && <Chip>cancelled</Chip>}
      </div>
      <div className="muted small">{b.total} message{b.total === 1 ? "" : "s"} · from {b.created_by.replace(/^agent:/, "")}</div>
    </a>
  );
}
