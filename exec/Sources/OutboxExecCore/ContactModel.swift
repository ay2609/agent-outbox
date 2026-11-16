import Foundation

// Pure building blocks of native contact management: the card model, edits, the canonical fingerprint
// and the payload validation. Nothing here touches Contacts or the database, so selftest can pin every rule down directly.

public struct LabeledValue: Equatable {
    public var value: String
    public var label: String
    public init(_ value: String, _ label: String) { self.value = value; self.label = label }
}

/// The fields of one contact that outbox-exec reads, compares and edits. `groups` are CNGroup names; lookups by handle or
/// name leave it empty, only `ContactsProvider.card(identifier:)` fills it.
public struct ContactCard: Equatable {
    public var identifier: String
    public var given = "", family = "", nickname = "", org = ""
    public var phones: [LabeledValue] = []
    public var emails: [LabeledValue] = []
    public var groups: [String] = []
    public init(identifier: String) { self.identifier = identifier }
}

/// A contact to create. `groups` already includes "Outbox imports".
public struct NewContact {
    public var given = "", family = "", nickname = "", org = ""
    public var phones: [LabeledValue] = []
    public var emails: [LabeledValue] = []
    public var groups: [String] = []
    public init() {}
}

/// A change to an existing contact. Used for updates and, with the `remove…` lists, to undo them.
public struct ContactEdit {
    public var given: String?, family: String?, nickname: String?, org: String?
    public var addPhones: [LabeledValue] = []
    public var addEmails: [LabeledValue] = []
    public var addGroups: [String] = []
    /// Matched by normalised value (`ContactMath.normalizedPhone`).
    public var removePhones: [String] = []
    /// Matched lowercased.
    public var removeEmails: [String] = []
    public var removeGroups: [String] = []
    public init() {}

    /// The card this edit produces. The same rules the live write follows (never add a handle already on the card, a blank label
    /// becomes mobile / home), so a dry run can predict the fingerprint and an update can be recognised as a no-op.
    public func applying(to card: ContactCard) -> ContactCard {
        var c = card
        if let v = given { c.given = v }
        if let v = family { c.family = v }
        if let v = nickname { c.nickname = v }
        if let v = org { c.org = v }
        if !removePhones.isEmpty {
            let gone = Set(removePhones)
            c.phones.removeAll { gone.contains(ContactMath.normalizedPhone($0.value)) }
        }
        if !removeEmails.isEmpty {
            let gone = Set(removeEmails.map { $0.lowercased() })
            c.emails.removeAll { gone.contains($0.value.lowercased()) }
        }
        for p in addPhones {
            let n = ContactMath.normalizedPhone(p.value)
            if !c.phones.contains(where: { ContactMath.normalizedPhone($0.value) == n }) {
                c.phones.append(LabeledValue(p.value, p.label.isEmpty ? "mobile" : p.label))
            }
        }
        for e in addEmails {
            let n = e.value.lowercased()
            if !c.emails.contains(where: { $0.value.lowercased() == n }) {
                c.emails.append(LabeledValue(e.value, e.label.isEmpty ? "home" : e.label))
            }
        }
        if !removeGroups.isEmpty { c.groups.removeAll { removeGroups.contains($0) } }
        for g in addGroups where !c.groups.contains(g) { c.groups.append(g) }
        return c
    }
}

public enum ContactMath {
    public static let importsGroup = "Outbox imports"

    /// E.164 for a phone string as Contacts stores it, or nil. Deliberately simple (no libphonenumber here): "+" numbers keep
    /// their digits, a bare 10-digit number is US, 11 digits starting with 1 is US, "00" is an international prefix.
    /// Only the executor's own before/after comparisons depend on it, so it just has to be deterministic.
    public static func e164(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = t.unicodeScalars.filter { $0.value >= 0x30 && $0.value <= 0x39 }.map { Character($0) }
        let d = String(digits)
        if t.hasPrefix("+") { return (7...15).contains(d.count) && d.first != "0" ? "+" + d : nil }
        if d.hasPrefix("00") { let r = String(d.dropFirst(2)); return (7...15).contains(r.count) && r.first != "0" ? "+" + r : nil }
        if d.count == 10 && d.first != "0" && d.first != "1" { return "+1" + d }
        if d.count == 11 && d.hasPrefix("1") { return "+" + d }
        return nil
    }

    /// E.164 when the number parses, else the raw string unchanged (contract: "unparseable ones kept raw").
    public static func normalizedPhone(_ raw: String) -> String { e164(raw) ?? raw }

    /// Canonical fingerprint: sha256 hex of the UTF-8 JSON
    /// `{"e":[sorted lowercased emails],"f":family,"g":given,"n":nickname,"o":org,"p":[sorted E.164 phones]}` (keys in that order,
    /// no whitespace). Groups are not part of it.
    public static func fingerprint(_ c: ContactCard) -> String {
        let e = c.emails.map { $0.value.lowercased() }.sorted()
        let p = c.phones.map { normalizedPhone($0.value) }.sorted()
        let json = "{\"e\":" + jsonArray(e) + ",\"f\":" + jsonString(c.family) + ",\"g\":" + jsonString(c.given)
            + ",\"n\":" + jsonString(c.nickname) + ",\"o\":" + jsonString(c.org) + ",\"p\":" + jsonArray(p) + "}"
        return Hex.sha256Hex(json)
    }

    /// The card a create produces (what a dry run predicts, and what a live write should read back as).
    public static func card(for n: NewContact, identifier: String) -> ContactCard {
        var c = ContactCard(identifier: identifier)
        c.given = n.given; c.family = n.family; c.nickname = n.nickname; c.org = n.org
        c.phones = n.phones; c.emails = n.emails; c.groups = n.groups
        return c
    }

    /// An auto create needs BOTH names, and each must have a letter or digit left once emoji and symbols are removed.
    public static func hasTwoNames(_ p: CreatePayload) -> Bool {
        !NameSkeleton.of(p.given).isEmpty && !NameSkeleton.of(p.family).isEmpty
    }

    // Minimal JSON encoding for the fingerprint, done by hand so the exact bytes are never up to a serializer's whim.
    static func jsonString(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }
    static func jsonArray(_ a: [String]) -> String { "[" + a.map(jsonString).joined(separator: ",") + "]" }
}

/// Name "skeleton" (same idea as src/core/name-skeleton.ts): what a name looks like once the tricks that make two
/// different strings read the same are removed. NFKC, drop ZWJ / VS16 / invisible characters and every emoji and symbol scalar,
/// map common Cyrillic and Greek look-alikes to Latin, then fold case and diacritics and collapse whitespace.
public enum NameSkeleton {
    static let confusables: [Unicode.Scalar: String] = {
        let pairs: [(String, String)] = [
            // Cyrillic, small then capital
            ("а", "a"), ("в", "b"), ("е", "e"), ("к", "k"), ("м", "m"), ("н", "h"), ("о", "o"), ("р", "p"), ("с", "c"), ("т", "t"),
            ("у", "y"), ("х", "x"), ("і", "i"), ("ј", "j"), ("ѕ", "s"), ("ԁ", "d"), ("ԛ", "q"), ("ԝ", "w"),
            ("А", "a"), ("В", "b"), ("Е", "e"), ("К", "k"), ("М", "m"), ("Н", "h"), ("О", "o"), ("Р", "p"), ("С", "c"), ("Т", "t"),
            ("У", "y"), ("Х", "x"), ("І", "i"), ("Ј", "j"), ("Ѕ", "s"), ("Ԁ", "d"), ("Ԛ", "q"), ("Ԝ", "w"),
            // Greek
            ("α", "a"), ("β", "b"), ("ε", "e"), ("η", "n"), ("ι", "i"), ("κ", "k"), ("μ", "u"), ("ν", "v"), ("ο", "o"), ("ρ", "p"),
            ("τ", "t"), ("υ", "u"), ("χ", "x"),
            ("Α", "a"), ("Β", "b"), ("Ε", "e"), ("Ζ", "z"), ("Η", "h"), ("Ι", "i"), ("Κ", "k"), ("Μ", "m"), ("Ν", "n"), ("Ο", "o"),
            ("Ρ", "p"), ("Τ", "t"), ("Υ", "y"), ("Χ", "x"),
        ]
        var m: [Unicode.Scalar: String] = [:]
        for (k, v) in pairs { if let u = k.unicodeScalars.first { m[u] = v } }
        return m
    }()

    public static func of(_ s: String) -> String {
        var kept = String.UnicodeScalarView()
        // canonical decomposition first, so an accented look-alike (Greek alpha with tonos) still reaches its table entry
        for u in s.precomposedStringWithCompatibilityMapping.decomposedStringWithCanonicalMapping.unicodeScalars {
            if u.value == 0x200D || u.value == 0xFE0F || ContactPayloadParser.invisible(u) { continue }
            let p = u.properties
            if p.isEmoji && p.isEmojiPresentation { continue }
            switch p.generalCategory {
            case .otherSymbol, .modifierSymbol, .mathSymbol: continue
            default: break
            }
            if let m = confusables[u] { kept.append(contentsOf: m.unicodeScalars) } else { kept.append(u) }
        }
        let folded = String(kept).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return folded.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}

/// Skeletons of every existing card's names, built once per pass from one live read of the address book.
public struct NameIndex {
    var full = Set<String>(), given = Set<String>(), nick = Set<String>()
    public init(_ cards: [ContactCard] = []) { for c in cards { add(given: c.given, family: c.family, nickname: c.nickname) } }

    public mutating func add(given g: String, family f: String, nickname n: String) {
        let full = NameSkeleton.of(g + " " + f), gs = NameSkeleton.of(g), ns = NameSkeleton.of(n)
        if !full.isEmpty { self.full.insert(full) }
        if !gs.isEmpty { given.insert(gs) }
        if !ns.isEmpty { nick.insert(ns) }
    }

    /// The new contact reads as someone already there: its "given family" matches a card's, or its nickname matches a card's
    /// full name, given name alone, or nickname.
    public func collides(_ p: CreatePayload) -> Bool {
        let full = NameSkeleton.of(p.given + " " + p.family)
        if !full.isEmpty && self.full.contains(full) { return true }
        let n = NameSkeleton.of(p.nickname)
        return !n.isEmpty && (self.full.contains(n) || given.contains(n) || nick.contains(n))
    }
}

/// Every Contacts group name that exists, for "joins an existing group".
public struct GroupIndex {
    var exact = Set<String>(), skeletons = Set<String>()
    public init(_ names: [String] = []) {
        for n in names { add(n) }
        skeletons.insert(NameSkeleton.of(ContactMath.importsGroup))
    }
    public mutating func add(_ n: String) { exact.insert(n); let s = NameSkeleton.of(n); if !s.isEmpty { skeletons.insert(s) } }

    /// A payload group that already exists, or that merely looks like an existing group (or the imports group) without being it.
    public func joinsExisting(_ groups: [String]) -> Bool {
        for g in groups where g != ContactMath.importsGroup {
            if exact.contains(g) { return true }
            let s = NameSkeleton.of(g)
            if !s.isEmpty && skeletons.contains(s) { return true }
        }
        return false
    }
}

/// before_vcard (the column name is historical) = a canonical JSON snapshot of the card, written by the executor before an update
/// and read back by an undo. Not a vCard: CNContactVCardSerialization asks for the note key, which needs an entitlement this app
/// lacks, so every fetch would throw on the real Mac. Shape, keys sorted:
/// `{"emails":[{"email","label"}],"family_name","given_name","groups":[…],"nickname","org","phones":[{"e164"|"raw","label"}],"v":1}`.
public enum ContactSnapshot {
    public static func json(_ c: ContactCard) -> String {
        let o: [String: Any] = [
            "v": 1, "given_name": c.given, "family_name": c.family, "nickname": c.nickname, "org": c.org,
            "phones": c.phones.map { p -> [String: Any] in
                if let e = ContactMath.e164(p.value) { return ["e164": e, "label": p.label] }
                return ["raw": p.value, "label": p.label]
            },
            "emails": c.emails.map { ["email": $0.value, "label": $0.label] },
            "groups": c.groups.sorted(),
        ]
        return JSON.string(o)
    }

    /// The card a snapshot holds (identifier empty), or nil when it isn't a v1 snapshot.
    public static func parse(_ text: String) -> ContactCard? {
        guard let o = JSON.object(Data(text.utf8)), (o["v"] as? Int) == 1 else { return nil }
        var c = ContactCard(identifier: "")
        c.given = o["given_name"] as? String ?? ""; c.family = o["family_name"] as? String ?? ""
        c.nickname = o["nickname"] as? String ?? ""; c.org = o["org"] as? String ?? ""
        for p in o["phones"] as? [[String: Any]] ?? [] {
            guard let v = (p["e164"] as? String) ?? (p["raw"] as? String) else { return nil }
            c.phones.append(LabeledValue(v, p["label"] as? String ?? ""))
        }
        for e in o["emails"] as? [[String: Any]] ?? [] {
            guard let v = e["email"] as? String else { return nil }
            c.emails.append(LabeledValue(v, e["label"] as? String ?? ""))
        }
        c.groups = (o["groups"] as? [String]) ?? []
        return c
    }
}

// MARK: payloads

public struct CreatePayload {
    public var given = "", family = "", nickname = "", org = ""
    public var phones: [LabeledValue] = []     // value = E.164
    public var emails: [LabeledValue] = []     // value = lowercased address
    public var groups: [String] = []

    /// The contact to save: the payload plus the always-added "Outbox imports" group.
    public func newContact() -> NewContact {
        var n = NewContact()
        n.given = given; n.family = family; n.nickname = nickname; n.org = org
        n.phones = phones.map { LabeledValue($0.value, $0.label.isEmpty ? "mobile" : $0.label) }
        n.emails = emails.map { LabeledValue($0.value, $0.label.isEmpty ? "home" : $0.label) }
        n.groups = [ContactMath.importsGroup] + groups.filter { $0 != ContactMath.importsGroup }
        return n
    }
}

public struct UpdatePayload {
    public static let setKeys = ["given_name", "family_name", "nickname", "org"]
    public var set: [String: String] = [:]
    public var addPhones: [LabeledValue] = []
    public var addEmails: [LabeledValue] = []
    public var addGroups: [String] = []
    public var fromCreate = false

    public func edit() -> ContactEdit {
        var e = ContactEdit()
        e.given = set["given_name"]; e.family = set["family_name"]; e.nickname = set["nickname"]; e.org = set["org"]
        e.addPhones = addPhones; e.addEmails = addEmails; e.addGroups = addGroups
        return e
    }

    /// The JSON the executor writes back when it converts a create.
    public func json() -> String {
        var o: [String: Any] = [:]
        if !set.isEmpty { o["set"] = set }
        if !addPhones.isEmpty { o["add_phones"] = addPhones.map { ["e164": $0.value, "label": $0.label] } }
        if !addEmails.isEmpty { o["add_emails"] = addEmails.map { ["email": $0.value, "label": $0.label] } }
        if !addGroups.isEmpty { o["add_groups"] = addGroups }
        if fromCreate { o["from_create"] = true }
        return JSON.string(o)
    }
}

public struct UndoPayload {
    public var undoOf = "", undoKind = ""
    public var beforeVcardSha256: String?
    public var afterFingerprint = ""
}

public enum ContactPayload {
    case create(CreatePayload)
    case update(UpdatePayload)
    case undo(UndoPayload)
}

/// Payload validation, identical in intent to the TypeScript side. Every failure is a `Rejection`
/// with a reason that ends up in `contact_changes.error`. Unknown keys are refused at every level, so nothing unsigned rides along.
public enum ContactPayloadParser {
    public static let maxText = 100
    public static let maxHandles = 5
    public static let maxGroups = 5

    /// C0 and C1 controls (and DEL), line/paragraph separators, bidi overrides and isolates, and invisible characters.
    static func forbidden(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        return v < 0x20 || (v >= 0x7F && v <= 0x9F) || v == 0x2028 || v == 0x2029 || (v >= 0x202A && v <= 0x202E) || (v >= 0x2066 && v <= 0x2069) || invisible(u)
    }

    /// Default-ignorable and other invisible code points that let two different names print the same. U+200D (ZWJ) and U+FE0F
    /// (VS16) are NOT here: emoji sequences need them.
    static func invisible(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x3164, 0xFEFF, 0xFFA0: return true
        case 0x180B...0x180F, 0x200B...0x200C, 0x200E...0x200F, 0x2060...0x206F, 0xFE00...0xFE0E, 0xE0000...0xE0FFF: return true
        default: return false
        }
    }

    /// Exact bytes: nothing is trimmed here. A string with surrounding whitespace is refused (TypeScript trims before it stores),
    /// then length (Unicode scalars, ≤ 100) and forbidden characters are checked.
    static func text(_ any: Any?, _ what: String, allowEmpty: Bool) throws -> String {
        guard let s = any as? String else { throw Rejection("\(what) is not a string") }
        if s != s.trimmingCharacters(in: .whitespacesAndNewlines) { throw Rejection("\(what) has leading or trailing whitespace") }
        if s.unicodeScalars.count > maxText { throw Rejection("\(what) is longer than \(maxText) characters") }
        if s.unicodeScalars.contains(where: forbidden) { throw Rejection("\(what) contains a control, bidi-override or invisible character") }
        if s.isEmpty && !allowEmpty { throw Rejection("\(what) is empty") }
        return s
    }

    static func onlyKeys(_ o: [String: Any], _ allowed: Set<String>, _ what: String) throws {
        if let bad = o.keys.sorted().first(where: { !allowed.contains($0) }) { throw Rejection("\(what) has unknown key \"\(bad)\"") }
    }

    static let phoneRE = try! NSRegularExpression(pattern: "^\\+[1-9][0-9]{6,14}$")
    static let emailRE = try! NSRegularExpression(pattern: "^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,}$")

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func phones(_ any: Any?, _ what: String) throws -> [LabeledValue] {
        guard let any else { return [] }
        guard let arr = any as? [Any] else { throw Rejection("\(what) is not an array") }
        if arr.count > maxHandles { throw Rejection("\(what) has more than \(maxHandles) entries") }
        var out: [LabeledValue] = []
        for (i, x) in arr.enumerated() {
            guard let o = x as? [String: Any] else { throw Rejection("\(what)[\(i)] is not an object") }
            try onlyKeys(o, ["e164", "label", "raw"], "\(what)[\(i)]")
            guard let e = o["e164"] as? String, matches(phoneRE, e) else { throw Rejection("\(what)[\(i)].e164 is not a valid E.164 number") }
            let label = o["label"] == nil ? "" : try text(o["label"], "\(what)[\(i)].label", allowEmpty: true)
            if let r = o["raw"], !(r is String) { throw Rejection("\(what)[\(i)].raw is not a string") }
            if out.contains(where: { $0.value == e }) { throw Rejection("\(what) lists \(e) twice") }
            out.append(LabeledValue(e, label))
        }
        return out
    }

    static func emails(_ any: Any?, _ what: String) throws -> [LabeledValue] {
        guard let any else { return [] }
        guard let arr = any as? [Any] else { throw Rejection("\(what) is not an array") }
        if arr.count > maxHandles { throw Rejection("\(what) has more than \(maxHandles) entries") }
        var out: [LabeledValue] = []
        for (i, x) in arr.enumerated() {
            guard let o = x as? [String: Any] else { throw Rejection("\(what)[\(i)] is not an object") }
            try onlyKeys(o, ["email", "label"], "\(what)[\(i)]")
            guard let e = o["email"] as? String, e == e.lowercased(), e.count <= 254, matches(emailRE, e) else { throw Rejection("\(what)[\(i)].email is not a valid lowercase address") }
            let label = o["label"] == nil ? "" : try text(o["label"], "\(what)[\(i)].label", allowEmpty: true)
            if out.contains(where: { $0.value == e }) { throw Rejection("\(what) lists \(e) twice") }
            out.append(LabeledValue(e, label))
        }
        return out
    }

    static func groups(_ any: Any?, _ what: String) throws -> [String] {
        guard let any else { return [] }
        guard let arr = any as? [Any] else { throw Rejection("\(what) is not an array") }
        if arr.count > maxGroups { throw Rejection("\(what) has more than \(maxGroups) entries") }
        var out: [String] = []
        for (i, x) in arr.enumerated() {
            let g = try text(x, "\(what)[\(i)]", allowEmpty: false)
            if !out.contains(g) { out.append(g) }
        }
        return out
    }

    public static func parse(kind: String, json: String, targetMacosId: String?) throws -> ContactPayload {
        guard let o = JSON.object(Data(json.utf8)) else { throw Rejection("payload_json is not a JSON object") }
        switch kind {
        case "create":
            try onlyKeys(o, ["given_name", "family_name", "nickname", "org", "phones", "emails", "groups"], "payload")
            var p = CreatePayload()
            p.given = try o["given_name"] == nil ? "" : text(o["given_name"], "given_name", allowEmpty: true)
            p.family = try o["family_name"] == nil ? "" : text(o["family_name"], "family_name", allowEmpty: true)
            p.nickname = try o["nickname"] == nil ? "" : text(o["nickname"], "nickname", allowEmpty: true)
            p.org = try o["org"] == nil ? "" : text(o["org"], "org", allowEmpty: true)
            if p.given.isEmpty && p.family.isEmpty { throw Rejection("a contact needs a given or a family name") }
            p.phones = try phones(o["phones"], "phones")
            p.emails = try emails(o["emails"], "emails")
            if p.phones.isEmpty && p.emails.isEmpty { throw Rejection("a contact needs at least one phone or email") }
            p.groups = try groups(o["groups"], "groups")
            return .create(p)
        case "update":
            guard let t = targetMacosId, !t.isEmpty else { throw Rejection("an update needs a target contact (target_macos_id)") }
            try onlyKeys(o, ["set", "add_phones", "add_emails", "add_groups", "from_create"], "payload")
            var p = UpdatePayload()
            if let s = o["set"] {
                guard let so = s as? [String: Any] else { throw Rejection("set is not an object") }
                try onlyKeys(so, Set(UpdatePayload.setKeys), "set")
                for (k, v) in so { p.set[k] = try text(v, "set.\(k)", allowEmpty: true) }
            }
            p.addPhones = try phones(o["add_phones"], "add_phones")
            p.addEmails = try emails(o["add_emails"], "add_emails")
            p.addGroups = try groups(o["add_groups"], "add_groups")
            if let f = o["from_create"] {
                guard let n = f as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw Rejection("from_create is not a boolean") }
                p.fromCreate = n.boolValue
            }
            if p.set.isEmpty && p.addPhones.isEmpty && p.addEmails.isEmpty && p.addGroups.isEmpty { throw Rejection("the update changes nothing") }
            return .update(p)
        case "undo":
            guard let t = targetMacosId, !t.isEmpty else { throw Rejection("an undo needs a target contact (target_macos_id)") }
            try onlyKeys(o, ["undo_of", "undo_kind", "before_vcard_sha256", "after_fingerprint"], "payload")
            var p = UndoPayload()
            guard let u = o["undo_of"] as? String, !u.isEmpty else { throw Rejection("undo_of missing") }
            guard let k = o["undo_kind"] as? String, k == "create" || k == "update" else { throw Rejection("undo_kind is not create or update") }
            guard let f = o["after_fingerprint"] as? String, isSha(f) else { throw Rejection("after_fingerprint is not a sha256 hex string") }
            if let b = o["before_vcard_sha256"], !(b is NSNull) {
                guard let s = b as? String, isSha(s) else { throw Rejection("before_vcard_sha256 is not a sha256 hex string") }
                p.beforeVcardSha256 = s
            }
            if k == "update" && p.beforeVcardSha256 == nil { throw Rejection("an undo of an update needs before_vcard_sha256") }
            p.undoOf = u; p.undoKind = k; p.afterFingerprint = f
            return .undo(p)
        default:
            throw Rejection("unknown change kind \(kind)")
        }
    }

    static func isSha(_ s: String) -> Bool { s.count == 64 && s.allSatisfy { $0.isHexDigit && !$0.isUppercase } }

    /// The "convert" rule: the update that brings an existing card up to what a create asked for, or nil when the card already
    /// has all of it (and the create has no groups to add).
    public static func convert(_ c: CreatePayload, existing: ContactCard) -> UpdatePayload? {
        var u = UpdatePayload()
        if !c.given.isEmpty && c.given != existing.given { u.set["given_name"] = c.given }
        if !c.family.isEmpty && c.family != existing.family { u.set["family_name"] = c.family }
        if !c.nickname.isEmpty && c.nickname != existing.nickname { u.set["nickname"] = c.nickname }
        if !c.org.isEmpty && c.org != existing.org { u.set["org"] = c.org }
        let havePhones = Set(existing.phones.map { ContactMath.normalizedPhone($0.value) })
        let haveEmails = Set(existing.emails.map { $0.value.lowercased() })
        u.addPhones = c.phones.filter { !havePhones.contains($0.value) }
        u.addEmails = c.emails.filter { !haveEmails.contains($0.value) }
        u.addGroups = c.groups
        u.fromCreate = true
        if u.set.isEmpty && u.addPhones.isEmpty && u.addEmails.isEmpty && u.addGroups.isEmpty { return nil }
        return u
    }
}
