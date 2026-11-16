// End-to-end in real Chromium with a CDP virtual authenticator (CTAP2, internal, UV): two-key setup -> sign out ->
// login -> open a batch (a warning-flagged draft is held back) -> edit one -> approve with the approval key -> v2 manifest
// with transport -> stop + undo -> stop + resume -> re-approval after expiry -> LIVE banner -> contacts picker -> imports
// (filters, sheet, region). Run: bun tests/e2e/approve.e2e.ts
// Starts the dashboard on 127.0.0.1:7478 (E2E_PORT) against a temp OUTBOX_HOME; never touches a real install's state dir.
import { mkdtempSync, existsSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 7478); // 7477 is an installed instance's default port: stay off it
const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-e2e-"));
process.env.OUTBOX_HOME = home;
process.env.OUTBOX_PORT = String(PORT); // rp_id defaults to "localhost" and the origin to http://localhost:<port>

const root = join(import.meta.dir, "..", "..");
const shots = process.env.E2E_SHOTS ?? join(home, "screenshots"); // E2E_SHOTS: keep the screenshots somewhere permanent
mkdirSync(shots, { recursive: true });

// Always build, so the screenshots and checks are of the current UI.
{
  console.log("building web/dist …");
  const b = Bun.spawnSync(["bunx", "vite", "build", "--config", "web/vite.config.ts"], { cwd: root, stdout: "ignore", stderr: "inherit" });
  if (b.exitCode !== 0) throw new Error("vite build failed");
}

// Never read the real root pin (/Library/Application Support/agent-outbox): point it at a temp path the test controls (no file = simple mode).
const { paths } = await import("../../src/core/paths");
paths.rootPinFile = join(home, "root-pin.json");
const { getDb, openDb } = await import("../../src/db");
// A brand-new database made through getDb() starts LIVE (see src/db/seed.test.ts). This run asserts dry manifests, so create the file
// the way unit tests do (dry defaults) first: getDb() then sees an existing database and leaves it alone.
openDb().close();
const { addDraft, createBatch, getDrafts, getSettings, setBatchStatus } = await import("../../src/core/store");
const { ownerApp } = await import("../../src/owner-api");
const { defaultSetupToken } = await import("../../src/owner-api/setup-token");
const { chromium } = await import("playwright");
const XLSX = await import("xlsx");

const db = getDb();
defaultSetupToken.start(db); // what server.ts does at start: no sign-in key yet, so <home>/setup-token holds the one-time token
const setupFile = join(home, "setup-token");
const batchId = createBatch(db, { title: "Dinner on Saturday", created_by: "agent:e2e", source: "mcp", status: "review", instructions: "Invite friends to dinner." });
const ids = [
  addDraft(db, batchId, { handle: "+12025550101", recipient_name: "Sam Lee", body: "Hi Sam, are you free for dinner on Saturday at 7? We'd love to see you.", actor: "agent" }),
  addDraft(db, batchId, { handle: "+12025550102", recipient_name: "Priya Nair", body: "Hi Priya, dinner Saturday at 7? Let me know!", actor: "agent",
    warnings: [{ code: "recently_messaged", message: "You messaged this number 3 days ago." }],
    proposed_contact: { given_name: "Priya", family_name: "Nair", org: "Nair Labs", tags: ["Outbox imports"], phones: [{ e164: "+12025550102", label: "mobile" }], emails: [] }, create_contact: true }),
  addDraft(db, batchId, { handle: "+12025550103", recipient_name: "Jordan Ellis", body: "Hey Jordan, dinner on Saturday at 7. Can you make it?", actor: "agent" }),
  // An unfilled merge field: held out of the approval unless the owner includes it explicitly.
  addDraft(db, batchId, { handle: "+12025550104", recipient_name: "Taylor Quinn", body: "Hi {{first_name}}, dinner Saturday at 7?", actor: "agent",
    warnings: [{ code: "unresolved_var", message: "Unfilled merge field: {{first_name}}" }] }),
];
setBatchStatus(db, batchId, "review", "e2e");

// A second batch for the ambiguous-contact picker.
const batch2 = createBatch(db, { title: "Contacts check", created_by: "agent:e2e", source: "mcp", status: "review" });
db.query("INSERT INTO contacts(id, source, display_name, given_name, family_name, org, phones_json, updated_at) VALUES ('c-dana','manual','Dana Cole','Dana','Cole','Acme',?,?)")
  .run(JSON.stringify([{ e164: "+12025550130", label: "mobile" }]), new Date().toISOString());
db.query("INSERT INTO contact_handles(handle, contact_id) VALUES ('+12025550130','c-dana')").run();
const ambig = addDraft(db, batch2, { handle: "+12025550199", recipient_name: "Dana Cole", body: "Hi Dana, long time!", actor: "agent",
  warnings: [{ code: "ambiguous_contact", message: "May match an existing contact: Dana Cole" }] });
setBatchStatus(db, batch2, "review", "e2e");

const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: ownerApp.fetch });
const browser = await chromium.launch({ headless: true });
let failed = false;
const results: string[] = [];
const ok = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); results.push(`ok  ${msg}`); };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const B = `http://localhost:${PORT}`;

try {
  // A laptop window; set E2E_MOBILE=1 for the phone-sized layout.
  const ctx = await browser.newContext(process.env.E2E_MOBILE === "1"
    ? { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.error("PAGE ERROR", e.message); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const shot = async (name: string, o: { fullPage?: boolean } = {}) => { await page.waitForTimeout(450); await page.screenshot({ path: join(shots, name), ...o }); };

  // 1. two-key setup: the sign-in key, then the approval key. The first key needs the one-time setup link.
  const setupToken = readFileSync(setupFile, "utf8").trim();
  ok(/^[A-Za-z0-9_-]{43}$/.test(setupToken) && (statSync(setupFile).mode & 0o777) === 0o600, "the server wrote a 0600 setup-token file before any key exists");
  const stateJson = await (await fetch(`${B}/api/auth/state`)).json() as any;
  ok(stateJson.setup_token_required === true && !JSON.stringify(stateJson).includes(setupToken), "/api/auth/state says a setup token is required and never returns it");
  const rawOpts = (body: object) => fetch(`${B}/api/auth/register/options`, { method: "POST", headers: { "content-type": "application/json", "x-outbox": "1" }, body: JSON.stringify(body) });
  ok((await rawOpts({ purpose: "login" })).status === 403 && (await rawOpts({ purpose: "login", setup_token: "wrong" })).status === 403, "registering without the token, or with a wrong one, is refused (403)");
  // No link: the page says how to get one and the button is disabled.
  await page.goto(`${B}/`);
  await page.getByTestId("setup-link-note").waitFor();
  ok((await page.getByTestId("setup-link-note").innerText()).includes("Open the setup link printed by the installer, or run ./install.sh --setup-link in the agent-outbox folder."), "without a setup link the setup page shows the note");
  ok(await page.getByRole("button", { name: "Create sign-in key" }).isDisabled(), "...and the Create sign-in key button is disabled");
  await shot("setup-no-link.png");
  // A wrong token: stripped from the address bar, sent, and refused with a plain message.
  await page.goto(`${B}/#/setup?token=${"x".repeat(43)}`);
  await page.reload();
  await page.getByRole("button", { name: "Create sign-in key" }).waitFor();
  ok(!page.url().includes("token") && page.url().endsWith("#/setup"), "the token is stripped from the address bar (history.replaceState)");
  ok((await page.getByTestId("setup-link-note").count()) === 0, "with a token in hand the note is gone");
  await page.getByRole("button", { name: "Create sign-in key" }).click();
  await page.getByText(/setup link isn't valid/).waitFor({ timeout: 8000 });
  ok(db.query<any, []>("SELECT COUNT(*) n FROM passkeys").get()!.n === 0, "a wrong token enrols nothing");
  // The real link.
  await page.goto(`${B}/#/setup?token=${setupToken}`);
  await page.reload();
  await page.getByRole("button", { name: "Create sign-in key" }).waitFor();
  ok(!page.url().includes(setupToken), "the real token is stripped from the URL too");
  await shot("setup-signin-key.png"); // taken after the strip: the token is not on screen
  await page.getByRole("button", { name: "Create sign-in key" }).click();
  await page.getByRole("button", { name: "Create approval key" }).waitFor({ timeout: 15000 });
  ok(true, "step 1 (sign-in key) done; the dashboard now asks for the approval key");
  ok(!existsSync(setupFile) && !defaultSetupToken.active, "the setup-token file is deleted and forgotten once the sign-in key exists");
  ok(await page.evaluate(() => sessionStorage.getItem("outbox:setup-token")) === null, "the browser dropped the token too");
  ok(((await (await fetch(`${B}/api/auth/state`)).json()) as any).setup_token_required === false, "/api/auth/state no longer asks for a setup token");
  ok((await page.getByText(/Two keys, so the Touch ID sheet says/).count()) === 1, "setup explains in one line why there are two keys");
  const afterOne = db.query<any, []>("SELECT purpose FROM passkeys").all();
  ok(afterOne.length === 1 && afterOne[0].purpose === "login", "only a login passkey exists after step 1");
  ok(!existsSync(join(home, "passkeys.json")), "no user pin until an approval key exists");
  await shot("setup-approval-key.png");
  await page.getByRole("button", { name: "Create approval key" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 15000 });
  const pk = db.query<any, []>("SELECT * FROM passkeys ORDER BY created_at").all();
  ok(pk.length === 2 && pk[0].purpose === "login" && pk[1].purpose === "approve", "two passkey rows: login then approve");
  ok(pk[0].user_handle && pk[1].user_handle && pk[0].user_handle !== pk[1].user_handle, "distinct user handles per purpose");
  const approveKey = pk[1], loginKey = pk[0];
  ok(/sign-in/i.test(loginKey.label) && /approval/i.test(approveKey.label), `default labels differ per step ("${loginKey.label}", "${approveKey.label}")`);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  ok(credentials.length === 2, "virtual authenticator holds both credentials");
  const credB64u = (c: any) => Buffer.from(c.credentialId, "base64").toString("base64url");
  const byId = new Map<string, any>(credentials.map((c: any) => [credB64u(c), c]));
  ok(byId.get(loginKey.credential_id).userHandle && Buffer.from(byId.get(loginKey.credential_id).userHandle, "base64").toString("base64url") === loginKey.user_handle
    && Buffer.from(byId.get(approveKey.credential_id).userHandle, "base64").toString("base64url") === approveKey.user_handle, "the authenticator stored each key under its own user.id");
  const nm = (id: string): string | undefined => byId.get(id).userName;
  ok(nm(loginKey.credential_id) === undefined || (nm(loginKey.credential_id) === "Sign in to Outbox" && nm(approveKey.credential_id) === "APPROVE SENDING (Outbox)"), "account names on the credentials: 'Sign in to Outbox' and 'APPROVE SENDING (Outbox)'");

  // 2. sign out, then login (login key only)
  await page.goto(`${B}/#/settings`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 15000 }); // the hash route survives the reload
  ok(true, "signed out and logged back in");
  const loginAudit = db.query<any, []>("SELECT target FROM audit_log WHERE action = 'login' ORDER BY id DESC").get()!;
  ok(loginAudit.target === loginKey.credential_id, "the login was signed by the sign-in key, not the approval key");
  const rows = await page.getByTestId("passkey-row").evaluateAll((els) => els.map((e) => [e.getAttribute("data-purpose"), e.textContent ?? ""]));
  ok(rows.length === 2 && rows[0]![0] === "login" && rows[1]![0] === "approve" && /Sign-in/.test(rows[0]![1]!) && /Approval/.test(rows[1]![1]!), "Settings lists each passkey with its purpose");
  await page.goto(`${B}/#/`);
  await page.getByRole("heading", { name: "Inbox" }).waitFor();

  await page.getByText("Dinner on Saturday").first().waitFor();
  await shot("inbox.png");

  // 3. open the batch, edit draft 2, skip draft 3; draft 4 is flagged
  await page.getByText("Dinner on Saturday").first().click();
  await page.locator("article[data-draft]").nth(3).waitFor();
  const card2 = page.locator("article[data-draft]").nth(1);
  await card2.locator("textarea").fill("Hi Priya, dinner Saturday at 7:30 now. Does that still work?");
  await card2.getByText(/Saved · revision 2/).waitFor({ timeout: 8000 });
  ok(true, "edit autosaved with a revision indicator (revision 2)");
  const edited = db.query<any, [string]>("SELECT body, version FROM drafts WHERE id = ?").get(ids[1]!)!;
  ok(edited.body === "Hi Priya, dinner Saturday at 7:30 now. Does that still work?" && edited.version === 2, "edited body is in the DB at version 2");
  ok((await card2.getByTestId("recipient-handle").innerText()).includes("(202) 555-0102"), "the card shows the number as prominently as the name");
  await page.locator("article[data-draft]").nth(2).getByRole("switch").click();
  await page.waitForFunction(() => document.querySelectorAll('article[data-status="skipped"]').length === 1);
  // filter bar
  await page.locator('[data-filter="warnings"]').click();
  ok((await page.locator("article[data-draft]").count()) === 1, "Warnings filter shows only the flagged draft");
  await page.locator('[data-filter="new"]').click();
  ok((await page.locator("article[data-draft]").count()) === 1 && (await page.getByTestId("proposed-contact").innerText()).includes("Nair Labs"), "New contacts filter shows Priya with the whole proposed contact (company too)");
  await page.locator('[data-filter="skipped"]').click();
  ok((await page.locator("article[data-draft]").count()) === 1, "Skipped filter shows Jordan");
  await page.locator('[data-filter="all"]').click();
  const approveBtn = page.getByRole("button", { name: "Approve 3" });
  await approveBtn.waitFor();
  ok(true, "footer reads Approve 3 (Sam, Priya and the flagged Taylor); Jordan is skipped");
  await shot("batch.png");

  // 4. approve: warnings held back, dry banner, v2 manifest
  await approveBtn.click();
  const list = page.getByTestId("manifest-list");
  await list.waitFor();
  const text = await list.innerText();
  ok(text.includes("Sam Lee") && text.includes("Priya Nair") && !text.includes("Jordan Ellis") && !text.includes("Taylor Quinn"), "confirm sheet lists Sam and Priya only: the skipped and the flagged draft are out");
  ok(text.includes("7:30 now") && text.includes("(202) 555-0101"), "confirm sheet shows the full edited text and the numbers");
  ok(text.includes("Nair Labs") && text.includes("Outbox imports") && text.includes("(202) 555-0102"), "confirm sheet shows the whole proposed contact: name, company, number, tags");
  const held = page.getByTestId("held-back");
  ok((await held.innerText()).includes("Taylor Quinn") && (await held.innerText()).includes("Unfilled field"), "Taylor is held back with its warning chip");
  ok((await page.getByTestId("dry-banner").innerText()).includes("Dry run: nothing will be sent"), "the sheet says it's a dry run");
  ok((await page.getByTestId("sheet-summary").innerText()).includes("2 messages"), "sheet summary at the top");
  const sheetText = await page.locator(".sheet").innerText().catch(async () => await page.locator("body").innerText());
  ok(!/\b(estimate|finish\w*|quiet|daily cap|exceeds|pace[ds]?|scheduled|about \d+ min)\b/i.test(sheetText), "the sheet has no send-time estimate, finish line, cap or quiet-hours text");
  ok((await page.getByText(/Valid for 24 hours, until/).count()) === 1, "'Valid for 24 hours' is dynamic text");
  // include anyway, then back out again
  await held.getByRole("switch").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="manifest-list"] > li').length === 3);
  ok((await list.innerText()).includes("Taylor Quinn"), "'Include anyway' puts the flagged draft in the list");
  await held.getByRole("switch").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="manifest-list"] > li').length === 2);
  // the approval window is fixed: no selector
  ok((await page.getByRole("button", { name: /^(24|48|72) hours$/ }).count()) === 0, "there is no approval-window selector");
  await shot("approve-sheet.png");
  await page.getByRole("button", { name: "Approve with Touch ID" }).click();
  await page.getByTestId("approve-success").waitFor({ timeout: 15000 });
  await shot("approved.png");
  ok(true, "approval succeeded in the browser");

  // 5. assertions on the database
  const approvals = db.query<any, []>("SELECT * FROM approvals").all();
  ok(approvals.length === 1, "exactly one approvals row");
  const ap = approvals[0]!;
  const m = JSON.parse(ap.manifest);
  ok(ap.manifest === JSON.stringify(m), "manifest bytes stored verbatim (compact JSON)");
  ok(ap.manifest_sha256 === createHash("sha256").update(ap.manifest).digest("hex"), "manifest_sha256 matches the stored bytes");
  ok(m.v === 2 && m.transport === "dry" && m.batch_id === batchId && m.rp_id === "localhost" && m.origin === B && m.approval_id === ap.id, "manifest v2 header fields, with transport 'dry'");
  ok(m.items.length === 2 && m.items[0].draft_id === ids[0] && m.items[1].draft_id === ids[1], "manifest lists drafts 1 and 2 only (the flagged draft was held back)");
  ok(m.items[0].body_sha256 === sha("Hi Sam, are you free for dinner on Saturday at 7? We'd love to see you."), "item 1 body hash");
  ok(m.items[1].body_sha256 === sha("Hi Priya, dinner Saturday at 7:30 now. Does that still work?"), "item 2 body hash is of the EDITED text");
  ok(m.items[1].to === "+12025550102" && m.items[1].service === "auto" && m.items[1].create_contact?.given_name === "Priya", "item 2 handle, service and contact payload");
  ok(m.items[1].create_contact.phones.length === 1 && m.items[1].create_contact.phones[0].e164 === m.items[1].to && m.items[1].create_contact.emails.length === 0, "the proposed contact has exactly the draft's handle");
  ok(m.items[0].create_contact === null, "item 1 has no contact payload");
  const states = getDrafts(db, batchId).map((d) => d.status);
  ok(states.join() === "approved,approved,skipped,review", `draft states ${states.join()}`);
  ok(db.query<any, []>("SELECT status FROM batches WHERE id = '" + batchId + "'").get()!.status === "approved", "batch is approved");

  // the stored assertion verifies under the user pin's APPROVE key, and the login key is not in the pin
  const userPinPath = join(home, "passkeys.json");
  const dev = JSON.parse(readFileSync(userPinPath, "utf8"));
  ok(dev.v === 2 && dev.rp_id === "localhost" && dev.origin === B && dev.keys.length === 1, "passkeys.json (the user pin) is v2 with one key");
  ok(!existsSync(join(home, "pin-candidate.json")) && !existsSync(join(home, "dev-passkeys.json")), "no pin-candidate.json or dev-passkeys.json any more");
  ok(JSON.stringify(dev.policy) === '{"live_allowed":false,"contacts_live_allowed":false}', "the pin policy is just { live_allowed, contacts_live_allowed }, both false by default");
  ok(dev.keys[0].credential_id === ap.credential_id && dev.keys[0].credential_id === approveKey.credential_id, "pinned credential id is the approval key that signed");
  ok(!JSON.stringify(dev).includes(loginKey.credential_id), "the sign-in key is not in the pin file");
  ok((statSync(userPinPath).mode & 0o777) === 0o600, "passkeys.json is mode 0600");
  const cred = credentials.find((c: any) => credB64u(c) === approveKey.credential_id)!;
  const priv = createPrivateKey({ key: Buffer.from(cred.privateKey, "base64"), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  ok(dev.keys[0].x963 === x963 && approveKey.public_key_x963_b64 === x963, "pinned x963 equals the approval authenticator's real public key");
  const xb = Buffer.from(dev.keys[0].x963, "base64url");
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: xb.subarray(1, 33).toString("base64url"), y: xb.subarray(33).toString("base64url") }, format: "jwk" });
  const authData = Buffer.from(ap.authenticator_data_b64, "base64url"), cdj = Buffer.from(ap.client_data_json_b64, "base64url");
  const cd = JSON.parse(cdj.toString());
  ok(verify("sha256", Buffer.concat([authData, createHash("sha256").update(cdj).digest()]), pub, Buffer.from(ap.signature_b64, "base64url")),
    "ECDSA signature over authData || sha256(clientDataJSON) verifies with the pinned x963 key (the Swift executor's check)");
  ok(cd.type === "webauthn.get" && cd.origin === B && cd.challenge === createHash("sha256").update(ap.manifest).digest("base64url"), "clientDataJSON: type, origin and challenge = base64url(sha256(manifest bytes))");
  ok((authData[32]! & 0x05) === 0x05 && authData.subarray(0, 32).equals(createHash("sha256").update("localhost").digest()), "authenticatorData: rpIdHash and UP+UV flags");

  // Snapshot the approved state so the Swift executor can be run against it (tests/e2e/exec-roundtrip.sh).
  if (process.env.E2E_KEEP_DIR) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    mkdirSync(process.env.E2E_KEEP_DIR, { recursive: true });
    db.exec(`VACUUM INTO '${join(process.env.E2E_KEEP_DIR, "outbox.db")}'`);
    writeFileSync(join(process.env.E2E_KEEP_DIR, "passkeys.json"), readFileSync(userPinPath), { mode: 0o600 });
  }

  // 6. settings: simple mode, the harden card with ONE sha256-checked command, expected keys, live permissions
  await page.getByRole("button", { name: "Done" }).click();
  ok(await page.getByTestId("simple-badge").isVisible(), "a persistent 'Simple mode' badge is in the app chrome");
  ok((await page.getByRole("link", { name: "Ask Claude" }).count()) === 0, "there is no 'Ask Claude' tab any more");
  await page.getByRole("link", { name: "AI draft" }).click();
  await page.getByRole("heading", { name: "AI draft" }).waitFor();
  ok(page.url().endsWith("#/ai"), "the AI draft tab opens #/ai");
  ok((await page.getByTestId("prompt-card").count()) >= 10, "the AI draft page lists the copy-paste prompts");
  const promptTexts = await page.getByTestId("prompt-text").allInnerTexts();
  ok(promptTexts.filter((t) => t.includes("[")).length >= 8 && promptTexts.some((t) => t.includes("my group")), "prompts have [fill-in] parts and the group prompts are there");
  ok((await page.locator("main").innerText()).includes("nothing sends until you approve with Touch ID"), "the page says nothing sends until you approve with Touch ID");
  await page.getByTestId("copy-prompt").first().click();
  ok((await page.getByTestId("toast").innerText()).includes("Copied"), "Copy shows a 'Copied' toast");
  await page.getByTestId("simple-badge").click();
  await page.getByRole("heading", { name: "Harden your install" }).waitFor();
  ok(page.url().endsWith("#/settings/harden"), "the badge links to the Settings harden card");
  ok(await page.getByTestId("advanced").evaluate((d) => (d as HTMLDetailsElement).open), "...and opens the folded-away Advanced block");
  await page.getByTestId("install-cmd").waitFor();
  const REAL_PIN = "/Library/Application Support/agent-outbox/passkeys.json"; // the test's root pin path is a temp file; show the real path in the docs
  // Screenshots for the docs show a real install's paths, not the test's temp dir (the command quotes the user pin: it has a space).
  const REAL_USER_PIN = "/Users/you/Library/Application Support/agent-outbox/passkeys.json";
  const tempUserPin = join(home, "passkeys.json");
  const maskPaths = () => page.evaluate(([rootTmp, rootReal, userTmp, userReal, homeTmp]) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      let t = n.nodeValue ?? "";
      if (!t.includes(homeTmp!)) continue;
      const dirReal = rootReal!.replace(/\/[^/]+$/, "");
      if (n.parentElement?.closest('[data-testid="install-cmd"]')) {
        // the real root pin path has a space, so the command quotes it (the temp one doesn't)
        t = t.split(` ${rootTmp}`).join(` '${rootReal}'`).split(` ${homeTmp} &&`).join(` '${dirReal}' &&`);
        t = t.split(userTmp + "'").join(userReal + "'").split(" " + userTmp).join(` '${userReal}'`);
      } else {
        t = t.split(rootTmp!).join(rootReal!).split(userTmp!).join(userReal!);
      }
      n.nodeValue = t.split(homeTmp!).join(dirReal);
    }
  }, [paths.rootPinFile, REAL_PIN, tempUserPin, REAL_USER_PIN, home]);
  // Advanced is folded away on #/settings; #/settings/harden (the badge) opens it. A hash-only navigation keeps the page, so open it by hand.
  const openAdvanced = async () => {
    await page.getByTestId("advanced").waitFor({ state: "attached" });
    if (!(await page.getByTestId("advanced").evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByText("Advanced: hardening, permissions, contacts").click();
  };
  const shotMasked = async (name: string) => { await maskPaths(); await shot(name); await page.reload(); await openAdvanced(); await page.getByTestId("pin-card").waitFor(); };
  await shotMasked("settings.png");
  const simpleText = await page.getByTestId("harden-simple").innerText();
  ok(/doesn't defend against/.test(simpleText) && /outside its sandbox/.test(simpleText) && /approve its own messages/.test(simpleText), "simple mode says in plain words what it does not defend");
  ok((await page.getByTestId("pin-card").innerText()).includes("Simple mode") && !(await page.getByTestId("pin-card").innerText()).includes("Hardened"), "the card shows the simple-mode chip, not 'Hardened'");
  const cmd = await page.locator('[data-testid="install-cmd"] code').innerText();
  const candPath = userPinPath;
  const candSha = createHash("sha256").update(readFileSync(candPath)).digest("hex");
  if (process.env.E2E_DEBUG) console.log("CMD:", JSON.stringify(cmd), candSha, candPath);
  ok((await page.locator(".cmd code").count()) === 1 && cmd.startsWith(`echo '${candSha}  ${candPath}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755`) && cmd.includes("-m 444") && cmd.endsWith(`&& plutil -p ${paths.rootPinFile}`),
    "Settings shows ONE command: sha256 check of the user pin, sudo install to the root path, plutil -p");
  ok(Bun.spawnSync(["bash", "-c", cmd.split(" && ")[0]!]).exitCode === 0, "the command's sha256 check passes against the user pin on disk");
  const expectedText = await page.getByTestId("expected-keys").innerText();
  ok(expectedText.includes(approveKey.credential_id) && expectedText.includes(approveKey.label) && !expectedText.includes(loginKey.credential_id), "the expected credential ids and labels are listed next to the command (approval key only)");
  const modeSwitch = page.getByTestId("mode-switch");
  ok((await modeSwitch.getByRole("radio", { name: "Dry run" }).getAttribute("aria-checked")) === "true" && (await page.getByTestId("mode-help").innerText()).includes("Nothing is sent"), "the Sending switch starts on Dry run here (this run began dry) and says nothing is sent");
  ok(await modeSwitch.getByRole("radio", { name: "Live" }).isEnabled(), "in simple mode the Live switch is available: one Touch ID turns the permissions on too");
  ok((await page.getByTestId("contacts-live-state").innerText()).includes("isn't available"), "live contact changes are shown as unavailable until the pin allows them");
  ok(await page.getByRole("radiogroup", { name: "Contacts transport" }).getByRole("radio", { name: "Live" }).isDisabled(), "the contacts Live switch is disabled");
  const settingsText = await page.locator("main, body").first().innerText();
  ok(!/\b(pace[ds]?|burst|daily cap|quiet hours|time zone|sent today)\b/i.test(settingsText), "Settings has no pacing, cap, quiet-hours or time-zone controls");
  ok(!/face id|\bphone\b|remote/i.test(settingsText), "no Face ID, phone or remote-access wording on the page");
  ok((await page.getByTestId("policy-form").getByRole("checkbox").count()) === 2, "the live_allowed and contacts_live_allowed checkboxes are the only policy controls");
  const livePolicy = page.getByTestId("policy-form").getByRole("checkbox").first();
  ok(!(await livePolicy.isChecked()), "'Allow live sending' is unchecked by default");
  // Simple mode: ticking asks for Touch ID (a fresh sign-in assertion) and takes effect at once; unticking needs nothing extra.
  await livePolicy.check();
  await page.getByText(/Saved\. Live sending is allowed now/).waitFor({ timeout: 8000 });
  ok(JSON.parse(readFileSync(userPinPath, "utf8")).policy.live_allowed === true, "ticking 'Allow live sending' (after Touch ID) writes live_allowed into the user pin at once");
  await livePolicy.uncheck();
  await page.getByText(/Saved\. Live sending is off/).waitFor({ timeout: 8000 });
  ok(JSON.parse(readFileSync(userPinPath, "utf8")).policy.live_allowed === false, "unticking writes it back to false");
  const candPolicy = () => JSON.parse(readFileSync(userPinPath, "utf8")).policy;
  const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await page.waitForTimeout(100); return f(); };
  const contactsPolicy = page.getByTestId("contacts-live-allowed");
  ok(!(await contactsPolicy.isChecked()), "'Allow live contact changes' is unchecked by default");
  await contactsPolicy.check();
  ok(await until(() => candPolicy().contacts_live_allowed === true), "ticking 'Allow live contact changes' writes contacts_live_allowed into the user pin");
  ok(candPolicy().live_allowed === false, "...without touching live_allowed");
  await contactsPolicy.uncheck();
  ok(await until(() => candPolicy().contacts_live_allowed === false), "unticking writes contacts_live_allowed back to false");
  // The Sending switch: ONE Touch ID turns on the policy, both transports and the pin; Dry run needs none.
  const transports = () => `${getSettings(db).transport}/${getSettings(db).contacts_transport}`;
  await modeSwitch.getByRole("radio", { name: "Live" }).click();
  await page.getByText(/Live\. Messages you approve will send/).waitFor({ timeout: 8000 });
  const modeAudit = JSON.parse(db.query<any, []>("SELECT details_json FROM audit_log WHERE action = 'mode.set' ORDER BY id DESC").get()!.details_json);
  ok(transports() === "live/live" && candPolicy().live_allowed === true && candPolicy().contacts_live_allowed === true, "Live (one Touch ID) set both transports live and wrote both permissions into the user pin");
  ok(modeAudit.mode === "live" && modeAudit.policy_changed === true && (await page.getByTestId("mode-help").innerText()).includes("Each one still needs your Touch ID"), "the line under the switch says each message still needs Touch ID");
  ok(await livePolicy.isChecked() && await contactsPolicy.isChecked(), "...and the two Live permissions in Advanced are ticked");
  await modeSwitch.getByRole("radio", { name: "Dry run" }).click();
  await page.getByText(/Dry run\. Nothing will be sent/).waitFor({ timeout: 8000 });
  ok(transports() === "dry/dry", "Dry run (no Touch ID) put both transports back to dry");
  await livePolicy.uncheck(); await contactsPolicy.uncheck();
  ok(await until(() => candPolicy().live_allowed === false && candPolicy().contacts_live_allowed === false), "the permissions are switched off again for the hardening steps");
  await page.getByTestId("expected-keys").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shotMasked("settings-pin.png");
  // Hardening: the root pin appears (as after the sudo command). The badge goes, the chip says Hardened, and from then on only that file counts.
  writeFileSync(paths.rootPinFile, readFileSync(userPinPath));
  await page.goto(`${B}/#/settings`);
  await openAdvanced();
  await page.getByTestId("installed-pin").waitFor({ timeout: 10000 });
  ok((await page.getByTestId("pin-card").innerText()).includes("Hardened"), "with the root pin present the card shows the 'Hardened' chip");
  ok((await page.getByTestId("simple-badge").count()) === 0, "...and the Simple mode badge is gone");
  await livePolicy.check(); // hardened: no Touch ID, only the candidate changes
  await page.getByText(/Saved\. Run the harden command again/).waitFor({ timeout: 8000 });
  await page.getByTestId("rerun-note").waitFor();
  ok(candPolicy().live_allowed === true && JSON.parse(readFileSync(paths.rootPinFile, "utf8")).policy.live_allowed === false, "hardened: the policy change reaches the user pin only; the root pin is untouched until the command is re-run");
  ok(await modeSwitch.getByRole("radio", { name: "Live" }).isDisabled() && (await page.getByTestId("live-state").innerText()).includes("hardened pin doesn't allow live sending"), "...so Live stays locked, with the way forward in plain words");
  await shotMasked("settings-hardened.png");
  rmSync(paths.rootPinFile, { force: true });
  writeFileSync(userPinPath, JSON.stringify({ ...JSON.parse(readFileSync(userPinPath, "utf8")), policy: { live_allowed: false, contacts_live_allowed: false } }, null, 2) + "\n", { mode: 0o600 });
  db.query("UPDATE settings SET value = ? WHERE key = 'pin_policy'").run(JSON.stringify({ live_allowed: false, contacts_live_allowed: false }));

  // 6b. imports: paste a table, look at the invalid rows, confirm the mapping, write a template, create a batch
  await page.goto(`${B}/#/imports`);
  await page.getByText("Or paste a table").click();
  await page.locator("details textarea").fill("Name,Phone,City\nAda Park,(202) 555-0111,Boston\nLeo Chen,202-555-0112,Austin\nNo Number,n/a,Nowhere");
  await page.getByRole("button", { name: "Read pasted table" }).click();
  await page.getByRole("heading", { name: "pasted.csv" }).waitFor({ timeout: 10000 });
  ok(/#\/imports\/[0-9a-f-]{36}/.test(await page.getByTestId("import-route").innerText()), "the import page shows its route #/imports/<id>");
  await page.locator('[data-match="invalid"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="import-rows"] [data-row]').length === 1);
  ok((await page.getByTestId("import-rows").innerText()).includes("No Number"), "the invalid chip filters the row list to the bad row, with its issue message");
  ok((await page.getByTestId("import-rows").locator("li").count()) >= 1, "issue messages are listed");
  await page.locator('[data-match="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="import-rows"] [data-row]').length === 3);
  await page.getByRole("button", { name: "Confirm mapping" }).click();
  await page.getByText("mapping confirmed").waitFor();
  await page.locator("textarea").fill("Hi {{first_name|there}}, how is {{city}}? ");
  await page.getByText("Hi Ada, how is Boston?").waitFor({ timeout: 8000 });
  ok(true, "import UI: mapping confirmed, live template preview renders merge fields");
  await shot("import.png", { fullPage: true });
  await page.getByRole("button", { name: "Create batch for review" }).click();
  await page.locator("article[data-draft]").first().waitFor({ timeout: 10000 });
  const made = db.query<any, []>("SELECT * FROM batches WHERE source = 'dashboard'").get()!;
  ok(made && made.status === "review" && getDrafts(db, made.id).length === 2, "import batch created in review with 2 drafts (invalid row skipped)");
  const importId = db.query<any, []>("SELECT id FROM imports ORDER BY created_at DESC LIMIT 1").get()!.id;

  // sheet picker and region on a two-sheet workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Alpha One", "(202) 555-0121"]]), "People");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Beta Two", "(202) 555-0122"], ["Gamma Three", "(202) 555-0123"]]), "Others");
  await page.goto(`${B}/#/imports`);
  await page.setInputFiles('input[type="file"]', { name: "two-sheets.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })) });
  await page.getByRole("heading", { name: "two-sheets.xlsx" }).waitFor({ timeout: 10000 });
  const firstRoute = page.url();
  await page.getByTestId("sheet-select").selectOption("Others");
  await page.waitForFunction((u) => location.href !== u, firstRoute);
  await page.getByText("sheet: Others").waitFor();
  const reread = db.query<any, []>("SELECT sheet, row_count FROM imports ORDER BY created_at DESC LIMIT 1").get()!;
  ok(reread.sheet === "Others" && reread.row_count === 2, "the sheet picker re-ingests the stored file with the chosen sheet (new import, 2 rows)");
  const beforeRegion = page.url();
  await page.getByTestId("region-select").selectOption("GB");
  await page.getByTestId("reread").click();
  await page.waitForFunction((u) => location.href !== u, beforeRegion);
  const regAudit = db.query<any, []>("SELECT details_json FROM audit_log WHERE action = 'import.reingest' ORDER BY id DESC").get()!;
  ok(JSON.parse(regAudit.details_json).region === "GB", "the region select is passed to the re-ingest (audited as GB)");

  // 6c. dark mode check
  await page.goto(`${B}/#/batch/${made.id}`);
  await page.locator("article[data-draft]").first().waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("batch-dark.png");
  await page.emulateMedia({ colorScheme: "light" });

  // 7. the ambiguous-contact picker
  await page.goto(`${B}/#/batch/${batch2}`);
  await page.getByTestId("contact-picker").waitFor();
  await shot("contact-picker.png");
  await page.getByRole("button", { name: /Use Dana Cole.*555-0130/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="contact-picker"]'));
  const picked = getDrafts(db, batch2)[0]!;
  ok(picked.contact_id === "c-dana" && picked.handle === "+12025550130" && picked.recipient_name === "Dana Cole" && !picked.create_contact, "picking an existing contact links it and moves the message to that contact's number");
  ok(!picked.warnings.some((w) => w.code === "ambiguous_contact"), "the ambiguous warning is gone once picked");
  void ambig;

  // 8. stop + undo: the approval comes back
  await page.goto(`${B}/#/batch/${batchId}`);
  await page.locator("article[data-draft]").nth(3).waitFor();
  await page.getByTestId("stop-open").click();
  await page.getByTestId("stop-confirm").waitFor();
  await shot("stop-confirm.png");
  ok(getSettings(db).kill_switch === false, "opening the stop sheet does nothing yet (a confirm step)");
  await page.getByTestId("stop-confirm").click();
  await page.getByTestId("kill-banner").waitFor();
  const toast = page.getByTestId("toast");
  ok((await toast.innerText()).includes("Undo") && (await toast.innerText()).includes("1 approval"), "stop shows a toast with Undo");
  await shot("undo-toast.png");
  const stopped = db.query<any, []>("SELECT revoked_at FROM approvals").get()!;
  ok(!!stopped.revoked_at && getSettings(db).kill_switch === true && getSettings(db).kill_reason === "owner", "Stop revoked the approval and set kill_reason 'owner'");
  ok(getDrafts(db, batchId).map((d) => d.status).join() === "review,review,skipped,review", "approved drafts went back to review");
  await toast.getByRole("button", { name: "Undo" }).click();
  await page.getByText(/Stop undone/).waitFor();
  const undone = db.query<any, []>("SELECT revoked_at FROM approvals").get()!;
  ok(undone.revoked_at === null && getSettings(db).kill_switch === false && getSettings(db).kill_reason === "", "Undo cleared revoked_at and reset the kill switch");
  ok(getDrafts(db, batchId).map((d) => d.status).join() === "approved,approved,skipped,review", "the approved drafts are approved again");
  ok((await page.getByTestId("kill-banner").count()) === 0, "the stopped banner is gone");

  // 9. stop for real, then resume (owner wording)
  await page.getByTestId("stop-open").click();
  await page.getByTestId("stop-confirm").click();
  await page.getByTestId("kill-banner").waitFor();
  await page.waitForTimeout(300);
  ok(db.query<any, []>("SELECT COUNT(*) n FROM audit_log WHERE action = 'stop'").get()!.n === 2, "a second stop was recorded");
  await page.getByTestId("kill-banner").getByRole("button", { name: "Resume" }).click();
  await page.getByText(/You stopped sending/).waitFor();
  await page.getByTestId("resume-confirm").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="kill-banner"]'));
  ok(getSettings(db).kill_switch === false && getSettings(db).kill_reason === "", "Resume (after an owner stop) cleared the switch");
  // breaker wording
  db.query("UPDATE settings SET value = '1' WHERE key = 'kill_switch'").run();
  db.query("UPDATE settings SET value = 'breaker' WHERE key = 'kill_reason'").run();
  await page.reload();
  await page.getByTestId("kill-banner").getByRole("button", { name: "Resume" }).click();
  await page.getByText(/a send failed; approved messages will continue, including a retry of the failed one/i).waitFor();
  ok(true, "the breaker's resume dialog says: a send failed; approved messages will continue, including a retry of the failed one");
  await page.getByTestId("resume-confirm").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="kill-banner"]'));

  // 10. re-approval after expiry
  await page.goto(`${B}/#/batch/${batchId}`);
  await page.getByRole("button", { name: "Approve 3" }).click();
  await page.getByTestId("manifest-list").waitFor();
  await page.getByRole("button", { name: "Approve with Touch ID" }).click();
  await page.getByTestId("approve-success").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  const second = db.query<any, []>("SELECT id FROM approvals WHERE revoked_at IS NULL").all();
  ok(second.length === 1, "a second live approval after the stop");
  db.query("UPDATE approvals SET not_after = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), second[0]!.id); // simulate expiry
  await page.reload();
  await page.locator("article[data-draft]").nth(3).waitFor();
  ok((await page.locator('article[data-status="approved"][data-covered="0"]').count()) === 2, "the two drafts whose approval expired show as approvable again (covered_by is null)");
  ok((await page.getByText("Approval ended").count()) === 2, "they say 'Approval ended'");
  const again = page.getByRole("button", { name: "Approve 3" });
  await again.waitFor();
  await again.click();
  await page.getByTestId("manifest-list").waitFor();
  ok((await page.locator('[data-testid="manifest-list"] > li').count()) === 2, "re-approval lists the two expired drafts (the flagged one is held back again)");
  await page.getByRole("button", { name: "Approve with Touch ID" }).click();
  await page.getByTestId("approve-success").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  const all = db.query<any, []>("SELECT id, revoked_at, not_after FROM approvals ORDER BY created_at").all();
  ok(all.length === 3 && all[0].revoked_at && !all[1].revoked_at && all[1].not_after < new Date().toISOString() && !all[2].revoked_at && all[2].not_after > new Date().toISOString(), "three approvals: stopped, expired, live");
  ok(getDrafts(db, batchId).map((d) => d.status).join() === "approved,approved,skipped,review", "drafts are approved under the new approval");
  const covered = await (await fetch(`${B}/api/batches/${batchId}`, { headers: { cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).json() as any;
  ok(covered.drafts[0].covered_by === all[2].id && covered.drafts[3].covered_by === null, "covered_by points at the live approval");

  // 11. the LIVE banner (transport live, pin not installed: the sheet must not claim it will send)
  db.query("UPDATE settings SET value = 'live' WHERE key = 'transport'").run();
  await page.goto(`${B}/#/batch/${batchId}`);
  await page.reload();
  await page.getByRole("button", { name: "Approve 1" }).click();
  await page.getByTestId("held-back").waitFor();
  await page.getByTestId("held-back").getByRole("switch").click();
  await page.getByTestId("live-banner").waitFor();
  const liveText = await page.getByTestId("live-banner").innerText();
  ok(liveText.includes("Live is on, but the installed pin doesn't allow it"), "LIVE with no live-allowed pin: the banner says the sender will not really send");
  ok((await page.getByTestId("sheet-sends").count()) === 0, "no 'Sends right away' claim while the pin doesn't allow live");
  await page.getByRole("button", { name: "Go back" }).click();
  // a pin that allows live (and still carries the old pacing fields, which must be ignored): the real LIVE state
  writeFileSync(paths.rootPinFile, JSON.stringify({ v: 2, rp_id: "localhost", origin: B, keys: [], policy: { live_allowed: true, min_pace_s: 20, min_burst_pause_s: 120, max_burst_size: 10, max_daily_cap: 100, require_quiet_hours: true } }));
  await page.reload();
  await page.getByRole("button", { name: "Approve 1" }).click();
  await page.getByTestId("held-back").waitFor();
  await page.getByTestId("held-back").getByRole("switch").click();
  await page.getByTestId("live-banner").waitFor();
  ok((await page.getByTestId("live-banner").innerText()).startsWith("LIVE"), "LIVE with a live-allowed pin: the banner says LIVE");
  await page.getByTestId("sheet-sends").waitFor();
  ok((await page.getByTestId("sheet-sends").innerText()).startsWith("Sends right away."), "the live sheet says 'Sends right away.'");
  ok(!/\b(estimate|finish\w*|quiet|daily cap|exceeds|pace[ds]?|scheduled)\b/i.test(await page.locator(".sheet").innerText()), "the live sheet has no timing text either");
  await shot("approve-sheet-live.png");
  await page.getByRole("button", { name: "Go back" }).click();
  rmSync(paths.rootPinFile, { force: true });
  db.query("UPDATE settings SET value = 'dry' WHERE key = 'transport'").run();

  // 12. exclude all with warnings (the flagged draft)
  await page.goto(`${B}/#/batch/${batchId}`);
  await page.reload();
  await page.getByTestId("exclude-warned").click();
  await page.waitForFunction(() => document.querySelectorAll('article[data-status="skipped"]').length === 2);
  ok(getDrafts(db, batchId).map((d) => d.status).join() === "approved,approved,skipped,skipped", "'Exclude all with warnings' skipped the flagged draft and left the approved ones alone");

  // 12b. chained messages: two messages to one person are ONE box with ONE switch; non-blocking warnings need no per-message action
  {
    const cb = createBatch(db, { title: "Invites with links", created_by: "agent:e2e", source: "mcp", status: "review" });
    const link = [{ code: "link_in_first_message", message: "A link in a first message to someone new is likely to be filtered as spam" }] as any;
    const mkc = (handle: string, name: string, body: string, warnings: any[] = []) => addDraft(db, cb, { handle, recipient_name: name, body, actor: "agent", warnings });
    const alice = [mkc("+12025550201", "Alice Chain", "Hi Alice, join us Saturday at 7?"), mkc("+12025550201", "Alice Chain", "https://example.com/rsvp/alice", link)];
    const bob = [mkc("+12025550202", "Bob Chain", "Hi Bob, join us Saturday at 7?"), mkc("+12025550202", "Bob Chain", "https://example.com/rsvp/bob", link)];
    const carol = mkc("+12025550203", "Carol Solo", "Hi Carol, join us?", [{ code: "recently_messaged", message: "Messaged 3 days ago" }]);
    setBatchStatus(db, cb, "review", "e2e");
    await page.goto(`${B}/#/batch/${cb}`);
    await page.reload();
    await page.locator("article.group").nth(1).waitFor();
    ok((await page.locator("article.group").count()) === 2 && (await page.locator("article.group[data-count=\"2\"]").count()) === 2, "two chains show as two bordered boxes of two messages each");
    ok((await page.locator("article.group [data-draft]").count()) === 4 && (await page.locator("article.draft[data-draft]").count()) === 1, "Carol (one message) keeps the plain card");
    const gA = page.locator("article.group").nth(0);
    ok((await gA.getByRole("switch").count()) === 1 && (await gA.getByText("Alice Chain").count()) >= 1, "a chain has exactly one Include switch, headed by the recipient");
    ok((await gA.getByTestId("recipient-handle").count()) === 1 && (await gA.locator("textarea").count()) === 2, "the recipient is named once and both messages are editable inside the box");
    ok((await gA.innerText()).includes("Has a link"), "the group header merges the messages' warning chips");
    await page.getByRole("button", { name: "Approve 5 messages to 3 people" }).waitFor();
    ok(true, "footer counts messages and people: Approve 5 messages to 3 people");
    await shot("chain-batch.png", { fullPage: true });
    // one switch skips both
    await gA.getByRole("switch").click();
    await page.waitForFunction(() => document.querySelectorAll('article.group [data-status="skipped"]').length === 2);
    ok(getDrafts(db, cb).filter((d) => d.status === "skipped").map((d) => d.id).sort().join() === alice.slice().sort().join(), "flipping Alice's one switch skipped both her messages");
    await page.getByRole("button", { name: "Approve 3 messages to 2 people" }).waitFor();
    ok(true, "footer follows: Approve 3 messages to 2 people");
    // a mixed state (made server-side) reads as off with a note, and flipping it on includes all
    db.query("UPDATE drafts SET status = 'review' WHERE id = ?").run(alice[0]!);
    await page.reload();
    await page.locator("article.group").nth(1).waitFor();
    ok((await page.getByTestId("group-mixed").count()) === 1 && (await page.locator("article.group").nth(0).getByRole("switch").getAttribute("aria-checked")) === "false", "a half-skipped chain shows as off with 'some messages are left out'");
    await page.locator("article.group").nth(0).getByRole("switch").click();
    await page.waitForFunction(() => document.querySelectorAll('article.group [data-status="skipped"]').length === 0);
    ok(getDrafts(db, cb).every((d) => d.status === "review"), "flipping a mixed chain on includes every message");
    // Skipped filter shows whole groups
    await page.locator("article.group").nth(0).getByRole("switch").click();
    await page.waitForFunction(() => document.querySelectorAll('article.group [data-status="skipped"]').length === 2);
    await page.locator('[data-filter="skipped"]').click();
    ok((await page.locator("article.group").count()) === 1 && (await page.locator("article.group [data-draft]").count()) === 2, "the Skipped filter shows the whole chain");
    await page.locator('[data-filter="all"]').click();
    await page.locator("article.group").nth(0).getByRole("switch").click();
    await page.waitForFunction(() => document.querySelectorAll('article.group [data-status="skipped"]').length === 0);
    // approve with only non-blocking warnings: nothing is held back, no per-message switches in the sheet
    await page.getByRole("button", { name: "Approve 5 messages to 3 people" }).click();
    const cl = page.getByTestId("manifest-list");
    await cl.waitFor();
    ok((await page.getByTestId("held-back").count()) === 0, "link and recently-messaged warnings hold nothing back");
    ok((await page.locator(".sheet").getByRole("switch").count()) === 0, "the sheet has no switch to tick: no per-message confirmation");
    ok((await page.locator('[data-testid="manifest-list"] > li').count()) === 3 && (await page.locator('[data-testid="manifest-list"] > li[data-count="2"]').count()) === 2, "the confirm sheet lists messages grouped by recipient (3 people)");
    const sum = await page.getByTestId("sheet-summary").innerText();
    ok(sum.includes("5 messages") && sum.includes("3 people"), "sheet summary counts messages and people");
    ok((await page.getByTestId("sheet-warnings").innerText()).includes("2 have a link") && (await page.getByTestId("sheet-warnings").innerText()).includes("1 messaged recently"), "warnings are one compact line by type with counts");
    await shot("chain-approve-sheet.png");
    await page.getByRole("button", { name: "Approve with Touch ID" }).click();
    await page.getByTestId("approve-success").waitFor({ timeout: 15000 });
    const capp = db.query<any, [string]>("SELECT manifest FROM approvals WHERE batch_id = ?").get(cb)!;
    ok(JSON.parse(capp.manifest).items.map((i: any) => i.draft_id).join() === [...alice, ...bob, carol].join(), "all 5 messages are in one signed manifest, in order, without any per-message action");
    await page.getByRole("button", { name: "Done" }).click();
  }

  // 13. v4 contact changes: Inbox card, diff, include toggles, Touch ID, tamper refusal, Stop, undo, reject, LIVE banner
  {
    const { proposeContactChanges, validateCreate, validateUpdate } = await import("../../src/core/contact-changes");
    const { getContact } = await import("../../src/core/store");
    const mk = (id: string, mac: string, given: string, family: string, phone: string) => {
      db.query("INSERT INTO contacts(id, source, macos_id, display_name, given_name, family_name, phones_json, updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, "macos", mac, `${given} ${family}`, given, family, JSON.stringify([{ e164: phone, label: "mobile" }]), new Date().toISOString());
      db.query("INSERT INTO contact_handles(handle, contact_id) VALUES (?,?)").run(phone, id);
    };
    mk("c-ann", "mac-ann", "Ann", "Lee", "+14155550101");
    mk("c-ben", "mac-ben", "Ben", "Roe", "+14155550102");
    const propose = (title: string, updates: [string, unknown][], creates: unknown[] = []) => proposeContactChanges(db, {
      title, created_by: "agent:e2e", source: "mcp", creates: creates.map((c) => validateCreate(c)),
      updates: updates.map(([id, u]) => ({ contact: getContact(db, id)!, payload: validateUpdate(u) })),
    });
    const setA = propose("Book club members", [["c-ann", { set: { given_name: "Ann \u{1F4DA}" }, add_groups: ["Book club"] }], ["c-ben", { set: { given_name: "Ben \u{1F4DA}" } }]],
      [{ given_name: "Newbie", family_name: "Club", phones: ["+14155550177"] }]);
    const [createId, annId, benId] = setA.changes.map((c) => c.id) as [string, string, string];
    const cstat = (id: string) => db.query<any, [string]>("SELECT status FROM contact_changes WHERE id = ?").get(id)!.status;
    const capprovals = () => db.query<any, []>("SELECT * FROM contact_approvals ORDER BY created_at").all();
    const cookieHdr = async () => (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

    // Inbox: the contact set is listed above the message batches
    await page.goto(`${B}/#/`);
    await page.reload();
    await page.getByTestId("contact-set-card").waitFor();
    ok((await page.locator(".section .card-link").first().getAttribute("data-testid")) === "contact-set-card", "the Inbox lists the contact set above the message batches");
    ok((await page.getByTestId("contact-set-card").innerText()).includes("2 to approve"), "the Inbox card says how many edits wait for approval");
    // Address book pages past 100 contacts: 230 extra people -> infinite scroll / "Show more", and search pages too
    {
      const ins = db.query("INSERT INTO contacts(id, source, display_name, given_name, family_name, phones_json, updated_at) VALUES (?,?,?,?,?,'[]',?)");
      db.transaction(() => { for (let i = 0; i < 230; i++) ins.run(`c-page-${i}`, "manual", `Pager ${String(i).padStart(3, "0")}`, "Pager", String(i), new Date().toISOString()); })();
      const total = db.query<any, []>("SELECT COUNT(*) AS n FROM contacts").get()!.n as number;
      const cards = page.getByTestId("contact-card");
      const more = page.getByTestId("show-more");
      const cardsReach = async (n: number, ms = 8000) => { const t = Date.now(); while ((await cards.count()) < n && Date.now() - t < ms) await page.waitForTimeout(100); return (await cards.count()) >= n; };
      await page.goto(`${B}/#/contacts`);
      await page.reload();
      await page.getByTestId("book-title").filter({ hasText: `Address book (${total})` }).waitFor();
      ok(await cardsReach(100), "the address book shows a first page of 100");
      // Scroll to the end until everyone is in (infinite scroll); tap the button if the observer hasn't fired.
      for (let i = 0; i < 15 && (await cards.count()) < total; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        if ((await cards.count()) < total && (await more.count()) === 1 && !(await more.isDisabled())) await more.click();
      }
      ok((await cards.count()) === total, `every contact is listed (${total}), not just the first 100`);
      ok((await more.count()) === 0, "'Show more' is gone once everyone is loaded");
      const names = await cards.locator("strong").allInnerTexts();
      ok(new Set(names).size === names.length, "no contact is listed twice");
      // search: its own count, and it pages too
      await page.getByRole("searchbox", { name: "Search contacts" }).fill("Pager");
      await page.getByTestId("book-title").filter({ hasText: "230 matches" }).waitFor();
      ok(await cardsReach(100) && (await cards.count()) === 100 && (await more.count()) === 1, "search says '230 matches', shows 100 and offers Show more");
      await more.click();
      ok(await cardsReach(200), "Show more appends the next 100 matches");
      await page.getByRole("searchbox", { name: "Search contacts" }).fill("Pager 007");
      await page.getByTestId("book-title").filter({ hasText: "1 match" }).waitFor();
      await page.waitForTimeout(300);
      ok((await cards.count()) === 1, "a narrower search replaces the list; nothing stale is appended");
      db.query("DELETE FROM contacts WHERE id LIKE 'c-page-%'").run();
    }
    // Contacts tab -> Changes
    await page.goto(`${B}/#/contacts`);
    await page.getByTestId("contacts-changes-tab").click();
    await page.getByTestId("contact-set-card").waitFor();
    ok(page.url().endsWith("#/contacts/changes"), "Contacts has a Changes tab at #/contacts/changes");
    await page.getByTestId("contact-set-card").click();
    await page.getByRole("heading", { name: "Book club members" }).waitFor();
    ok(page.url().endsWith(`#/contacts/changes/${setA.set_id}`), "the detail route is #/contacts/changes/<id>");
    await page.locator("article.change").nth(1).waitFor();
    const annCard = page.locator(`article.change[data-change="${annId}"]`);
    ok((await annCard.locator(".diff-row .from").first().innerText()) === "Ann" && (await annCard.locator(".diff-row .to").first().innerText()) === "Ann \u{1F4DA}", "the edit card shows before → after (Ann → Ann 📚)");
    ok((await annCard.innerText()).includes("+ Book club"), "the card lists the group it adds");
    ok((await page.locator("article.change").count()) === 2 && (await page.locator('.change-row[data-status="auto_queued"]').count()) === 1 && (await page.locator('.change-row[data-status="auto_queued"]').innerText()).includes("Newbie Club") && (await page.locator('.change-row[data-status="auto_queued"]').innerText()).includes("Adding automatically"), "the automatic create is listed as 'Adding automatically', not as something to approve");
    await shot("contact-changes.png", { fullPage: true });
    // include toggles drive the footer
    ok((await page.getByTestId("contacts-approve").innerText()) === "Approve 2 with Touch ID", "footer: Approve 2 with Touch ID");
    await page.locator(`article.change[data-change="${benId}"]`).getByRole("switch").click();
    ok((await page.getByTestId("contacts-approve").innerText()) === "Approve 1 with Touch ID", "excluding a card changes the footer to Approve 1");
    await page.locator(`article.change[data-change="${benId}"]`).getByRole("switch").click();
    ok((await page.getByTestId("contacts-approve").innerText()) === "Approve 2 with Touch ID", "including it again brings it back");

    // the confirm sheet: rendered from the manifest + payloads, dry banner
    await page.getByTestId("contacts-approve").click();
    await page.getByTestId("contacts-manifest-list").waitFor();
    ok((await page.getByTestId("contacts-dry-banner").count()) === 1, "dry run: the sheet says Contacts are not touched");
    ok((await page.locator('[data-testid="contacts-manifest-list"] > li').count()) === 2, "the sheet lists exactly the two items being signed");
    const sheetText = await page.locator(".sheet").innerText();
    ok(sheetText.includes("Ann \u{1F4DA}") && sheetText.includes("Ben \u{1F4DA}") && sheetText.includes("Book club") && sheetText.includes("Ann Lee"), "the sheet shows each contact's name and what changes");
    await shot("contact-approve-sheet.png");
    // TAMPER: a payload changes under the open sheet -> refused, nothing recorded
    const benPayload = db.query<any, [string]>("SELECT payload_json FROM contact_changes WHERE id = ?").get(benId)!.payload_json;
    db.query("UPDATE contact_changes SET payload_json = ? WHERE id = ?").run(JSON.stringify({ set: { given_name: "Ben \u{1F4DA}" }, add_phones: [{ e164: "+15550009999", label: "mobile" }] }), benId);
    await page.getByTestId("contacts-sign").click();
    await page.locator(".sheet .note-bad").waitFor({ timeout: 15000 });
    ok((await page.locator(".sheet .note-bad").innerText()).includes("Nothing was approved"), "a payload edited under the open sheet is refused with 'Nothing was approved'");
    ok(capprovals().length === 0 && cstat(annId) === "review" && cstat(benId) === "review", "the refused approval recorded nothing and left both changes in review");
    db.query("UPDATE contact_changes SET payload_json = ? WHERE id = ?").run(benPayload, benId);
    await page.getByRole("button", { name: "Start again" }).click();
    await page.getByTestId("contacts-manifest-list").waitFor();
    await page.getByTestId("contacts-sign").click();
    await page.getByTestId("contacts-approve-success").waitFor({ timeout: 15000 });
    ok((await page.getByTestId("contacts-approve-success").innerText()).includes("2 changes approved"), "Touch ID approved the two edits");
    const ca = capprovals();
    ok(ca.length === 1 && ca[0].set_id === setA.set_id, "exactly one contact_approvals row, for the set");
    const cm = JSON.parse(ca[0].manifest);
    ok(cm.kind === "contacts" && cm.v === 1 && cm.transport === "dry" && cm.contact_items.length === 2 && cm.set_id === setA.set_id && ca[0].credential_id === approveKey.credential_id, "stored manifest: kind contacts, v1, dry, two items, signed by the approval key");
    ok(cm.contact_items.every((it: any) => it.kind === "update" && it.target_macos_id.startsWith("mac-")
      && it.payload_sha256 === sha(db.query<any, [string]>("SELECT payload_json FROM contact_changes WHERE id = ?").get(it.change_id)!.payload_json)), "each manifest item pins the target and sha256(payload_json)");
    const cAuth = Buffer.from(ca[0].authenticator_data_b64, "base64url"), cCdj = Buffer.from(ca[0].client_data_json_b64, "base64url");
    ok(verify("sha256", Buffer.concat([cAuth, createHash("sha256").update(cCdj).digest()]), pub, Buffer.from(ca[0].signature_b64, "base64url"))
      && JSON.parse(cCdj.toString()).challenge === createHash("sha256").update(ca[0].manifest).digest("base64url"), "the contacts signature verifies under the pinned approval key and signs sha256(manifest bytes)");
    ok(cstat(annId) === "approved" && cstat(benId) === "approved" && cstat(createId) === "auto_queued", "edits are approved; the automatic create is untouched");
    ok(db.query<any, []>("SELECT COUNT(*) n FROM approvals WHERE batch_id = '" + setA.set_id + "'").get()!.n === 0, "no send-approval row was made");
    await page.getByTestId("contacts-done").click();
    await page.getByText(/Waiting to apply/).waitFor();

    // Stop revokes the contacts approval; undo-stop restores it
    const msgLive = db.query<any, []>("SELECT COUNT(*) n FROM approvals WHERE revoked_at IS NULL").get()!.n;
    await page.getByTestId("stop-open").click();
    await page.getByTestId("stop-confirm").click();
    await page.getByTestId("kill-banner").waitFor();
    ok((await page.getByTestId("toast").innerText()).includes(`Stopped. ${msgLive + 1} approvals cancelled`), "Stop's toast counts the message approvals and the contacts approval");
    ok(!!capprovals()[0].revoked_at && cstat(annId) === "review" && cstat(benId) === "review", "Stop revoked the contacts approval and sent its changes back to review");
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
    await page.getByText(/Stop undone/).waitFor();
    ok(capprovals()[0].revoked_at === null && cstat(annId) === "approved" && cstat(benId) === "approved", "Undo-stop restored the contacts approval and its changes");
    {
      const held = db.query<any, [string]>("SELECT status, requires_approval, note FROM contact_changes WHERE id = ?").get(createId)!;
      ok(held.status === "review" && held.requires_approval === 1 && held.note === "held by Stop", "Stop held the queued auto create for the owner's approval, and Undo-stop did not put it back");
    }

    // the executor applies Ann's edit (simulated): History offers Undo, which makes an undo set to approve with Touch ID
    const t = new Date().toISOString();
    db.query("UPDATE contact_changes SET status = 'applied', transport = 'live', after_fingerprint = ?, before_vcard = 'BEGIN:VCARD', applied_at = ? WHERE id = ?").run("a".repeat(64), t, annId);
    db.query("INSERT INTO contact_applies(id, change_id, approval_id, transport, started_at, finished_at, result) VALUES ('ap-ann', ?, ?, 'live', ?, ?, 'applied')").run(annId, ca[0].id, t, t);
    await page.reload();
    await page.getByTestId("contact-history").waitFor();
    ok((await page.getByTestId("undo-change").count()) === 1, "History offers Undo on the applied change");
    await shot("contact-history.png", { fullPage: true });
    await page.getByTestId("undo-change").click();
    await page.getByRole("heading", { name: /^Undo: Book club members/ }).waitFor();
    const undoRow = db.query<any, []>("SELECT * FROM contact_changes WHERE kind = 'undo'").get()!;
    ok(undoRow.status === "review" && undoRow.undo_of === annId && undoRow.target_macos_id === "mac-ann" && JSON.parse(undoRow.payload_json).before_vcard_sha256 === sha("BEGIN:VCARD"), "Undo made a kind='undo' change in review, bound to the snapshot");
    ok(cstat(annId) === "applied", "asking for an undo changed nothing by itself");
    // The original went in LIVE, so its undo has to be signed live too, which needs the installed pin's contacts_live_allowed.
    await page.getByTestId("contacts-approve").click();
    await page.getByText(/undoes changes that were made live/).waitFor();
    ok((await page.getByRole("button", { name: "Start again" }).count()) === 1 && (await page.getByTestId("contacts-sign").count()) === 0, "an undo of a live change is refused in the sheet while the pin doesn't allow live contact changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    writeFileSync(paths.rootPinFile, JSON.stringify({ v: 2, rp_id: "localhost", origin: B, keys: [], policy: { live_allowed: false, contacts_live_allowed: true } }));
    await page.reload();
    await page.getByTestId("contacts-approve").click();
    await page.getByTestId("contacts-manifest-list").waitFor();
    ok((await page.getByTestId("contacts-live-banner").innerText()).includes("LIVE") && (await page.getByTestId("contacts-live-banner").innerText()).includes("undoes changes that were made live"), "the undo sheet says LIVE and why: it undoes changes that were made live");
    ok((await page.locator('[data-testid="contacts-manifest-list"] li[data-kind="undo"]').count()) === 1, "the undo is approved through the same Touch ID sheet");
    await page.getByTestId("contacts-sign").click();
    await page.getByTestId("contacts-approve-success").waitFor({ timeout: 15000 });
    await page.getByTestId("contacts-done").click();
    const ca2 = capprovals();
    ok(ca2.length === 2 && JSON.parse(ca2[1].manifest).contact_items[0].kind === "undo" && cstat(undoRow.id) === "approved", "a second contact_approvals row carries the undo item");
    ok(JSON.parse(ca2[1].manifest).transport === "live", "...signed live although the contacts_transport setting is dry");
    rmSync(paths.rootPinFile, { force: true });

    // reject
    const setB = propose("Reject me", [["c-ann", { set: { org: "Acme" } }]]);
    await page.goto(`${B}/#/contacts/changes/${setB.set_id}`);
    await page.getByTestId("reject-change").click();
    await page.getByText(/1 change rejected/).waitFor();
    ok(cstat(setB.changes[0]!.id) === "rejected", "Reject moves a change to rejected");

    // LIVE banner for contacts: transport live, pin without / with contacts_live_allowed
    const setC = propose("Live check", [["c-ben", { set: { org: "Book club" } }]]);
    db.query("UPDATE settings SET value = 'live' WHERE key = 'contacts_transport'").run();
    await page.goto(`${B}/#/contacts/changes/${setC.set_id}`);
    await page.reload();
    await page.getByTestId("contacts-approve").click();
    await page.getByTestId("contacts-live-banner").waitFor();
    ok((await page.getByTestId("contacts-live-banner").innerText()).includes("Live is on, but the installed pin doesn't allow it"), "contacts LIVE with no contacts_live_allowed pin: the banner says the sender will only log");
    await page.getByRole("button", { name: "Go back" }).click();
    writeFileSync(paths.rootPinFile, JSON.stringify({ v: 2, rp_id: "localhost", origin: B, keys: [], policy: { live_allowed: false, contacts_live_allowed: true } }));
    await page.reload();
    await page.getByTestId("contacts-approve").click();
    await page.getByTestId("contacts-live-banner").waitFor();
    ok((await page.getByTestId("contacts-live-banner").innerText()).startsWith("LIVE"), "contacts LIVE with a contacts_live_allowed pin: the banner says LIVE");
    ok((await page.getByTestId("contacts-live-banner").innerText()).includes("will really edit your Contacts"), "...and says these will really edit Contacts");
    await shot("contact-approve-sheet-live.png");
    await page.getByRole("button", { name: "Go back" }).click();
    const st = await (await fetch(`${B}/api/status`, { headers: { cookie: await cookieHdr() } })).json() as any;
    ok(st.contacts_transport === "live" && st.pin_contacts_live_allowed === true, "/api/status reports contacts_transport and pin_contacts_live_allowed");
    rmSync(paths.rootPinFile, { force: true });
    db.query("UPDATE settings SET value = 'dry' WHERE key = 'contacts_transport'").run();
  }
} catch (e) {
  failed = true;
  console.error(String((e as Error).stack ?? e));
} finally {
  await browser.close().catch(() => {});
  server.stop(true);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
}
console.log(results.join("\n"));
console.log(failed ? "\nE2E FAILED" : `\nE2E PASSED (${results.length} checks)`);
process.exit(failed ? 1 : 0);
