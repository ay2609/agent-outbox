import { useCallback, useEffect, useRef, useState } from "react";
import { get, errText } from "./api";

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void>; set: (f: (d: T) => T) => void }

/** Loads a GET endpoint; optional polling. Keeps the last data while reloading. */
export function useLoad<T = any>(path: string | null, opts: { poll?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    if (!path) return;
    try { const d = await get<T>(path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError(errText(e)); }
    finally { if (alive.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setData(null); setLoading(!!path); void reload(); }, [path, reload]);
  useEffect(() => {
    if (!opts.poll || !path) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, opts.poll);
    return () => clearInterval(id);
  }, [opts.poll, path, reload]);
  return { data, error, loading, reload, set: (f) => setData((d) => (d ? f(d) : d)) };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
