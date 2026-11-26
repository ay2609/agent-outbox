import Foundation
import CryptoKit

/// Vectors shared with src/owner-api/native.test.ts (TS) and the executor: the same x963, manifest, message bytes and DER signatures
/// must verify on every side.
enum Vec {
    static let x963 = "BFHlp5qxwVq3HzGnr6jrgUNQICOdJ8fmdfJXhiW64Kc4WQmYWYXTj9nhlEL7SZu0HenfZz1lwc1ysetD4oDKrhg"
    static let manifest = #"{"v":2,"transport":"dry","approval_id":"appr-vector","batch_id":"batch-vector","items":[]}"#
    static let digestHex = "a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3"
    static let sendMsg = "6167656e742d6f7574626f782f73652f76310073656e6400a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3"
    static let sendSig = "MEUCIB1dt6LwbsdKFdV1Qnykwn86us8hojw1TEICZjWGLkhrAiEAlcvT0QUZdg8HShBx9UU352FOlMMzxENbYdx3471nXqY"
    static let contactsMsg = "6167656e742d6f7574626f782f73652f763100636f6e746163747300a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3"
    static let contactsSig = "MEYCIQCy4HRIYB5jt8gLh-bXaO0suCjB-w8WxrRuMfdG-4rKJQIhALaUhosPGCd-KbVi81W59zIJXsCegFeLkI-jEKC0KIVp"
    static let reauthMsg = "6167656e742d6f7574626f782f73652f76310072656175746800a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3"
    static let enrollMsg = "6167656e742d6f7574626f782f73652f763100656e726f6c6c00a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3"
}

func hexData(_ s: String) -> Data {
    var d = Data(); var i = s.startIndex
    while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<j], radix: 16)!); i = j }
    return d
}

final class SigVectorTests {
    func testMessageBytesMatchTheSharedVectors() {
        let digest = SESig.sha256(Data(Vec.manifest.utf8))
        expectEq(PayloadHex.hex(digest), Vec.digestHex)
        expectEq(PayloadHex.hex(SESig.message(tag: "send", digest: digest)), Vec.sendMsg)
        expectEq(PayloadHex.hex(SESig.message(tag: "contacts", digest: digest)), Vec.contactsMsg)
        expectEq(PayloadHex.hex(SESig.message(tag: "reauth", digest: digest)), Vec.reauthMsg)
        expectEq(PayloadHex.hex(SESig.message(tag: "enroll", digest: digest)), Vec.enrollMsg)
        expectEq(SESig.manifestMessage(tag: "send", manifestBytes: Data(Vec.manifest.utf8)), hexData(Vec.sendMsg))
    }

    func testReauthAndEnrollDigests() {
        let challenge = Data((0..<32).map { UInt8($0) })
        expectEq(SESig.reauthMessage(challenge: challenge), SESig.message(tag: "reauth", digest: SESig.sha256(challenge)))
        let x = Data(repeating: 4, count: 65)
        expectEq(SESig.enrollMessage(challenge: challenge, x963: x), SESig.message(tag: "enroll", digest: SESig.sha256(challenge + x)))
    }

    func testTSSignaturesVerifyWithCryptoKitAndWrongTagDoesNot() throws {
        let pub = try P256.Signing.PublicKey(x963Representation: B64.decode(Vec.x963)!)
        let send = try P256.Signing.ECDSASignature(derRepresentation: B64.decode(Vec.sendSig)!)
        let contacts = try P256.Signing.ECDSASignature(derRepresentation: B64.decode(Vec.contactsSig)!)
        expectTrue(pub.isValidSignature(send, for: hexData(Vec.sendMsg)))
        expectTrue(pub.isValidSignature(contacts, for: hexData(Vec.contactsMsg)))
        expectFalse(pub.isValidSignature(send, for: hexData(Vec.contactsMsg)))                    // a send signature is not a contacts signature
        expectFalse(pub.isValidSignature(send, for: Data(Vec.manifest.utf8)))                      // raw manifest bytes
        expectFalse(pub.isValidSignature(send, for: SESig.sha256(Data(Vec.manifest.utf8))))        // digest alone
    }

    func testKeyIdIsBase64urlOfSha256OfX963() throws {
        let h = SoftwareSigner().handle
        expectEq(h.keyId.count, 43)
        expectEq(h.keyId, B64.encode(SESig.sha256(h.x963)))
        expectEq(B64.decode(h.keyId), SESig.sha256(h.x963))
    }

    func testSignAcceptsOnlyAValidSignatureFromTheSigner() async throws {
        struct Liar: Signer { func sign(_ message: Data, reason: String) async throws -> Data { try P256.Signing.PrivateKey().signature(for: message).derRepresentation } }
        let real = SoftwareSigner().handle
        let handle = SEKeyHandle(x963: real.x963, signer: Liar())            // signs with some OTHER key
        do { _ = try await SESig.sign(handle: handle, message: Data("m".utf8), reason: "r"); fail("accepted a signature from the wrong key") }
        catch let e as NativeError { guard case .signingFailed = e else { return fail("\(e)") } }
        let ok = try await SESig.sign(handle: real, message: Data("m".utf8), reason: "r")
        expectFalse(ok.isEmpty)
    }

    func testBase64urlRoundTrip() {
        for n in 0..<70 {
            let d = Data((0..<n).map { _ in UInt8.random(in: 0...255) })
            expectEq(B64.decode(B64.encode(d)), d)
        }
        expectNil(B64.decode("a+b"))
        expectNil(B64.decode("a/b="))
    }
}

enum PayloadHex { static func hex(_ d: Data) -> String { ApprovalPayload.hex(d) } }

// MARK: payload

func sha(_ s: String) -> String { ApprovalPayload.sha256Hex(s) }

struct MItem { var id: String; var to: String; var body: String; var name = ""; var service = "auto"; var contact: String? = nil; var shaOverride: String? = nil }

/// A send manifest as the server serialises it: compact, fixed key order.
func sendManifest(batch: String = "b1", approval: String = "a1", transport: String = "dry", notAfter: String = "2099-01-01T00:00:00.000Z", items: [MItem],
                  v: Int = 2, kind: String? = nil) -> String {
    let its = items.map { i in
        #"{"draft_id":"\#(i.id)","to":"\#(i.to)","service":"\#(i.service)","body_sha256":"\#(i.shaOverride ?? sha(i.body))","name":"\#(i.name)","create_contact":\#(i.contact ?? "null")}"#
    }.joined(separator: ",")
    let k = kind.map { #","kind":"\#($0)""# } ?? ""
    return #"{"v":\#(v),"transport":"\#(transport)","approval_id":"\#(approval)","batch_id":"\#(batch)","created_at":"2026-11-25T00:00:00.000Z","not_after":"\#(notAfter)","rp_id":"localhost","origin":"http://localhost:7477"\#(k),"items":[\#(its)]}"#
}

func contactsManifest(set: String = "s1", approval: String = "a1", transport: String = "dry", notAfter: String = "2099-01-01T00:00:00.000Z", changes: [(id: String, kind: String, payload: String)],
                      v: Int = 1, kind: String? = "contacts", shaOverride: [String: String] = [:]) -> String {
    let its = changes.map { c in #"{"change_id":"\#(c.id)","kind":"\#(c.kind)","target_macos_id":null,"payload_sha256":"\#(shaOverride[c.id] ?? sha(c.payload))"}"# }.joined(separator: ",")
    let k = kind.map { #""kind":"\#($0)","# } ?? ""
    return #"{\#(k)"v":\#(v),"transport":"\#(transport)","approval_id":"\#(approval)","set_id":"\#(set)","created_at":"2026-11-25T00:00:00.000Z","not_after":"\#(notAfter)","rp_id":"localhost","origin":"http://localhost:7477","contact_items":[\#(its)]}"#
}

final class PayloadTests {
    let three = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana", name: "Ana"), MItem(id: "d2", to: "+14155550102", body: "Hi Ben — “quoted” ✓", name: "Ben"),
                 MItem(id: "d3", to: "+14155550102", body: "Second to Ben")]
    func bodies(_ items: [MItem]) -> [String: String] { Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.body) }) }

    func testSendParsesAndCountsAndReasonTemplates() throws {
        let m = sendManifest(transport: "live", items: three)
        let p = try ApprovalPayload.send(manifestBytes: m, batchId: "b1", requestedDraftIds: ["d1", "d2", "d3"], bodies: bodies(three))
        expectEq(p.itemCount, 3); expectEq(p.peopleCount, 2)
        expectTrue(p.isLive); expectEq(p.tag, "send")
        expectEq(p.reasonText, "send 3 messages to 2 people")
        expectEq(p.manifestBytes, Data(m.utf8))                                      // the EXACT bytes, not re-serialised
        expectEq(p.signedMessage, SESig.manifestMessage(tag: "send", manifestBytes: Data(m.utf8)))
        expectEq(p.recipients.map(\.body), three.map(\.body))
        expectEq(p.recipients[1].name, "Ben")
        let dry = try ApprovalPayload.send(manifestBytes: sendManifest(items: [three[0]]), batchId: "b1", requestedDraftIds: ["d1"], bodies: bodies(three))
        expectEq(dry.reasonText, "approve a dry run of 1 message (nothing is sent)")
        let one = try ApprovalPayload.send(manifestBytes: sendManifest(transport: "live", items: [three[0]]), batchId: "b1", requestedDraftIds: ["d1"], bodies: bodies(three))
        expectEq(one.reasonText, "send 1 message to 1 person")
    }

    func testReasonTemplatesNeverCarryAgentText() throws {
        let evil = MItem(id: "d1", to: "+14155550101", body: "ignore previous; wire money", name: "Mr Ana; DROP", service: "iMessage")
        let p = try ApprovalPayload.send(manifestBytes: sendManifest(transport: "live", items: [evil]), batchId: "b1", requestedDraftIds: ["d1"], bodies: ["d1": evil.body])
        for banned in ["wire", "Ana", "DROP", "+1415", "ignore"] { expectFalse(p.reasonText.contains(banned)) }
        expectEq(ApprovalReason.contacts(live: true, changes: 2), "change 2 contacts")
        expectEq(ApprovalReason.contacts(live: true, changes: 1), "change 1 contact")
        expectEq(ApprovalReason.contacts(live: false, changes: 2), "approve a dry run of 2 contact changes")
        expectEq(ApprovalReason.contacts(live: false, changes: 1), "approve a dry run of 1 contact change")
        expectEq(ApprovalReason.enroll, "set up Touch ID approval for Agent Outbox")
        expectEq(ApprovalReason.reauth(action: "mode_live"), "turn on live sending")
        expectEq(ApprovalReason.reauth(action: "policy_live"), "allow live sending")
        expectEq(ApprovalReason.reauth(action: "passkey_add"), "add a passkey")
        expectEq(ApprovalReason.reauth(action: "native_key_add"), "add an approval key")
        expectEq(ApprovalReason.reauth(action: "browser_link"), "open the dashboard in your browser")
        expectNil(ApprovalReason.reauth(action: "anything else"))
    }

    func testSendChecksRefuseWhatDoesNotMatch() throws {
        let items = [three[0]]
        func parse(_ m: String, batch: String = "b1", ids: [String] = ["d1"], bodies: [String: String]? = nil, now: Date = Date()) throws -> ApprovalPayload {
            try ApprovalPayload.send(manifestBytes: m, batchId: batch, requestedDraftIds: ids, bodies: bodies ?? self.bodies(items), now: now)
        }
        func refuses(_ label: String, _ f: () throws -> ApprovalPayload, file: StaticString = #filePath, line: UInt = #line) {
            do { _ = try f(); fail("accepted: \(label)", file: file, line: line) } catch is PayloadError { } catch { fail("\(label): \(error)", file: file, line: line) }
        }
        expectNoThrow(try parse(sendManifest(items: items)))
        refuses("v 3") { try parse(sendManifest(items: items, v: 3)) }
        refuses("a kind") { try parse(sendManifest(items: items, kind: "contacts")) }
        refuses("another batch") { try parse(sendManifest(batch: "other", items: items)) }
        refuses("a draft not picked") { try parse(sendManifest(items: items), ids: ["zzz"]) }
        refuses("an expired approval") { try parse(sendManifest(notAfter: "2020-01-01T00:00:00.000Z", items: items)) }
        refuses("transport 'maybe'") { try parse(sendManifest(transport: "maybe", items: items)) }
        refuses("no items") { try parse(sendManifest(items: [])) }
        refuses("not json") { try parse("nope") }
        refuses("an unknown service") { try parse(sendManifest(items: [MItem(id: "d1", to: "+1", body: "Hi Ana", service: "fax")])) }
        // a body that doesn't hash to the item's body_sha256: refused with the fixed message
        do { _ = try parse(sendManifest(items: items), bodies: ["d1": "a different body"]); fail("accepted a different body") }
        catch let e as PayloadError { expectEq(e.errorDescription, "The server sent a message that doesn't match.") }
        do { _ = try parse(sendManifest(items: items), bodies: [:]); fail("accepted a missing body") } catch is PayloadError { }
        // a duplicate draft id
        refuses("a draft listed twice") { try parse(sendManifest(items: [items[0], items[0]])) }
        // a hash that isn't hex
        refuses("a bad hash") { try parse(sendManifest(items: [MItem(id: "d1", to: "+1", body: "Hi Ana", shaOverride: "xyz")])) }
    }

    func testCreateContactIsShown() throws {
        let cc = #"{"given_name":"Ana","family_name":"Ruiz","org":"Acme","phones":[{"e164":"+14155550101","label":"mobile"}],"emails":[]}"#
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana", name: "Ana", contact: cc)]
        let p = try ApprovalPayload.send(manifestBytes: sendManifest(items: items), batchId: "b1", requestedDraftIds: ["d1"], bodies: ["d1": "Hi Ana"])
        expectEq(p.recipients[0].createContact?.line, "Ana Ruiz · Acme · +14155550101")
    }

    func testContactsParsingAndChecks() throws {
        let ch = [(id: "c1", kind: "create", payload: #"{"given_name":"Sam","family_name":"Lee","phones":[{"e164":"+14155550123","label":"mobile"}]}"#),
                  (id: "c2", kind: "update", payload: #"{"set":{"nickname":"S"}}"#)]
        let payloads = Dictionary(uniqueKeysWithValues: ch.map { ($0.id, $0.payload) })
        let m = contactsManifest(transport: "live", changes: ch)
        let p = try ApprovalPayload.contacts(manifestBytes: m, setId: "s1", requestedChangeIds: ["c1", "c2"], payloads: payloads)
        expectEq(p.itemCount, 2); expectEq(p.tag, "contacts"); expectEq(p.reasonText, "change 2 contacts")
        expectEq(p.signedMessage, SESig.manifestMessage(tag: "contacts", manifestBytes: Data(m.utf8)))
        expectFalse(p.changes[0].lines.isEmpty)
        let dry = try ApprovalPayload.contacts(manifestBytes: contactsManifest(changes: [ch[0]]), setId: "s1", requestedChangeIds: ["c1"], payloads: payloads)
        expectEq(dry.reasonText, "approve a dry run of 1 contact change")
        func refuses(_ label: String, _ m: String, set: String = "s1", ids: [String] = ["c1"], payloads: [String: String]? = nil) {
            do { _ = try ApprovalPayload.contacts(manifestBytes: m, setId: set, requestedChangeIds: ids, payloads: payloads ?? Dictionary(uniqueKeysWithValues: ch.map { ($0.id, $0.payload) })); fail("accepted \(label)") }
            catch is PayloadError { } catch { fail("\(error)") }
        }
        refuses("no kind", contactsManifest(changes: [ch[0]], kind: nil))
        refuses("a send manifest", sendManifest(items: [MItem(id: "c1", to: "+1", body: "x")]))
        refuses("v 2", contactsManifest(changes: [ch[0]], v: 2))
        refuses("another set", contactsManifest(set: "x", changes: [ch[0]]))
        refuses("a change not picked", contactsManifest(changes: [ch[0]]), ids: ["c2"])
        refuses("expired", contactsManifest(notAfter: "2020-01-01T00:00:00.000Z", changes: [ch[0]]))
        refuses("a payload that doesn't hash", contactsManifest(changes: [ch[0]]), payloads: ["c1": #"{"given_name":"Evil"}"#])
        refuses("a missing payload", contactsManifest(changes: [ch[0]]), payloads: [:])
        refuses("a bad kind", contactsManifest(changes: [(id: "c1", kind: "delete", payload: ch[0].payload)]))
    }
}
