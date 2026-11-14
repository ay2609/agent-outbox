import { useEffect, useRef, useState } from "react";
import { errText, get, post } from "../api";
import { useDebounced, useLoad } from "../hooks";
import { href } from "../router";
import { Chip, ErrorNote, Spinner, prettyHandle } from "../ui";

/** Shown instead of the form when the claude command isn't available (or compose is "off" in config.json). */
export function ComposeOff({ reason }: { reason?: string | null }) {
  return (
    <>
      <h1 className="page-title">Ask Claude</h1>
      <div className="note note-info" data-testid="compose-off">
        {reason === "off"
          ? <>Ask Claude is turned off (<span className="mono">"compose": "off"</span> in <span className="mono">config.json</span>). Agents can still draft into the outbox through the MCP server or the <span className="mono">outbox</span> command.</>
          : <>Ask Claude needs the <span className="mono">claude</span> command (Claude Code), and it wasn't found. Install it, or set <span className="mono">"claude_path"</span> in <span className="mono">config.json</span>. Agents can still draft into the outbox through the MCP server or the <span className="mono">outbox</span> command.</>}
      </div>
    </>
  );
}

export function Compose() {
  const [instructions, setInstructions] = useState("");
  const [title, setTitle] = useState("");
  const [tag, setTag] = useState("");
  const [importId, setImportId] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const imports = useLoad<{ imports: any[] }>("/api/imports");
  const found = useLoad<{ contacts: any[] }>(dq.trim() ? `/api/contacts?q=${encodeURIComponent(dq.trim())}&limit=8` : null);
  const [job, setJob] = useState<any>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const tick = async () => {
      try {
        const j = await get(`/api/compose/${encodeURIComponent(jobId)}`);
        setJob(j);
        if (["done", "finished", "failed", "error", "completed", "succeeded"].includes(String(j.status))) { if (timer.current) clearInterval(timer.current); timer.current = null; }
      } catch (e) { setErr(errText(e)); if (timer.current) clearInterval(timer.current); }
    };
    void tick();
    timer.current = setInterval(tick, 2000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [jobId]);

  const start = async () => {
    setBusy(true); setErr(null); setJob(null);
    try {
      const r = await post("/api/compose", {
        instructions, ...(title.trim() ? { title: title.trim() } : {}), ...(tag.trim() ? { tag: tag.trim() } : {}),
        ...(importId ? { import_id: importId } : {}), ...(picked.length ? { contact_ids: picked.map((p) => p.id) } : {}),
      });
      setJobId(r.job_id);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  const running = !!jobId && !["done", "finished", "failed", "error", "completed", "succeeded"].includes(String(job?.status));
  const batchIds: string[] = job?.batch_ids ?? [];
  return (
    <>
      <h1 className="page-title">Ask Claude</h1>
      <p className="muted">Describe the messages. A Claude session drafts them into a batch for your review. Nothing is sent.</p>
      <label className="field"><span>What should the messages say?</span>
        <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Ask each person if they can make Saturday's dinner. Keep it casual, mention the new address for anyone tagged 'neighbors'." /></label>
      <label className="field"><span>Batch title (optional)</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>

      <div className="field">
        <span>Recipients</span>
        <input placeholder="Search contacts to add" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
        {found.data && dq.trim() && (
          <ul className="pick-list">
            {found.data.contacts.length === 0 && <li className="muted">No matches.</li>}
            {found.data.contacts.map((c) => (
              <li key={c.id}><button className="pick" disabled={picked.some((p) => p.id === c.id)} onClick={() => { setPicked((p) => [...p, { id: c.id, name: c.display_name || prettyHandle(c.phones?.[0]?.e164 ?? "") }]); setQ(""); }}>
                <span>{c.display_name || "(no name)"}</span><span className="muted small">{c.phones?.[0]?.e164 ? prettyHandle(c.phones[0].e164) : c.emails?.[0]?.email ?? ""}</span>
              </button></li>
            ))}
          </ul>
        )}
        {picked.length > 0 && <div className="chips">{picked.map((p) => <button key={p.id} className="chip chip-info chip-btn" onClick={() => setPicked((x) => x.filter((y) => y.id !== p.id))} aria-label={`Remove ${p.name}`}>{p.name} ✕</button>)}</div>}
      </div>
      <label className="field"><span>Or everyone with a tag</span><input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={100} placeholder="e.g. neighbors" /></label>
      <label className="field"><span>Or the rows of an import</span>
        <select value={importId} onChange={(e) => setImportId(e.target.value)}>
          <option value="">None</option>
          {(imports.data?.imports ?? []).map((i) => <option key={i.id} value={i.id}>{i.filename} · {i.row_count} rows</option>)}
        </select></label>

      <button className="btn btn-primary btn-wide" disabled={busy || running || !instructions.trim()} onClick={start}>{running ? "Drafting…" : "Draft messages"}</button>
      {err && <ErrorNote>{err}</ErrorNote>}
      {jobId && (
        <div className="card">
          <div className="card-row"><strong>Draft job</strong><Chip tone={job?.status === "failed" || job?.status === "error" ? "bad" : running ? "info" : "good"}>{job?.status ?? "starting"}</Chip></div>
          {running && <Spinner label="Drafting" />}
          {batchIds.map((b) => <p key={b}><a className="btn btn-small" href={href("batch", b)}>Review the batch</a></p>)}
          {job?.status === "done" && batchIds.length === 0 && <p className="muted small">The session finished without creating a batch.</p>}
          {job?.error && <ErrorNote>{String(job.error)}</ErrorNote>}
          {job?.result_text && <pre className="pre small">{String(job.result_text).split("\n").slice(-12).join("\n")}</pre>}
        </div>
      )}
    </>
  );
}
