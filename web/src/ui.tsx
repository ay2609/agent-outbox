import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export function Chip({ tone = "neutral", children, title }: { tone?: "neutral" | "good" | "warn" | "bad" | "info"; children: ReactNode; title?: string }) {
  return <span className={`chip chip-${tone}`} title={title}>{children}</span>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head"><h2>{title}</h2><button className="btn-text" onClick={onClose} aria-label="Close">Close</button></div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) { return <div className="spinner" role="status" aria-label={label} />; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
export function ErrorNote({ children }: { children: ReactNode }) { return <div className="note note-bad" role="alert">{children}</div>; }

// ---------- toast ----------
export interface ToastOpts { action?: { label: string; onClick: () => void }; ms?: number }
const ToastCtx = createContext<(msg: string, tone?: "good" | "bad", opts?: ToastOpts) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; tone: string; n: number; opts: ToastOpts } | null>(null);
  const n = useRef(0);
  const show = useCallback((msg: string, tone: "good" | "bad" = "good", opts: ToastOpts = {}) => { setT({ msg, tone, n: ++n.current, opts }); }, []);
  useEffect(() => { if (!t) return; const id = setTimeout(() => setT(null), t.opts.ms ?? 3200); return () => clearTimeout(id); }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast toast-${t.tone}`} role="status" data-testid="toast">
          <span>{t.msg}</span>
          {t.opts.action && <button className="toast-action" onClick={() => { const f = t.opts.action!.onClick; setT(null); f(); }}>{t.opts.action.label}</button>}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ---------- formatting ----------
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const fmtDateTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "+15551234567" -> "+1 (555) 123-4567"; anything else unchanged. */
export function prettyHandle(h: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(h);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : h;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

/** "Tue 9:02 AM" in the browser's time zone. */
export const fmtShort = (iso: string | Date): string => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
