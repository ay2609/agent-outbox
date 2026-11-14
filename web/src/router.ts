import { useEffect, useState } from "react";

/** Hash routing: "#/batch/abc" -> ["batch", "abc"]. */
export function parseHash(h: string = location.hash): string[] {
  return h.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
}
export function useRoute(): string[] {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const f = () => { setR(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}
export const href = (...parts: string[]): string => "#/" + parts.map(encodeURIComponent).join("/");
export const navigate = (...parts: string[]): void => { location.hash = href(...parts); };
