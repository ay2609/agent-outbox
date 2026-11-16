import { useEffect, useState } from "react";
import { ApiErr, errText, patch, post, put } from "../api";
import { useControls } from "../controls";
import { useLoad } from "../hooks";
import { addPasskey, passkeyError, registerApprove, reauth, type Purpose } from "../passkeys";
import { Chip, ErrorNote, Spinner, copyText, fmtDateTime, useToast } from "../ui";

const PURPOSE_LABEL: Record<Purpose, string> = { login: "Sign-in", approve: "Approval" };

export function Settings({ status, reloadStatus, focus }: { status: any; reloadStatus: () => Promise<void>; focus?: string }) {
  const s = useLoad<{ settings: any }>("/api/settings");
  const keys = useLoad<{ passkeys: any[] }>("/api/passkeys");
  const toast = useToast();
  const controls = useControls();
  const [policy, setPolicy] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  // Advanced is folded away; "#/settings/harden" (the Simple mode badge) opens it.
  const [adv, setAdv] = useState(focus === "harden");
  // Follows the stored policy (the Live switch can change it too); an unsaved optimistic tick is left alone while it saves.
  useEffect(() => { if (status?.pin?.policy && busy !== "policy") setPolicy({ ...status.pin.policy }); }, [JSON.stringify(status?.pin?.policy)]);
  // The pin is installed from Terminal, outside this page: keep the status fresh so "Live" unlocks without a reload.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void reloadStatus(); };
    const t = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  // ...and scrolls to the Harden card once the page has loaded and the details are open.
  useEffect(() => {
    if (focus !== "harden" || !s.data) return;
    setAdv(true);
    requestAnimationFrame(() => document.getElementById("harden")?.scrollIntoView({ block: "start" }));
  }, [focus, !!s.data]);
  if (!s.data) return <><h1 className="page-title">Settings</h1>{s.error ? <ErrorNote>{s.error}</ErrorNote> : <Spinner />}</>;
  const cur = s.data.settings;

  const run = async (name: string, f: () => Promise<void>) => {
    setBusy(name); setErr(null);
    try { await f(); } catch (e: any) { setErr(e?.status ? errText(e) : passkeyError(e)); } finally { setBusy(null); }
  };
  // One switch for both transports. Going live asks for Touch ID only if something has to change, so try without first.
  const setMode = (m: "dry" | "live") => run("mode", async () => {
    let r: any;
    try { r = await post("/api/mode", { mode: m }); }
    catch (e) {
      if (!(e instanceof ApiErr && e.code === "reauth_required")) throw e;
      r = await post("/api/mode", { mode: m, reauth: await reauth() });
    }
    s.set(() => ({ settings: r.settings })); await reloadStatus();
    // No approval key means no pin file, so nothing can send yet: say that instead of promising it will.
    toast(m === "dry" ? "Dry run. Nothing will be sent."
      : r.approval_key === false ? "Live is on, but nothing can send until you create your approval key."
      : "Live. Messages you approve will send.");
  });
  const add = (purpose: Purpose) => run(`passkey-${purpose}`, async () => {
    const lbl = label.trim() || (purpose === "login" ? "Sign-in key" : "Approval key");
    await (purpose === "approve" && !hasApprove ? registerApprove(lbl) : addPasskey(lbl, purpose));
    setLabel(""); await keys.reload(); await reloadStatus();
    toast(purpose === "approve" ? "Approval key added. Re-pin the keys below." : "Sign-in key added.");
  });
  // Saves as soon as the box is ticked. Simple mode: the pin file changes at once, so turning something ON asks for Touch ID first.
  // Hardened mode: only the user pin changes; the sender sees it after the harden command is run again.
  const simple = status?.pin?.mode !== "hardened";
  const savePolicy = (next: Record<string, any>, msg: string, turningOn: boolean) => run("policy", async () => {
    const before = policy;
    setPolicy({ ...next });   // tick at once; undone below if the save fails or is cancelled
    let r: any;
    try {
      const body: any = { live_allowed: !!next.live_allowed, contacts_live_allowed: !!next.contacts_live_allowed };
      if (simple && turningOn) body.reauth = await reauth();
      r = await put("/api/pin-policy", body);
    } catch (e) { setPolicy(before); throw e; }
    setPolicy({ ...r.policy }); await reloadStatus();
    toast(msg);
  });
  const setLiveAllowed = (live: boolean) => savePolicy({ ...(policy ?? {}), live_allowed: live },
    simple ? (live ? "Saved. Live sending is allowed now." : "Saved. Live sending is off.") : "Saved. Run the harden command again to apply it.", live);
  const setContactsLiveAllowed = (on: boolean) => savePolicy({ ...(policy ?? {}), contacts_live_allowed: on },
    simple ? (on ? "Saved. Live contact changes are allowed now." : "Saved. Live contact changes are off.") : "Saved. Run the harden command again to apply it.", on);
  const setContactsTransport = (t: "dry" | "live") => run("contacts-transport", async () => {
    if (t === cur.contacts_transport) return;
    const body: any = { contacts_transport: t };
    if (t === "live") body.reauth = await reauth();
    const r = await patch("/api/settings", body);
    s.set(() => r); await reloadStatus(); toast(t === "live" ? "Contact changes are live." : "Contact changes are back to dry run.");
  });

  const pin = status?.pin;
  const root = pin?.root;
  const eff = pin?.effective;   // the pin the sender uses right now: the root file if it exists, else the user pin
  const e = status?.exec;
  const cmd: string | null = pin?.install_command ?? null;
  const expected: { credential_id: string; label: string }[] = pin?.expected_keys ?? [];
  const purposes = status?.passkey_purposes ?? { login: 0, approve: 0 };
  const hasApprove = purposes.approve > 0;
  const killed = !!status?.kill_switch;
  const installedLive = !!eff?.live_allowed;
  const installedContactsLive = !!eff?.contacts_live_allowed;
  const hardened = pin?.mode === "hardened";
  const wayForward = hardened ? ", then run the harden command again" : "";
  const userProblems: string[] = (pin?.user?.problems ?? []).filter((p: string) => p !== "Not written yet.");
  const contactsTransport: "dry" | "live" = cur.contacts_transport === "live" ? "live" : "dry";
  const killLabel = status?.kill_reason === "breaker" ? "Paused (a send failed) · Resume" : "Stopped · Resume";

  const live = cur.transport === "live";
  // Hardened and the installed pin says no: Live can't work from here until the user ticks the box and re-runs the command.
  const liveBlocked = hardened && !installedLive;
  const contactsStayDry = live && contactsTransport !== "live" && !installedContactsLive;

  return (
    <>
      <h1 className="page-title">Settings</h1>
      {err && <ErrorNote>{err}</ErrorNote>}

      <section className="section">
        <h2 className="section-title">Sending</h2>
        <div className="card">
          <div className="seg" role="radiogroup" aria-label="Sending mode" data-testid="mode-switch">
            <button role="radio" aria-checked={live} className={live ? "on warn" : ""} disabled={busy === "mode" || (!live && liveBlocked)} onClick={() => setMode("live")}>Live</button>
            <button role="radio" aria-checked={!live} className={!live ? "on" : ""} disabled={busy === "mode"} onClick={() => setMode("dry")}>Dry run</button>
          </div>
          <p className="fine" data-testid="mode-help">{live
            ? "Approved messages really send. Each one still needs your Touch ID. New contacts your agent proposes are added without Touch ID; edits need it."
            : "Approved messages are only logged. Nothing is sent."}</p>
          {live && !installedLive && !liveBlocked && (hasApprove
            ? <div className="note note-warn small" data-testid="live-state">Live is on, but the pin file doesn't allow it yet, so nothing really sends. Tap Live again to fix that (Touch ID).</div>
            : <div className="note note-warn small" data-testid="live-state">Live is on, but nothing can send yet. Create your approval key first (Passkeys, below).</div>)}
          {liveBlocked && <div className="note note-warn small" data-testid="live-state">{live ? "Live is on, but your hardened pin doesn't allow live sending, so nothing really sends." : "Live isn't available: your hardened pin doesn't allow live sending."} Open Advanced, tick "Allow live sending", then run the harden command again.</div>}
          {contactsStayDry && hardened && <p className="fine" data-testid="contacts-dry-line">Contact changes stay a dry run, because your hardened pin doesn't allow them. Advanced has the switch.</p>}
          {hardened && pin?.candidate?.installed === false && <div className="note note-warn small">Your keys or settings changed since you hardened this install. Open Advanced to run the harden command again.</div>}
          <div className="card-row"><strong>Sender</strong>
            <Chip tone={e?.alive ? "good" : "bad"}>{e?.alive ? "running" : e ? "not running" : "not seen yet"}</Chip></div>
          {e?.last_error && <p className="small bad">Last error: {e.last_error}</p>}
          <div className="card-row"><span>Stop all sending</span>
            {killed ? <button className="btn btn-small" onClick={controls.requestResume}>{killLabel}</button> : <button className="btn btn-small btn-danger" onClick={controls.requestStop}>Stop</button>}</div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Passkeys</h2>
        <p className="note note-info small">Sign-in keys sign you in and confirm settings. Approval keys sign the messages you approve, so their Touch ID sheet says "APPROVE SENDING".</p>
        <div className="card">
          {keys.data?.passkeys.map((p) => (
            <div key={p.credential_id} className="card-row small" data-testid="passkey-row" data-purpose={p.purpose}>
              <span><strong>{p.label || "Passkey"}</strong> <span className="muted">added {fmtDateTime(p.created_at)}</span></span>
              <Chip tone={p.purpose === "approve" ? "warn" : "info"}>{PURPOSE_LABEL[p.purpose as Purpose] ?? p.purpose}</Chip>
            </div>
          ))}
        </div>
        {!hasApprove && <div className="note note-warn small">There is no approval key yet, so nothing can be approved.</div>}
        <label className="field"><span>Name for a new key (another Mac or device)</span><input value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="e.g. Work laptop" maxLength={60} /></label>
        <div className="grid2">
          <button className="btn" disabled={!!busy} onClick={() => add("approve")}>{busy === "passkey-approve" ? "Waiting…" : "Add approval key"}</button>
          <button className="btn" disabled={!!busy} onClick={() => add("login")}>{busy === "passkey-login" ? "Waiting…" : "Add sign-in key"}</button>
        </div>
        <p className="fine">{hasApprove ? "Adding one asks for Touch ID with your sign-in key first." : "Your first approval key needs no extra Touch ID if you just signed in."}</p>
      </section>

      <details className="details advanced" id="advanced" data-testid="advanced" open={adv} onToggle={(ev) => setAdv(ev.currentTarget.open)}>
        <summary>Advanced: hardening, permissions, contacts</summary>

        <section className="section" id="harden" data-testid="harden-section">
          <h2 className="section-title">Harden your install</h2>
          <div className="card" data-testid="pin-card">
            <div className="card-row"><strong>Install mode</strong>
              {hardened ? <Chip tone="good">Hardened</Chip> : <Chip tone="warn">Simple mode</Chip>}</div>
            {!hardened && (
              <div className="harden-simple" data-testid="harden-simple">
                <p className="small">Your approval keys and live settings live in <span className="mono">{pin?.user?.path}</span>, and the sender trusts that file. That is fine for everyday use.</p>
                <p className="small"><strong>What simple mode doesn't defend against:</strong> an agent running as you, outside its sandbox, could write its own key into that file and approve its own messages.</p>
                <p className="small">Hardening copies the file to <span className="mono">{root?.path}</span>, where only an administrator can change it. From then on the sender trusts only that copy.</p>
              </div>
            )}
            {hardened && (
              <p className="small">The sender trusts only <span className="mono">{root?.path}</span>, a file owned by root that nothing running as you can edit.
                {pin?.candidate?.installed === true && " It matches your current keys and settings."}</p>
            )}
            {hardened && root?.present && (
              <div className="small" data-testid="installed-pin">
                <p>Owner uid {root.owner_uid}, mode {root.mode}, version {root.version ?? "?"}, {root.keys} key{root.keys === 1 ? "" : "s"}.</p>
                <p><strong>Live sending:</strong> {root.policy ? (root.live_allowed ? <Chip tone="warn">allowed by the pin</Chip> : <Chip>not allowed by the pin</Chip>) : <Chip tone="bad">no valid policy</Chip>}</p>
                <p><strong>Live contact changes:</strong> {root.policy ? (root.contacts_live_allowed ? <Chip tone="warn">allowed by the pin</Chip> : <Chip>not allowed by the pin</Chip>) : <Chip tone="bad">no valid policy</Chip>}</p>
              </div>
            )}
            {hardened && root?.problems?.length > 0 && <ul className="warn-list small" data-testid="pin-problems">{root.problems.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>}
            {!hardened && userProblems.length > 0 && <ul className="warn-list small" data-testid="pin-problems">{userProblems.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>}
          </div>

          {!hasApprove && <p className="small">Create your approval key first (Passkeys, above). There is nothing to harden until then.</p>}
          {cmd && (
            <>
              {hardened
                ? (pin?.candidate?.installed === false
                    ? <div className="note note-warn small" data-testid="rerun-note">Your keys or settings changed since you hardened this install. If you changed them, run the command again to apply them. If you didn't, don't run it: something else changed them. Until then the sender keeps using the old file.</div>
                    : <p className="small">If you add a key or change a live setting, run the command again.</p>)
                : <p className="small">To harden, run this one command in Terminal. It asks for your Mac password, checks the file's checksum first, installs it, then prints what it installed:</p>}
              <div className="cmd" data-testid="install-cmd"><code>{cmd}</code><button className="btn btn-small" onClick={async () => { const ok = await copyText(cmd); toast(ok ? "Copied." : "Copy failed.", ok ? "good" : "bad"); }}>Copy</button></div>
              <p className="small"><strong>Compare</strong> the credential ids and labels it prints with these{pin?.policy?.live_allowed ? ", and check that live_allowed says 1" : ""}{pin?.policy?.contacts_live_allowed ? ", and that contacts_live_allowed says 1" : ""}:</p>
              <ul className="keylist" data-testid="expected-keys">
                {expected.map((k) => <li key={k.credential_id}><strong>{k.label || "(no label)"}</strong><span className="mono">{k.credential_id}</span></li>)}
              </ul>
              {hardened && pin?.candidate?.installed === true && <p className="fine">The installed file is identical to your current keys and settings.</p>}
              {hardened && pin?.candidate?.installed === false && <p className="fine bad">The installed file differs from your current keys and settings.</p>}
            </>
          )}
        </section>

        <section className="section">
          <h2 className="section-title">Live permissions</h2>
          <p className="small muted">{hardened
            ? "Saved to your pin file as soon as you tick them. They take effect once you run the harden command again."
            : "Saved as soon as you tick them, and they take effect at once. Turning one on asks for Touch ID."}</p>
          {policy && (
            <div className="card" data-testid="policy-form">
              <label className="inline-row"><input type="checkbox" checked={!!policy.live_allowed} onChange={(ev) => setLiveAllowed(ev.target.checked)} data-testid="live-allowed" /><span><strong>Allow live sending.</strong> Without it the sender never really sends, whatever the switch says.</span></label>
              <label className="inline-row"><input type="checkbox" checked={!!policy.contacts_live_allowed} onChange={(ev) => setContactsLiveAllowed(ev.target.checked)} data-testid="contacts-live-allowed" /><span><strong>Allow live contact changes.</strong> Without it the sender never really edits Contacts.</span></label>
              <p className="fine">{busy === "policy" ? "Saving…" : ""}</p>
            </div>
          )}
        </section>

        <section className="section">
          <h2 className="section-title">Contacts</h2>
          <p className="small muted">New contacts that an agent proposes are added to your Mac's Contacts automatically (after a live duplicate check). Edits wait for your Touch ID. You can undo any change.</p>
          <div className="seg" role="radiogroup" aria-label="Contacts transport" data-testid="contacts-transport">
            <button role="radio" aria-checked={contactsTransport === "dry"} className={contactsTransport === "dry" ? "on" : ""} disabled={busy === "contacts-transport"} onClick={() => setContactsTransport("dry")}>Dry run</button>
            <button role="radio" aria-checked={contactsTransport === "live"} className={contactsTransport === "live" ? "on warn" : ""} disabled={busy === "contacts-transport" || (contactsTransport !== "live" && !installedContactsLive)} onClick={() => setContactsTransport("live")}>Live</button>
          </div>
          <p className="fine">Dry run logs what would change in Contacts and changes nothing.</p>
          <div className={`note ${installedContactsLive ? "note-good" : "note-warn"} small`} data-testid="contacts-live-state">
            {installedContactsLive
              ? "The pin file allows live contact changes. Going live still needs Touch ID."
              : eff?.present
                ? `Live isn't available: the pin file doesn't allow live contact changes. Tick "Allow live contact changes" above${wayForward}.`
                : "Live isn't available: there is no pin file yet. Create your approval key first."}
          </div>
          {contactsTransport === "live" && !installedContactsLive && <div className="note note-bad small" role="alert">Contacts are set to live, but the pin file doesn't allow it, so the sender only logs changes.</div>}
        </section>
      </details>

      <section className="section">
        <button className="btn btn-wide" onClick={async () => { await post("/api/auth/logout"); location.reload(); }}>Sign out</button>
        <p className="fine">{status?.origin} · server time {status?.server_time ? fmtDateTime(status.server_time) : ""}</p>
      </section>
    </>
  );
}
