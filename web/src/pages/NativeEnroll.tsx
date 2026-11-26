import { useState } from "react";
import { ApiErr, errText, post } from "../api";
import { useLoad } from "../hooks";
import { passkeyError, reauth } from "../passkeys";
import { ErrorNote, Spinner } from "../ui";

/** Opened by Agent Outbox.app (#/native-enroll/<key_id>) when it can't prove who the owner is by itself: shows the new Touch ID key's
 *  name and fingerprint and activates it after a fresh SIGN-IN passkey confirmation (approval keys can't confirm this). */
export function NativeEnroll({ id }: { id: string }) {
  const q = useLoad<{ status: string; label: string; fingerprint: string }>(`/api/native-keys/enroll/${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      await post(`/api/native-keys/enroll/${encodeURIComponent(id)}/confirm`, { reauth: await reauth() });
      setDone(true); await q.reload();
    } catch (e) { setErr(e instanceof ApiErr ? errText(e) : passkeyError(e)); } finally { setBusy(false); }
  };

  if (q.loading && !q.data) return <Spinner />;
  if (q.error || !q.data) return <><h1 className="page-title">Touch ID in the app</h1><ErrorNote>{q.error ?? "That setup is unknown or expired. Start again in the Agent Outbox app."}</ErrorNote></>;
  const s = q.data;
  return (
    <>
      <h1 className="page-title">Set up Touch ID in the app</h1>
      {s.status === "active" || done
        ? <p className="note note-good">Done. Agent Outbox on this Mac can now ask for Touch ID approvals. You can close this tab.</p>
        : s.status !== "pending"
          ? <ErrorNote>This setup is {s.status}. Start again in the Agent Outbox app.</ErrorNote>
          : <>
              <p className="muted">The app wants to add an approval key for <strong>{s.label}</strong>. Check that the fingerprint below is the one the app shows, then confirm with your sign-in passkey.</p>
              <p><code data-testid="native-fingerprint">{s.fingerprint}</code></p>
              <button className="btn btn-primary" disabled={busy} onClick={confirm}>{busy ? "Waiting for Touch ID…" : "Confirm with sign-in passkey"}</button>
              {err && <ErrorNote>{err}</ErrorNote>}
            </>}
    </>
  );
}
