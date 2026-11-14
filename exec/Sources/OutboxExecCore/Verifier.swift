import Foundation
import CryptoKit

/// A reason string for any rejection. Every parse failure becomes one of these; nothing is ever "best effort".
public struct Rejection: Error, CustomStringConvertible {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
    public var description: String { reason }
}

public struct ApprovalRecord {
    public var id: String
    public var batchId: String
    public var manifest: String
    public var manifestSha256: String
    public var credentialId: String
    public var authenticatorDataB64: String
    public var clientDataJSONB64: String
    public var signatureB64: String
    public var notAfter: String
    public var revokedAt: String?
    public var createdAt: String

    public init(row: Row) {
        id = row.str("id"); batchId = row.str("batch_id"); manifest = row.str("manifest")
        manifestSha256 = row.str("manifest_sha256"); credentialId = row.str("credential_id")
        authenticatorDataB64 = row.str("authenticator_data_b64"); clientDataJSONB64 = row.str("client_data_json_b64")
        signatureB64 = row.str("signature_b64"); notAfter = row.str("not_after"); revokedAt = row.text("revoked_at")
        createdAt = row.str("created_at")
    }
}

public struct ProposedContactModel {
    public var givenName = "", familyName = "", org = "", note = ""
    public var phones: [(value: String, label: String)] = []
    public var emails: [(value: String, label: String)] = []
    public var raw: [String: Any] = [:]
}

public struct ManifestItemModel {
    public let draftId: String
    public let to: String
    public let service: String
    public let bodySha256: String
    public let name: String
    public let createContact: ProposedContactModel?
}

public struct VerifiedApproval {
    /// The transport the user signed ("dry" | "live"). It alone decides dry versus live for this approval.
    public let transport: String
    public let approvalId: String
    public let batchId: String
    public let notAfter: Date
    public let credentialLabel: String
    public let items: [ManifestItemModel]
}

public struct DraftSnapshot {
    public var id: String, batchId: String, handle: String, service: String, body: String, status: String
    public var createContact: Bool
    public init(row: Row) {
        id = row.str("id"); batchId = row.str("batch_id"); handle = row.str("handle"); service = row.str("service")
        body = row.str("body"); status = row.str("status"); createContact = row.i("create_contact") == 1
    }
}

public enum Verifier {
    static let services: Set<String> = ["iMessage", "SMS", "auto"]

    /// The part of verification shared by send and contacts approvals: stored fields decode, the assertion is bound to the manifest
    /// bytes, origin / rp_id / UP / UV, the signature verifies against a pinned approve-purpose key, not revoked. Returns the parsed
    /// manifest object (only after the signature held, so its bytes are authentic) and the row's expiry. Each caller then checks
    /// the manifest's own fields, including which KIND of manifest it is.
    struct Envelope {
        let manifest: [String: Any]
        let key: PinKey
        let columnExpiry: Date
    }

    static func verifyEnvelope(manifest: String, manifestSha256: String, credentialId: String, authenticatorDataB64: String, clientDataJSONB64: String,
                               signatureB64: String, notAfter: String, revokedAt: String?, pin: PinFile) throws -> Envelope {
        // 1. decode the stored fields
        guard let authData = B64.decodeURL(authenticatorDataB64) else { throw Rejection("authenticator_data is not valid base64url") }
        guard let cdj = B64.decodeURL(clientDataJSONB64) else { throw Rejection("client_data_json is not valid base64url") }
        guard let sigDER = B64.decodeURL(signatureB64) else { throw Rejection("signature is not valid base64url") }
        guard B64.decodeURL(credentialId) != nil else { throw Rejection("credential_id is not valid base64url") }
        let manifestBytes = Data(manifest.utf8)
        let manifestHash = Hex.sha256(manifestBytes)

        // 2. the stored hash column is advisory, but a mismatch means someone touched the row
        if manifestSha256.lowercased() != Hex.encode(manifestHash) { throw Rejection("manifest_sha256 column does not match the manifest bytes") }

        // 3. clientDataJSON: parsed as JSON, then type / challenge / origin
        guard let client = JSON.object(cdj) else { throw Rejection("clientDataJSON is not a JSON object") }
        guard let type = client["type"] as? String else { throw Rejection("clientDataJSON.type missing") }
        guard type == "webauthn.get" else { throw Rejection("clientDataJSON.type is \(type), expected webauthn.get") }
        guard let challenge = client["challenge"] as? String else { throw Rejection("clientDataJSON.challenge missing") }
        guard let challengeBytes = B64.decodeURL(challenge) else { throw Rejection("clientDataJSON.challenge is not valid base64url") }
        guard challengeBytes == manifestHash else { throw Rejection("challenge does not equal sha256(manifest)") }
        guard let origin = client["origin"] as? String else { throw Rejection("clientDataJSON.origin missing") }
        guard origin == pin.origin else { throw Rejection("origin \(origin) does not match pinned origin \(pin.origin)") }
        if let cross = client["crossOrigin"] {
            guard let b = cross as? Bool, b == false else { throw Rejection("clientDataJSON.crossOrigin is set") }
        }

        // 4. authenticatorData: rpIdHash + flags
        guard authData.count >= 37 else { throw Rejection("authenticatorData too short (\(authData.count) bytes)") }
        let rpHash = authData.prefix(32)
        guard Data(rpHash) == Hex.sha256(Data(pin.rpId.utf8)) else { throw Rejection("rpIdHash does not match sha256(pinned rp_id)") }
        let flags = authData[authData.startIndex + 32]
        guard flags & 0x01 != 0 else { throw Rejection("user-presence (UP) flag not set") }
        guard flags & 0x04 != 0 else { throw Rejection("user-verification (UV) flag not set") }

        // 5. pinned credential + signature over authData || sha256(clientDataJSON)
        guard let key = pin.key(forCredentialId: credentialId) else { throw Rejection("credential_id is not in the pin file") }
        let signature: P256.Signing.ECDSASignature
        do { signature = try P256.Signing.ECDSASignature(derRepresentation: sigDER) } catch { throw Rejection("signature is not a valid DER ECDSA signature") }
        var signed = Data(authData)
        signed.append(Hex.sha256(cdj))
        guard key.publicKey.isValidSignature(signature, for: signed) else { throw Rejection("signature does not verify against the pinned key") }

        // 6. time and revocation
        if let r = revokedAt, !r.isEmpty { throw Rejection("approval revoked at \(r)") }
        guard let columnExpiry = Time.parse(notAfter) else { throw Rejection("not_after is not a valid timestamp") }

        // 7. manifest parse (after the signature: the bytes are now authentic)
        guard let m = JSON.object(manifestBytes) else { throw Rejection("manifest is not a JSON object") }
        return Envelope(manifest: m, key: key, columnExpiry: columnExpiry)
    }

    /// Approval-level verification of a SEND approval: assertion, signature, pinned key, expiry, revocation, manifest binding.
    /// Throws `Rejection` with a reason on any failure. A manifest that carries a `kind` (a contacts manifest) is never a send approval.
    public static func verifyApproval(_ a: ApprovalRecord, pin: PinFile, now: Date) throws -> VerifiedApproval {
        let env = try verifyEnvelope(manifest: a.manifest, manifestSha256: a.manifestSha256, credentialId: a.credentialId, authenticatorDataB64: a.authenticatorDataB64,
                                     clientDataJSONB64: a.clientDataJSONB64, signatureB64: a.signatureB64, notAfter: a.notAfter, revokedAt: a.revokedAt, pin: pin)
        let m = env.manifest
        let key = env.key
        let columnExpiry = env.columnExpiry
        // domain separation: send manifests have no `kind`, and always have items
        if let k = m["kind"] { throw Rejection("manifest has a kind (\(k)): not a send manifest") }
        guard m["items"] != nil else { throw Rejection("manifest has no items: not a send manifest") }
        guard let vNum = m["v"] as? NSNumber, CFGetTypeID(vNum) != CFBooleanGetTypeID(), vNum.intValue == 2 else { throw Rejection("manifest.v is not 2") }
        guard let mTransport = m["transport"] as? String, mTransport == "dry" || mTransport == "live" else { throw Rejection("manifest.transport is missing or not \"dry\" / \"live\"") }
        if mTransport == "live" {
            guard pin.trustedForLive else { throw Rejection("live approval, but the pin file in use is not trusted for live sending (\(pin.mode.rawValue) mode)") }
            guard pin.version >= 2, pin.policy.liveAllowed else { throw Rejection("live approval, but the pin policy does not allow live sending in \(pin.mode.rawValue) mode (live_allowed is false)") }
        }
        guard let mApproval = m["approval_id"] as? String, mApproval == a.id else { throw Rejection("manifest.approval_id does not match the approval row") }
        guard let mBatch = m["batch_id"] as? String, mBatch == a.batchId else { throw Rejection("manifest.batch_id does not match approvals.batch_id") }
        guard let mNotAfterStr = m["not_after"] as? String, let manifestExpiry = Time.parse(mNotAfterStr) else { throw Rejection("manifest.not_after missing or invalid") }
        guard let mRp = m["rp_id"] as? String, mRp == pin.rpId else { throw Rejection("manifest.rp_id does not match the pinned rp_id") }
        if let mo = m["origin"] { guard let s = mo as? String, s == pin.origin else { throw Rejection("manifest.origin does not match the pinned origin") } }
        let notAfter = min(columnExpiry, manifestExpiry)
        guard now < notAfter else { throw Rejection("approval expired at \(Time.iso(notAfter))") }
        guard let rawItems = m["items"] as? [Any], !rawItems.isEmpty else { throw Rejection("manifest.items missing or empty") }
        var items: [ManifestItemModel] = []
        var seen = Set<String>()
        for (i, any) in rawItems.enumerated() {
            guard let o = any as? [String: Any] else { throw Rejection("manifest.items[\(i)] is not an object") }
            guard let did = o["draft_id"] as? String, !did.isEmpty else { throw Rejection("manifest.items[\(i)].draft_id missing") }
            guard seen.insert(did).inserted else { throw Rejection("manifest lists draft \(did) twice") }
            guard let to = o["to"] as? String, !to.isEmpty else { throw Rejection("manifest.items[\(i)].to missing") }
            guard let svc = o["service"] as? String, services.contains(svc) else { throw Rejection("manifest.items[\(i)].service invalid") }
            guard let h = o["body_sha256"] as? String, h.count == 64, h.allSatisfy({ $0.isHexDigit }) else { throw Rejection("manifest.items[\(i)].body_sha256 invalid") }
            let name = (o["name"] as? String) ?? ""
            var cc: ProposedContactModel?
            if let ccAny = o["create_contact"], !(ccAny is NSNull) {
                guard let co = ccAny as? [String: Any] else { throw Rejection("manifest.items[\(i)].create_contact is not an object") }
                cc = try parseContact(co, i)
            }
            items.append(ManifestItemModel(draftId: did, to: to, service: svc, bodySha256: h.lowercased(), name: name, createContact: cc))
        }
        return VerifiedApproval(transport: mTransport, approvalId: a.id, batchId: a.batchId, notAfter: notAfter, credentialLabel: key.label, items: items)
    }

    static func parseContact(_ o: [String: Any], _ i: Int) throws -> ProposedContactModel {
        var c = ProposedContactModel()
        c.raw = o
        c.givenName = (o["given_name"] as? String) ?? ""
        c.familyName = (o["family_name"] as? String) ?? ""
        c.org = (o["org"] as? String) ?? ""
        c.note = (o["note"] as? String) ?? ""
        if let ph = o["phones"] {
            guard let arr = ph as? [[String: Any]] else { throw Rejection("manifest.items[\(i)].create_contact.phones malformed") }
            for p in arr {
                guard let e = p["e164"] as? String else { throw Rejection("manifest.items[\(i)].create_contact phone without e164") }
                c.phones.append((e, (p["label"] as? String) ?? "mobile"))
            }
        }
        if let em = o["emails"] {
            guard let arr = em as? [[String: Any]] else { throw Rejection("manifest.items[\(i)].create_contact.emails malformed") }
            for p in arr {
                guard let e = p["email"] as? String else { throw Rejection("manifest.items[\(i)].create_contact email without address") }
                c.emails.append((e, (p["label"] as? String) ?? "home"))
            }
        }
        return c
    }

    /// Item-level check against the current draft row. Returns nil when the draft matches, else the reason.
    public static func checkItem(_ item: ManifestItemModel, draft: DraftSnapshot?, batchId: String) -> String? {
        guard let d = draft else { return "draft \(item.draftId) does not exist" }
        if d.batchId != batchId { return "draft \(item.draftId) is not in batch \(batchId)" }
        if d.handle != item.to { return "handle changed since approval" }
        if d.service != item.service { return "service changed since approval" }
        if Hex.sha256Hex(d.body) != item.bodySha256 { return "body changed since approval (sha256 mismatch)" }
        if let c = item.createContact, let why = checkProposedContact(c, to: item.to) { return "proposed contact refused: \(why)" }
        return nil
    }

    /// A contact created on approval must carry exactly one handle and it must be the draft's own handle: one phone whose
    /// e164 equals `to` and no emails, or one email equal to `to` and no phones. Otherwise an approval could plant someone
    /// else's number under a trusted name.
    public static func checkProposedContact(_ c: ProposedContactModel, to: String) -> String? {
        if c.phones.count + c.emails.count != 1 { return "must have exactly one handle (has \(c.phones.count) phone(s) and \(c.emails.count) email(s))" }
        if let p = c.phones.first { return p.value == to ? nil : "its phone is not the message recipient" }
        if let e = c.emails.first { return e.value.lowercased() == to.lowercased() ? nil : "its email is not the message recipient" }
        return nil
    }
}

// MARK: contacts approvals (v4)

public struct ContactApprovalRecord {
    public var id: String
    public var setId: String
    public var manifest: String
    public var manifestSha256: String
    public var credentialId: String
    public var authenticatorDataB64: String
    public var clientDataJSONB64: String
    public var signatureB64: String
    public var notAfter: String
    public var revokedAt: String?
    public var createdAt: String

    public init(row: Row) {
        id = row.str("id"); setId = row.str("set_id"); manifest = row.str("manifest")
        manifestSha256 = row.str("manifest_sha256"); credentialId = row.str("credential_id")
        authenticatorDataB64 = row.str("authenticator_data_b64"); clientDataJSONB64 = row.str("client_data_json_b64")
        signatureB64 = row.str("signature_b64"); notAfter = row.str("not_after"); revokedAt = row.text("revoked_at")
        createdAt = row.str("created_at")
    }
}

public struct ContactItemModel {
    public let changeId: String
    public let kind: String
    public let targetMacosId: String?
    public let payloadSha256: String
}

public struct VerifiedContactApproval {
    /// What the user signed ("dry" | "live"). It becomes the live lane only if the trusted pin also has contacts_live_allowed.
    public let transport: String
    public let approvalId: String
    public let setId: String
    public let notAfter: Date
    public let credentialLabel: String
    public let items: [ContactItemModel]
}

extension Verifier {
    /// Verifies a contacts approval: the same crypto as a send approval, then the manifest's own fields. `kind` must be "contacts"
    /// and `v` 1; a send manifest (v 2, no kind) is refused here exactly as a contacts manifest is refused on the send path.
    /// Unlike a send approval, a "live" manifest on a pin without contacts_live_allowed is NOT refused: it is applied dry (the
    /// caller decides the lane with `contactsLane`).
    public static func verifyContactApproval(_ a: ContactApprovalRecord, pin: PinFile, now: Date) throws -> VerifiedContactApproval {
        let env = try verifyEnvelope(manifest: a.manifest, manifestSha256: a.manifestSha256, credentialId: a.credentialId, authenticatorDataB64: a.authenticatorDataB64,
                                     clientDataJSONB64: a.clientDataJSONB64, signatureB64: a.signatureB64, notAfter: a.notAfter, revokedAt: a.revokedAt, pin: pin)
        let m = env.manifest
        guard let kind = m["kind"] as? String, kind == "contacts" else { throw Rejection("manifest.kind is not \"contacts\": not a contacts manifest") }
        guard let vNum = m["v"] as? NSNumber, CFGetTypeID(vNum) != CFBooleanGetTypeID(), vNum.intValue == 1 else { throw Rejection("manifest.v is not 1") }
        guard let mTransport = m["transport"] as? String, mTransport == "dry" || mTransport == "live" else { throw Rejection("manifest.transport is missing or not \"dry\" / \"live\"") }
        guard let mApproval = m["approval_id"] as? String, mApproval == a.id else { throw Rejection("manifest.approval_id does not match the approval row") }
        guard let mSet = m["set_id"] as? String, mSet == a.setId else { throw Rejection("manifest.set_id does not match contact_approvals.set_id") }
        guard let mNotAfterStr = m["not_after"] as? String, let manifestExpiry = Time.parse(mNotAfterStr) else { throw Rejection("manifest.not_after missing or invalid") }
        guard let mRp = m["rp_id"] as? String, mRp == pin.rpId else { throw Rejection("manifest.rp_id does not match the pinned rp_id") }
        guard let mo = m["origin"] as? String, mo == pin.origin else { throw Rejection("manifest.origin missing or not the pinned origin") }
        let notAfter = min(env.columnExpiry, manifestExpiry)
        guard now < notAfter else { throw Rejection("approval expired at \(Time.iso(notAfter))") }
        guard let raw = m["contact_items"] as? [Any], !raw.isEmpty else { throw Rejection("manifest.contact_items missing or empty") }
        var items: [ContactItemModel] = []
        var seen = Set<String>()
        for (i, any) in raw.enumerated() {
            guard let o = any as? [String: Any] else { throw Rejection("manifest.contact_items[\(i)] is not an object") }
            guard let cid = o["change_id"] as? String, !cid.isEmpty else { throw Rejection("manifest.contact_items[\(i)].change_id missing") }
            guard seen.insert(cid).inserted else { throw Rejection("manifest lists change \(cid) twice") }
            guard let k = o["kind"] as? String, ["create", "update", "undo"].contains(k) else { throw Rejection("manifest.contact_items[\(i)].kind invalid") }
            var target: String?
            if let t = o["target_macos_id"], !(t is NSNull) {
                guard let ts = t as? String else { throw Rejection("manifest.contact_items[\(i)].target_macos_id is not a string") }
                target = ts
            }
            guard let h = o["payload_sha256"] as? String, h.count == 64, h.allSatisfy({ $0.isHexDigit }) else { throw Rejection("manifest.contact_items[\(i)].payload_sha256 invalid") }
            items.append(ContactItemModel(changeId: cid, kind: k, targetMacosId: target, payloadSha256: h.lowercased()))
        }
        return VerifiedContactApproval(transport: mTransport, approvalId: a.id, setId: a.setId, notAfter: notAfter, credentialLabel: env.key.label, items: items)
    }

    /// Live only when the user signed live AND the trusted pin allows contact changes live; otherwise dry.
    public static func contactsLane(signedTransport: String, pin: PinFile) -> String {
        signedTransport == "live" && pin.trustedForLive && pin.version >= 2 && pin.policy.contactsLiveAllowed ? "live" : "dry"
    }

    /// Item-level check against the current row: it exists in the signed set, same kind and target, same payload bytes, not consumed.
    /// Returns nil when the row matches, else the reason.
    public static func checkContactItem(_ item: ContactItemModel, row: Row?, setId: String, consumed: Bool) -> String? {
        guard let r = row else { return "change \(item.changeId) does not exist" }
        if r.str("set_id") != setId { return "change \(item.changeId) is not in set \(setId)" }
        if r.str("kind") != item.kind { return "kind changed since approval" }
        if r.text("target_macos_id") != item.targetMacosId { return "target contact changed since approval" }
        if Hex.sha256Hex(r.str("payload_json")) != item.payloadSha256 { return "payload changed since approval (sha256 mismatch)" }
        if consumed { return "change already applied" }
        return nil
    }
}
