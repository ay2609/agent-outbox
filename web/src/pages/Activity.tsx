import { useState } from "react";
import { get, errText } from "../api";
import { useLoad } from "../hooks";
import { Chip, Empty, ErrorNote, Spinner, fmtDateTime, prettyHandle } from "../ui";

export function Activity() {
  const [tab, setTab] = useState<"sends" | "audit">("sends");
  const q = useLoad<any>("/api/activity?limit=40", { poll: 15000 });
  const [more, setMore] = useState<{ sends: any[]; audit: any[] }>({ sends: [], audit: [] });
  const [next, setNext] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const cursor = next ?? q.data?.next;
  const sends = [...(q.data?.sends ?? []), ...more.sends];
  const audit = [...(q.data?.audit ?? []), ...more.audit];
  const loadMore = async () => {
    try {
      const p = new URLSearchParams({ limit: "40" });
      if (tab === "sends" && cursor?.sends_before) p.set("sends_before", cursor.sends_before);
      if (tab === "audit" && cursor?.audit_before) p.set("audit_before", String(cursor.audit_before));
      const r = await get(`/api/activity?${p}`);
      setMore((m) => ({ sends: tab === "sends" ? [...m.sends, ...r.sends] : m.sends, audit: tab === "audit" ? [...m.audit, ...r.audit] : m.audit }));
      setNext((n: any) => ({ ...(n ?? q.data?.next), ...(tab === "sends" ? { sends_before: r.next.sends_before } : { audit_before: r.next.audit_before }) }));
    } catch (e) { setErr(errText(e)); }
  };
  const canMore = tab === "sends" ? !!cursor?.sends_before : !!cursor?.audit_before;
  return (
    <>
      <h1 className="page-title">Activity</h1>
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "sends"} className={tab === "sends" ? "on" : ""} onClick={() => setTab("sends")}>Sends</button>
        <button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>Audit log</button>
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}{err && <ErrorNote>{err}</ErrorNote>}
      {q.loading && !q.data && <Spinner />}
      {tab === "sends" && q.data && sends.length === 0 && <Empty title="No sends yet">Each attempt by the sender shows up here, including dry runs.</Empty>}
      {tab === "sends" && (
        <div className="stack">
          {sends.map((s) => (
            <div key={s.id} className="card">
              <div className="card-row"><strong>{s.recipient_name || prettyHandle(s.handle)}</strong>
                <Chip tone={s.result === "sent" ? "good" : s.result === "failed" ? "bad" : s.result === "unknown" ? "warn" : "info"}>{s.result ?? "sending"}</Chip></div>
              <div className="small">{s.preview}</div>
              <div className="muted small">{s.transport} · attempt {s.attempt} · {fmtDateTime(s.started_at)}{s.error ? ` · ${s.error}` : ""}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "audit" && (
        <div className="stack">
          {audit.map((a) => (
            <div key={a.id} className="card small">
              <div className="card-row"><strong>{a.action}</strong><span className="muted">{a.actor}</span></div>
              <div className="muted">{fmtDateTime(a.at)}{a.target ? ` · ${String(a.target).slice(0, 24)}` : ""}</div>
              {a.details && Object.keys(a.details).length > 0 && <div className="mono muted">{JSON.stringify(a.details).slice(0, 160)}</div>}
            </div>
          ))}
        </div>
      )}
      {canMore && <button className="btn btn-wide" onClick={loadMore}>Load more</button>}
    </>
  );
}
