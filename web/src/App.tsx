import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiErr, get, post, errText } from "./api";
import { useLoad } from "./hooks";
import { login, passkeyError, registerApprove, registerLogin } from "./passkeys";
import { href, useRoute } from "./router";
import { ErrorNote, Sheet, Spinner, ToastHost, useToast } from "./ui";
import { Controls } from "./controls";
import { Inbox } from "./pages/Inbox";
import { BatchPage } from "./pages/Batch";
import { Compose, ComposeOff } from "./pages/Compose";
import { Imports } from "./pages/Imports";
import { Contacts } from "./pages/Contacts";
import { ContactChangeDetail, ContactChangesList } from "./pages/ContactChanges";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";

interface AuthState { registered: boolean; authenticated: boolean; setup: { login: boolean; approve: boolean }; rp_id: string; origin: string }

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(() => sessionStorage.getItem("outbox:skip-setup") === "1");
  const refresh = () => get<AuthState>("/api/auth/state").then(setAuth).catch((e) => setErr(errText(e)));
  useEffect(() => { void refresh(); }, []);
  if (err) return <div className="gate"><ErrorNote>{err}</ErrorNote><button className="btn" onClick={() => location.reload()}>Retry</button></div>;
  if (!auth) return <div className="gate"><Spinner /></div>;
  const needApprove = auth.authenticated && !auth.setup.approve && !skipped;
  return (
    <ToastHost>
      {!auth.authenticated ? <Gate key={auth.registered ? "signin" : "1"} auth={auth} step={auth.registered ? "signin" : 1} onDone={refresh} />
        : needApprove ? <Gate key="2" auth={auth} step={2} onDone={refresh} onSkip={() => { sessionStorage.setItem("outbox:skip-setup", "1"); setSkipped(true); }} />
        : <Shell setup={auth.setup} />}
    </ToastHost>
  );
}

const WHY_TWO = "Two keys, so the Touch ID sheet says \"APPROVE SENDING\" only when you are approving a send, never when you are just signing in.";

function Gate({ auth, step, onDone, onSkip }: { auth: AuthState; step: 1 | 2 | "signin"; onDone: () => void; onSkip?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const device = "This Mac";
  const [label, setLabel] = useState(step === 2 ? `${device} approval` : `${device} sign-in`);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await f(); onDone(); } catch (e) { setErr(e instanceof ApiErr ? errText(e) : passkeyError(e)); } finally { setBusy(false); }
  };
  return (
    <main className="gate">
      <img src="/icon-192.png" width={72} height={72} alt="" className="gate-icon" />
      <h1>Agent Outbox</h1>
      {step === "signin" ? (
        <>
          <p className="muted">Sign in with your sign-in passkey.</p>
          <button className="btn btn-primary btn-wide" disabled={busy} onClick={() => run(login)}>{busy ? "Waiting for Touch ID…" : "Sign in with passkey"}</button>
        </>
      ) : (
        <>
          <ol className="steps" aria-label="Setup progress">
            <li className={step === 1 ? "on" : "done"}><span>1</span> Sign-in key</li>
            <li className={step === 2 ? "on" : ""}><span>2</span> Approval key</li>
          </ol>
          {step === 1 ? (
            <>
              <p className="muted">Step 1 of 2. Create the key that signs you in to this dashboard. It is stored on this Mac and protected by Touch ID.</p>
              <p className="fine">No Touch ID on this Mac? Your Mac password or a passkey on your phone works the same way.</p>
            </>
          ) : (
            <p className="muted">Step 2 of 2. Create the key that approves sending. Every approval is signed with it, and the sender only trusts this key.</p>
          )}
          <p className="note note-info small">{WHY_TWO}</p>
          <label className="field"><span>Name this key</span><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></label>
          <button className="btn btn-primary btn-wide" disabled={busy}
            onClick={() => run(() => (step === 1 ? registerLogin(label) : registerApprove(label)))}>
            {busy ? "Waiting for Touch ID…" : step === 1 ? "Create sign-in key" : "Create approval key"}
          </button>
          {step === 2 && onSkip && <button className="btn-text" onClick={onSkip}>Later (nothing can be approved until you do)</button>}
          <p className="fine">{step === 1 ? "Next you will create the approval key." : "After this you are in. Settings has an optional one-command step to harden the install."}</p>
        </>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
    </main>
  );
}

const TABS: { key: string; label: string; icon: ReactNode }[] = [
  { key: "", label: "Inbox", icon: <path d="M4 13l2.2-7a2 2 0 0 1 1.9-1.4h7.8A2 2 0 0 1 17.8 6L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5zm0 0h4.5a1.5 1.5 0 0 0 1.5 1.5h4a1.5 1.5 0 0 0 1.5-1.5H20" /> },
  { key: "compose", label: "Ask Claude", icon: <path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1zM14 7l3 3" /> },
  { key: "imports", label: "Imports", icon: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /> },
  { key: "contacts", label: "Contacts", icon: <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 6 17.5V19M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 8v5m2.5-2.5h-5" /> },
  { key: "activity", label: "Activity", icon: <path d="M4 12h3l2.5-6 4 12 2.5-6H20" /> },
  { key: "settings", label: "Settings", icon: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /> },
];

function Shell({ setup }: { setup: { login: boolean; approve: boolean } }) {
  const route = useRoute();
  const status = useLoad<any>("/api/status", { poll: 8000 });
  const toast = useToast();
  const [stopSheet, setStopSheet] = useState(false);
  const [resumeSheet, setResumeSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const killed = !!status.data?.kill_switch;
  const reason: string = status.data?.kill_reason ?? "";
  const section = route[0] ?? "";
  // "Ask Claude" needs the claude command; until the status has loaded the tab stays, afterwards it follows compose.enabled.
  const composeOn = status.data?.compose?.enabled !== false;
  const simple = status.data?.pin?.mode === "simple";
  const refreshAll = async () => { await status.reload(); window.dispatchEvent(new Event("outbox:refresh")); };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await post("/api/stop");
      setStopSheet(false);
      // Message approvals and (v4) contacts approvals are both cancelled by a stop.
      const n = (r.revoked_approvals ?? 0) + (r.revoked_contact_approvals ?? 0);
      const held = r.held_contact_creates ?? 0; // queued new contacts that were waiting to be added automatically
      const msg = (n ? `Stopped. ${n} approval${n === 1 ? "" : "s"} cancelled.` : "Stopped. Nothing will send.")
        + (held ? ` ${held} new contact${held === 1 ? "" : "s"} waiting to be added now need${held === 1 ? "s" : ""} your approval.` : "");
      // 10 seconds to change your mind: undo restores exactly the approvals this stop revoked.
      toast(msg, "good", {
        ms: 10_000,
        action: { label: "Undo", onClick: async () => {
          try {
            const u = await post("/api/stop/undo", { stop_id: r.stop_id });
            const back = (u.restored_approvals ?? 0) + (u.restored_contact_approvals ?? 0);
            toast(back ? `Stop undone. ${back} approval${back === 1 ? "" : "s"} restored.` : "Stop undone."); await refreshAll();
          }
          catch (e) { toast(errText(e), "bad"); }
        } },
      });
      await refreshAll();
    } catch (e) { toast(errText(e), "bad"); setStopSheet(false); } finally { setBusy(false); }
  };
  const resume = async () => {
    setBusy(true);
    try { await post("/api/resume"); setResumeSheet(false); await refreshAll(); toast("Sending allowed again."); }
    catch (e) { toast(errText(e), "bad"); setResumeSheet(false); } finally { setBusy(false); }
  };
  const controls = useMemo(() => ({ requestStop: () => setStopSheet(true), requestResume: () => setResumeSheet(true) }), []);

  let page: ReactNode;
  switch (section) {
    case "batch": page = <BatchPage id={route[1] ?? ""} status={status.data} />; break;
    case "compose": page = composeOn ? <Compose /> : <ComposeOff reason={status.data?.compose?.reason} />; break;
    case "imports": page = <Imports id={route[1]} />; break;
    case "contacts": page = route[1] === "changes" ? (route[2] ? <ContactChangeDetail id={route[2]} status={status.data} /> : <ContactChangesList />) : <Contacts />; break;
    case "activity": page = <Activity />; break;
    case "settings": page = <Settings status={status.data} reloadStatus={status.reload} focus={route[1]} />; break;
    default: page = <Inbox status={status.data} />;
  }
  return (
    <Controls.Provider value={controls}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href={href()}><img src="/icon.svg" width={26} height={26} alt="" />Outbox{status.data?.transport === "live" && <span className="live-dot" title="Live transport" />}</a>
          <div className="topbar-right">
            {simple && <a className="mode-badge" href={href("settings", "harden")} title="Your install is in simple mode. Open Settings to harden it." data-testid="simple-badge">Simple mode</a>}
            {status.data?.transport === "live" ? <span className="topbar-live" data-testid="live-pill">LIVE</span> : <span className="topbar-dry">Dry run</span>}
          </div>
        </header>
        {!setup.approve && <div className="banner banner-warn" role="alert"><span><strong>No approval key yet.</strong> Nothing can be approved.</span><a className="btn btn-small" href={href("settings")}>Set up</a></div>}
        {killed && (
          <div className="banner banner-bad" role="alert" data-testid="kill-banner">
            {reason === "breaker"
              ? <span><strong>Sending paused: a send failed.</strong> Nothing goes out until you resume.</span>
              : <span><strong>Sending is stopped.</strong> Nothing goes out until you resume.</span>}
            <button className="btn btn-small" onClick={controls.requestResume}>Resume</button>
          </div>
        )}
        <main className="page" key={route.join("/")}>{page}</main>
        <nav className="tabbar" aria-label="Sections">
          {TABS.filter((t) => t.key !== "compose" || composeOn).map((t) => (
            <a key={t.key} href={href(...(t.key ? [t.key] : []))} className={`tab ${section === t.key || (t.key === "" && section === "batch") ? "active" : ""}`} aria-current={section === t.key ? "page" : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{t.icon}</svg>
              <span>{t.label}</span>
            </a>
          ))}
          {/* Bottom-right: under the right thumb, but set apart from the tabs, outlined rather than filled, and it only opens a confirmation. */}
          {!killed && (
            <button className="tab tab-stop" onClick={controls.requestStop} aria-label="Stop all sending" data-testid="stop-open">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              <span>Stop</span>
            </button>
          )}
        </nav>
        <Sheet open={stopSheet} onClose={() => setStopSheet(false)} title="Stop all sending?"
          footer={<><button className="btn btn-danger btn-wide" disabled={busy} onClick={stop} data-testid="stop-confirm">{busy ? "Stopping…" : "Stop all sending"}</button><button className="btn btn-wide" onClick={() => setStopSheet(false)}>Keep sending</button></>}>
          <p>Nothing goes out until you resume. Every approval is cancelled and its messages go back to review, so you would approve them again. Approved contact changes are held back too.</p>
          <p className="small muted">{status.data?.counts?.drafts_approved ? `${status.data.counts.drafts_approved} approved message${status.data.counts.drafts_approved === 1 ? " is" : "s are"} waiting to send.` : "No approved messages are waiting."} You get 10 seconds to undo.</p>
        </Sheet>
        <Sheet open={resumeSheet} onClose={() => setResumeSheet(false)} title="Allow sending again?"
          footer={<><button className="btn btn-primary btn-wide" disabled={busy} onClick={resume} data-testid="resume-confirm">{busy ? "Resuming…" : "Allow sending"}</button><button className="btn btn-wide" onClick={() => setResumeSheet(false)}>Keep stopped</button></>}>
          {reason === "breaker"
            ? <p>A send failed; approved messages will continue, including a retry of the failed one. Check Activity first if you want to see what went wrong.</p>
            : <p>You stopped sending. Cancelled approvals stay cancelled; you'll approve batches again before anything goes out.</p>}
        </Sheet>
      </div>
    </Controls.Provider>
  );
}
