import { useEffect, useRef, useState } from "react";
import { errText, get, post, put } from "../api";
import { useDebounced, useLoad } from "../hooks";
import { href, navigate } from "../router";
import { Chip, Empty, ErrorNote, Spinner, prettyHandle, timeAgo, useToast } from "../ui";
import { SaveRowsAsGroup } from "./Groups";

/** Country the phone numbers without a "+" are read in. */
const REGIONS: [string, string][] = [["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["IE", "Ireland"], ["AU", "Australia"], ["NZ", "New Zealand"], ["IN", "India"],
  ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["MX", "Mexico"], ["BR", "Brazil"], ["JP", "Japan"], ["CN", "China"], ["SG", "Singapore"], ["AE", "UAE"], ["ZA", "South Africa"]];
function useRegion(): [string, (r: string) => void] {
  const [r, setR] = useState(() => localStorage.getItem("outbox:region") || "US");
  return [r, (v: string) => { localStorage.setItem("outbox:region", v); setR(v); }];
}
function RegionSelect({ value, onChange }: { value: string; onChange: (r: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Phone region" data-testid="region-select">
      {REGIONS.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
    </select>
  );
}

export function Imports({ id }: { id?: string }) {
  return id ? <ImportDetail id={id} /> : <ImportList />;
}

function ImportList() {
  const list = useLoad<{ imports: any[] }>("/api/imports");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [region, setRegion] = useRegion();
  const file = useRef<HTMLInputElement>(null);

  const upload = async (f: File) => {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", f); fd.append("region", region);
      const r = await post("/api/imports", fd);
      navigate("imports", r.import_id);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const sendPaste = async () => {
    setBusy(true); setErr(null);
    try { const r = await post("/api/imports", { text: paste, filename: "pasted.csv", region }); navigate("imports", r.import_id); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <h1 className="page-title">Imports</h1>
      <p className="muted">Upload a spreadsheet or contact file (CSV, Excel, Numbers, vCard, JSON). You confirm how the columns map, then write one message template that personalises for each row.</p>
      <label className="field"><span>Phone region (for numbers written without a country code)</span><RegionSelect value={region} onChange={setRegion} /></label>
      <input ref={file} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.xls,.ods,.numbers,.vcf,.json,.jsonl" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      <button className="btn btn-primary btn-wide" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Reading…" : "Choose a file"}</button>
      <details className="details">
        <summary>Or paste a table</summary>
        <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"name,phone\nSam Lee,555 123 4567"} />
        <button className="btn" disabled={busy || !paste.trim()} onClick={sendPaste}>Read pasted table</button>
      </details>
      {err && <ErrorNote>{err}</ErrorNote>}
      <section className="section">
        <h2 className="section-title">Earlier imports</h2>
        {list.loading && !list.data && <Spinner />}
        {list.data && list.data.imports.length === 0 && <Empty title="No imports yet" />}
        <div className="stack">
          {list.data?.imports.map((i) => (
            <a key={i.id} className="card card-link" href={href("imports", i.id)}>
              <div className="card-row"><strong>{i.filename}</strong><span className="muted small">{timeAgo(i.created_at)}</span></div>
              <div className="chips tight"><Chip>{i.row_count} rows</Chip><Chip>{i.kind}</Chip>{i.sheet && <Chip>sheet: {i.sheet}</Chip>}{!i.confirmed && <Chip tone="warn">mapping to confirm</Chip>}</div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

const FIELDS: { key: string; label: string }[] = [
  { key: "display_name", label: "Full name" }, { key: "given_name", label: "First name" }, { key: "family_name", label: "Last name" },
  { key: "phone", label: "Phone" }, { key: "email", label: "Email" }, { key: "org", label: "Company" }, { key: "notes", label: "Notes" }, { key: "tags", label: "Tags" },
];
const STD_VARS = ["first_name", "last_name", "full_name", "name", "org"];

function ImportDetail({ id }: { id: string }) {
  const q = useLoad<any>(`/api/imports/${encodeURIComponent(id)}`);
  const toast = useToast();
  const [fields, setFields] = useState<Record<string, { column: string; confidence: number }>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [template, setTemplate] = useState("Hi {{first_name|there}}, ");
  const [title, setTitle] = useState("");
  const [createNew, setCreateNew] = useState(true);
  const [previews, setPreviews] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const dTemplate = useDebounced(template, 350);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [region, setRegion] = useRegion();
  const [matchFilter, setMatchFilter] = useState<string>("");
  const [rows, setRows] = useState<any[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [reading, setReading] = useState(false);

  const imp = q.data;
  // The region this import was read with (when the ingest library records it) wins over the remembered default.
  useEffect(() => { const r = imp?.mapping?.region; if (r && REGIONS.some(([c]) => c === r)) setRegion(r); }, [imp?.import_id]);
  useEffect(() => { if (imp && !dirty) { setFields(imp.mapping?.fields ?? {}); if (!title) setTitle(`Message to ${String(imp.filename).replace(/\.[^.]+$/, "")}`); } }, [imp]);

  const confirmed = !!imp?.mapping?.confirmed && !dirty;
  useEffect(() => {
    if (!imp || !confirmed || !dTemplate.trim()) { setPreviews([]); return; }
    let dead = false;
    post(`/api/imports/${encodeURIComponent(id)}/preview`, { template: dTemplate, rows: 3 })
      .then((r) => { if (!dead) setPreviews(r.previews); }).catch((e) => { if (!dead) setErr(errText(e)); });
    return () => { dead = true; };
  }, [dTemplate, confirmed, id, imp?.import_id]);

  const loadRows = async (offset: number) => {
    setRowsBusy(true);
    try {
      const r = await get<any>(`/api/imports/${encodeURIComponent(id)}?limit=25&offset=${offset}${matchFilter ? `&match=${encodeURIComponent(matchFilter)}` : ""}`);
      setRows((cur) => (offset === 0 ? r.rows : [...cur, ...r.rows])); setRowsTotal(r.rows_total);
    } catch (e) { setErr(errText(e)); } finally { setRowsBusy(false); }
  };
  const countsKey = JSON.stringify(imp?.counts ?? {}) + String(imp?.mapping?.confirmed);
  useEffect(() => { if (imp) void loadRows(0); }, [id, matchFilter, countsKey]);

  if (q.loading && !imp) return <Spinner />;
  if (q.error && !imp) return <><a className="back" href={href("imports")}>‹ Imports</a><ErrorNote>{q.error}</ErrorNote></>;

  const columns: string[] = imp.columns ?? [];
  const counts = imp.counts ?? {};
  const mappedCols = new Set(Object.values(fields).map((f) => f.column));
  const extraVars = Object.keys(imp.mapping?.vars ?? {});
  const slugs = extraVars.length ? extraVars : columns.filter((c) => !mappedCols.has(c)).map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));

  const setField = (key: string, column: string) => {
    setDirty(true);
    setFields((f) => { const n = { ...f }; if (!column) delete n[key]; else n[key] = { column, confidence: 1 }; return n; });
  };
  const confirm = async () => {
    setSaving(true); setErr(null);
    try {
      const vars = imp.mapping?.vars ?? {};
      await put(`/api/imports/${encodeURIComponent(id)}/mapping`, { fields, vars, confirmed: true, region });
      setDirty(false); await q.reload(); toast("Mapping saved.");
    } catch (e) { setErr(errText(e)); } finally { setSaving(false); }
  };
  /** A different sheet or phone region means re-reading the stored file: that makes a new import, and we move to it. */
  const reread = async (over: { sheet?: string; region?: string }) => {
    setReading(true); setErr(null);
    try {
      const r = await post(`/api/imports/${encodeURIComponent(id)}/reingest`, { sheet: over.sheet ?? imp.sheet ?? undefined, region: over.region ?? region });
      toast("File read again as a new import.");
      navigate("imports", r.import_id);
    } catch (e) { setErr(errText(e)); } finally { setReading(false); }
  };
  const insert = (v: string) => {
    const el = ta.current; const tok = `{{${v}}}`;
    if (!el) { setTemplate((t) => t + tok); return; }
    const a = el.selectionStart ?? template.length, b = el.selectionEnd ?? template.length;
    setTemplate(template.slice(0, a) + tok + template.slice(b));
    setTimeout(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length); }, 0);
  };
  const create = async () => {
    setCreating(true); setErr(null);
    try {
      const r = await post(`/api/imports/${encodeURIComponent(id)}/batch`, { title: title.trim() || "Imported messages", template, create_new_contacts: createNew });
      toast(`${r.drafts} draft${r.drafts === 1 ? "" : "s"} created${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}.`);
      navigate("batch", r.batch_id);
    } catch (e) { setErr(errText(e)); } finally { setCreating(false); }
  };

  return (
    <>
      <a className="back" href={href("imports")}>‹ Imports</a>
      <h1 className="page-title">{imp.filename}</h1>
      <div className="chips tight"><Chip>{imp.kind}</Chip>{imp.sheet && <Chip>sheet: {imp.sheet}</Chip>}<Chip>{columns.length} columns</Chip>
        {confirmed ? <Chip tone="good">mapping confirmed</Chip> : <Chip tone="warn">confirm the mapping</Chip>}</div>
      <p className="fine mono" data-testid="import-route">#/imports/{id}</p>
      {(imp.sheets?.length ?? 0) > 1 && (
        <label className="field"><span>Sheet</span>
          <select value={imp.sheet ?? imp.sheets[0]} disabled={reading} onChange={(e) => void reread({ sheet: e.target.value })} aria-label="Sheet" data-testid="sheet-select">
            {imp.sheets.map((sh: string) => <option key={sh} value={sh}>{sh}</option>)}
          </select></label>
      )}
      <div className="field"><span>Phone region</span>
        <div className="row-gap"><RegionSelect value={region} onChange={setRegion} />
          <button className="btn btn-small" disabled={reading} onClick={() => void reread({ region })} data-testid="reread">{reading ? "Reading…" : "Re-read with this region"}</button></div>
        <span className="fine">Numbers without a "+" are read as this country's. Re-reading makes a new import from the same file.</span></div>
      {(imp.warnings ?? []).length > 0 && <ul className="warn-list small">{imp.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}

      <section className="section">
        <h2 className="section-title">1. Columns</h2>
        <div className="card">
          {FIELDS.map((f) => {
            const m = fields[f.key];
            return (
              <label key={f.key} className="map-row">
                <span className="map-label">{f.label}</span>
                <select value={m?.column ?? ""} onChange={(e) => setField(f.key, e.target.value)} aria-label={`Column for ${f.label}`}>
                  <option value="">Not used</option>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {m && <Chip tone={m.confidence >= 0.8 ? "good" : "warn"} title="How sure the match is">{Math.round(m.confidence * 100)}%</Chip>}
              </label>
            );
          })}
          <button className="btn btn-primary btn-wide" disabled={saving || !(dirty || !imp.mapping?.confirmed)} onClick={confirm}>{saving ? "Saving…" : "Confirm mapping"}</button>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">2. What matched</h2>
        <div className="chips" role="group" aria-label="Filter rows">
          {([["", "All", imp.row_count ?? Object.values(counts).reduce((x: number, y: any) => x + (y as number), 0), "neutral"], ["matched", "matched", counts.matched ?? 0, "good"], ["new", "new", counts.new ?? 0, "info"],
            ["ambiguous", "ambiguous", counts.ambiguous ?? 0, (counts.ambiguous ?? 0) > 0 ? "warn" : "neutral"], ["invalid", "invalid", counts.invalid ?? 0, (counts.invalid ?? 0) > 0 ? "bad" : "neutral"],
            ["duplicate", "duplicate", counts.duplicate ?? 0, "neutral"]] as [string, string, number, string][]).map(([k, label, n, tone]) => (
            <button key={k || "all"} className={`chip chip-${tone} chip-btn ${matchFilter === k ? "chip-on" : ""}`} aria-pressed={matchFilter === k} onClick={() => setMatchFilter(k)} data-match={k || "all"}>{n} {label}</button>
          ))}
        </div>
        <div className="stack" data-testid="import-rows">
          {rows.map((r) => {
            const n = r.normalized ?? r;
            return (
              <div key={r.row_index} className="card small" data-row={r.row_index}>
                <div className="card-row"><strong>{n.display_name || [n.given_name, n.family_name].filter(Boolean).join(" ") || "(no name)"}</strong>{r.match && <Chip tone={r.match === "matched" ? "good" : r.match === "new" ? "info" : r.match === "invalid" ? "bad" : "warn"}>{r.match}</Chip>}</div>
                <div>{n.phone_e164 ? prettyHandle(n.phone_e164) : n.email ?? <span className="muted">no phone or email</span>} <span className="muted">· row {r.row_index + 1}</span></div>
                {(r.issues ?? []).length > 0 && <ul className="warn-list">{r.issues.map((i: any, k: number) => <li key={k}>{i.message}</li>)}</ul>}
              </div>
            );
          })}
          {rows.length === 0 && !rowsBusy && <p className="muted small">No rows{matchFilter ? ` marked ${matchFilter}` : ""}.</p>}
          {rows.length < rowsTotal && <button className="btn btn-small btn-wide" disabled={rowsBusy} onClick={() => void loadRows(rows.length)}>{rowsBusy ? "Loading…" : `Show more (${rows.length} of ${rowsTotal})`}</button>}
        </div>
      </section>

      {confirmed && <SaveRowsAsGroup importId={id} filename={imp.filename} />}

      <section className="section">
        <h2 className="section-title">3. Message</h2>
        <label className="field"><span>Template</span>
          <textarea ref={ta} rows={5} value={template} onChange={(e) => setTemplate(e.target.value)} disabled={!confirmed} placeholder="Hi {{first_name|there}}, …" /></label>
        <div className="chips">
          {[...STD_VARS, ...slugs].map((v) => <button key={v} className="chip chip-btn" disabled={!confirmed} onClick={() => insert(v)}>{`{{${v}}}`}</button>)}
        </div>
        <p className="fine">Use {"{{first_name|there}}"} to fall back to "there" when a name is empty.</p>
        {confirmed && previews.length > 0 && (
          <div className="stack">
            <h3 className="mini-title">Preview (3 rows)</h3>
            {previews.map((p, i) => (
              <div key={i} className="card preview">
                <div className="muted small">{p.name || "(no name)"} · {p.to ? prettyHandle(p.to) : ""}</div>
                <div className="preview-body">{p.body}</div>
                {(p.unresolved?.length > 0 || p.empty?.length > 0) && <div className="chips tight">{p.unresolved?.map((u: string) => <Chip key={u} tone="warn">unknown {u}</Chip>)}{p.empty?.map((u: string) => <Chip key={u} tone="warn">empty {u}</Chip>)}</div>}
              </div>
            ))}
          </div>
        )}
        <label className="field"><span>Batch title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
        <label className="inline-row"><input type="checkbox" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} /><span>Offer to add new numbers to Contacts</span></label>
        {err && <ErrorNote>{err}</ErrorNote>}
        <button className="btn btn-primary btn-wide" disabled={!confirmed || creating || !template.trim()} onClick={create}>{creating ? "Creating…" : "Create batch for review"}</button>
      </section>
    </>
  );
}
