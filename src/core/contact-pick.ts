import type { Contact } from "./types";

const cleanLabel = (l: string): string => l.replace(/_\$!<(.*?)>!\$_/g, "$1").trim();
const isMobileLabel = (l: string): boolean => /mobile|iphone|cell/i.test(cleanLabel(l));
const isFaxLabel = (l: string): boolean => /fax|pager/i.test(cleanLabel(l));

/** The handle to message for a contact: first mobile / iPhone / cell phone, else first phone (never a fax or pager), else first email. */
export function pickHandle(c: Pick<Contact, "phones" | "emails">): { handle: string; kind: "phone" | "email" } | null {
  const phones = c.phones.filter((p) => p.e164 && !isFaxLabel(p.label ?? ""));
  const mobile = phones.find((p) => isMobileLabel(p.label ?? ""));
  if (mobile) return { handle: mobile.e164, kind: "phone" };
  if (phones[0]) return { handle: phones[0].e164, kind: "phone" };
  const email = c.emails.find((e) => e.email);
  if (email) return { handle: email.email.toLowerCase(), kind: "email" };
  return null;
}
