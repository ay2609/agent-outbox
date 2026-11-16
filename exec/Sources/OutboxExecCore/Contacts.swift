import Foundation
import Contacts

/// Boundary to the address book. The real implementation (`SystemContacts`) is compiled but never run in development;
/// selftest uses a fake. Neither the loop nor selftest requests Contacts access: only `contacts-export` may prompt.
public protocol ContactsProvider: AnyObject {
    /// True only when access was already granted. Never prompts.
    var accessGranted: Bool { get }
    /// Non-blocking: shows the macOS prompt if access was never decided. Called only once per process, and only in live mode.
    func requestAccessIfNeeded()
    /// All contacts as the export JSON document.
    func exportAll(now: Date) throws -> Data
    /// Creates a contact (iCloud container if present) in the "Outbox imports" group. Returns the CNContact identifier.
    func create(_ c: ProposedContactModel) throws -> String

    // v4 native contact management. Reads and writes need access already granted; none of these ever prompts.
    /// Distinct contacts that have any of these phone numbers (E.164) or email addresses, looked up live. Cards carry no groups.
    func findByHandles(phones: [String], emails: [String]) throws -> [ContactCard]
    /// Every contact's identifier and names (given, family, nickname, org) from one live read, for the name-collision check.
    func allNames() throws -> [ContactCard]
    /// The names of every group that exists in Contacts.
    func allGroupNames() throws -> [String]
    /// True when the card holds anything the executor never wrote (addresses, birthday, dates, URLs, relations, social profiles,
    /// instant messages, job title, department, a photo, middle name, prefix or suffix). Never reads the note (needs an entitlement).
    func hasExtraDetails(identifier: String) throws -> Bool
    /// The contact with this identifier, with its group names, or nil when it no longer exists.
    func card(identifier: String) throws -> ContactCard?
    /// Saves a new contact (iCloud container, else the default one; every group in `n.groups`, created in that container if missing).
    func createContact(_ n: NewContact) throws -> String
    func updateContact(identifier: String, edit: ContactEdit) throws
    func deleteContact(identifier: String) throws
}

/// Atomic write: temp file in the same directory, then rename.
public func writeAtomically(_ data: Data, to path: String) throws {
    let tmp = path + ".tmp-\(getpid())"
    try data.write(to: URL(fileURLWithPath: tmp), options: [])
    chmod(tmp, 0o600)
    if rename(tmp, path) != 0 { throw ExecError("rename \(tmp) -> \(path) failed: \(String(cString: strerror(errno)))") }
}

/// Pure building blocks of the export document (no Contacts access), so selftest can check the field names and formats.
public enum ContactsExport {
    /// "MM-DD" when the year is unknown (nil, or Apple's placeholder years before 1700), else "YYYY-MM-DD". nil without a valid month and day.
    public static func birthday(month: Int?, day: Int?, year: Int?) -> String? {
        guard let m = month, let d = day, (1...12).contains(m), (1...31).contains(d) else { return nil }
        let md = String(format: "%02d-%02d", m, d)
        if let y = year, y >= 1700, y <= 9999 { return String(format: "%04d-", y) + md }
        return md
    }

    public static func entry(macosId: String, given: String, family: String, nickname: String, org: String,
                             phones: [(raw: String, label: String)], emails: [(email: String, label: String)],
                             groups: [String], city: String, birthday: String?) -> [String: Any] {
        var e: [String: Any] = [
            "macos_id": macosId, "given_name": given, "family_name": family, "nickname": nickname, "org": org,
            "phones": phones.map { ["raw": $0.raw, "label": $0.label] },
            "emails": emails.map { ["email": $0.email, "label": $0.label] },
            "groups": Array(Set(groups)).sorted(),
        ]
        if !city.isEmpty { e["city"] = city }
        if let birthday { e["birthday"] = birthday }
        return e
    }
}

public final class SystemContacts: ContactsProvider {
    private let store = CNContactStore()
    public static let groupName = "Outbox imports"
    public init() {}

    public var accessGranted: Bool { CNContactStore.authorizationStatus(for: .contacts) == .authorized }

    public func requestAccessIfNeeded() {
        guard CNContactStore.authorizationStatus(for: .contacts) == .notDetermined else { return }
        store.requestAccess(for: .contacts) { _, _ in }
    }

    /// Used only by the explicit `contacts-export` subcommand: asks macOS for access (shows the prompt) and waits.
    public func requestAccessBlocking() -> Bool {
        if accessGranted { return true }
        let sem = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var granted = false
        store.requestAccess(for: .contacts) { ok, _ in granted = ok; sem.signal() }
        sem.wait()
        return granted
    }

    /// Contacts export document, written to contacts-export.json. Field names (the TS contacts-sync maps these):
    ///   top level: `exported_at` (ISO-8601 UTC), `contacts` (array)
    ///   per contact: `macos_id` (CNContact.identifier), `given_name`, `family_name`, `nickname`, `org`,
    ///     `phones` [{`raw`, `label`}], `emails` [{`email`, `label`}],
    ///     `groups` [String]   names of every Contacts group (CNGroup) the contact belongs to; always present, maybe empty
    ///                         (this is how "my college friends" can become tags),
    ///     `city` String       city of the first postal address; omitted when there is none,
    ///     `birthday` String   "MM-DD" when the year is unknown, "YYYY-MM-DD" when known; omitted when there is none.
    /// Notes are never read or exported.
    public func exportAll(now: Date) throws -> Data {
        guard accessGranted else { throw ExecError("Contacts access has not been granted to outbox-exec") }
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
            CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
            CNContactPostalAddressesKey, CNContactBirthdayKey,
        ].map { $0 as NSString }
        // group membership: contact identifier -> group names
        var groupsByContact: [String: [String]] = [:]
        for g in try store.groups(matching: nil) {
            let members = try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: g.identifier), keysToFetch: [CNContactIdentifierKey as NSString])
            for m in members { groupsByContact[m.identifier, default: []].append(g.name) }
        }
        let req = CNContactFetchRequest(keysToFetch: keys)
        var out: [[String: Any]] = []
        try store.enumerateContacts(with: req) { c, _ in
            let phones: [(raw: String, label: String)] = c.phoneNumbers.map { ($0.value.stringValue, Self.label($0.label)) }
            let emails: [(email: String, label: String)] = c.emailAddresses.map { (String($0.value), Self.label($0.label)) }
            let city = c.postalAddresses.first.map { $0.value.city } ?? ""
            let bday = c.birthday.flatMap { ContactsExport.birthday(month: $0.month, day: $0.day, year: $0.year) }
            out.append(ContactsExport.entry(macosId: c.identifier, given: c.givenName, family: c.familyName, nickname: c.nickname, org: c.organizationName,
                                            phones: phones, emails: emails, groups: groupsByContact[c.identifier] ?? [], city: city, birthday: bday))
        }
        let doc: [String: Any] = ["exported_at": Time.iso(now), "contacts": out]
        guard let data = JSON.data(doc) else { throw ExecError("could not encode contacts export") }
        return data
    }

    static func label(_ l: String?) -> String {
        guard let l else { return "" }
        return CNLabeledValue<NSString>.localizedString(forLabel: l)
    }

    public func create(_ c: ProposedContactModel) throws -> String {
        guard accessGranted else { throw ExecError("Contacts access has not been granted to outbox-exec") }
        let contact = CNMutableContact()
        contact.givenName = c.givenName
        contact.familyName = c.familyName
        contact.organizationName = c.org
        contact.phoneNumbers = c.phones.map { CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: $0.value)) }
        contact.emailAddresses = c.emails.map { CNLabeledValue(label: CNLabelHome, value: $0.value as NSString) }
        // Not contact.note: macOS needs a special entitlement to write notes.
        let containers = try store.containers(matching: nil)
        let container = containers.first { $0.type == .cardDAV && $0.name == "iCloud" }
            ?? containers.first { $0.identifier == store.defaultContainerIdentifier() }
            ?? containers.first
        guard let container else { throw ExecError("no Contacts container available") }
        let groups = try store.groups(matching: CNGroup.predicateForGroupsInContainer(withIdentifier: container.identifier))
        let save = CNSaveRequest()
        var group = groups.first { $0.name == Self.groupName }
        if group == nil {
            let g = CNMutableGroup()
            g.name = Self.groupName
            save.add(g, toContainerWithIdentifier: container.identifier)
            group = g
        }
        save.add(contact, toContainerWithIdentifier: container.identifier)
        if let group { save.addMember(contact, to: group) }
        try store.execute(save)
        return contact.identifier
    }
    // MARK: v4 native contact management

    static var cardKeys: [CNKeyDescriptor] {
        [CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
         CNContactPhoneNumbersKey, CNContactEmailAddressesKey].map { $0 as NSString }
    }

    static func canonicalLabel(_ l: String?) -> String {
        guard let l else { return "" }
        switch l {
        case CNLabelPhoneNumberMobile: return "mobile"
        case CNLabelHome: return "home"
        case CNLabelWork: return "work"
        case CNLabelPhoneNumberMain: return "main"
        case CNLabelOther: return "other"
        default: return CNLabeledValue<NSString>.localizedString(forLabel: l)
        }
    }

    static func cnLabel(_ l: String, defaultLabel: String) -> String {
        switch l.lowercased() {
        case "": return defaultLabel
        case "mobile": return CNLabelPhoneNumberMobile
        case "home": return CNLabelHome
        case "work": return CNLabelWork
        case "main": return CNLabelPhoneNumberMain
        case "other": return CNLabelOther
        default: return l
        }
    }

    static func card(_ c: CNContact) -> ContactCard {
        var k = ContactCard(identifier: c.identifier)
        k.given = c.givenName; k.family = c.familyName; k.nickname = c.nickname; k.org = c.organizationName
        k.phones = c.phoneNumbers.map { LabeledValue($0.value.stringValue, canonicalLabel($0.label)) }
        k.emails = c.emailAddresses.map { LabeledValue(String($0.value), canonicalLabel($0.label)) }
        return k
    }

    private func requireAccess() throws {
        guard accessGranted else { throw ExecError("Contacts access has not been granted to outbox-exec") }
    }

    public func findByHandles(phones: [String], emails: [String]) throws -> [ContactCard] {
        try requireAccess()
        var preds: [NSPredicate] = phones.map { CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: $0)) }
        preds += emails.map { CNContact.predicateForContacts(matchingEmailAddress: $0) }
        var seen = Set<String>()
        var out: [ContactCard] = []
        for p in preds {
            for c in try store.unifiedContacts(matching: p, keysToFetch: Self.cardKeys) where seen.insert(c.identifier).inserted { out.append(Self.card(c)) }
        }
        return out
    }

    public func allNames() throws -> [ContactCard] {
        try requireAccess()
        let keys: [CNKeyDescriptor] = [CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
                                       CNContactOrganizationNameKey].map { $0 as NSString }
        var out: [ContactCard] = []
        try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c, _ in
            var k = ContactCard(identifier: c.identifier)
            k.given = c.givenName; k.family = c.familyName; k.nickname = c.nickname; k.org = c.organizationName
            out.append(k)
        }
        return out
    }

    public func allGroupNames() throws -> [String] {
        try requireAccess()
        return try store.groups(matching: nil).map { $0.name }
    }

    public func hasExtraDetails(identifier: String) throws -> Bool {
        try requireAccess()
        // Explicit key list, never the note key and never CNContactVCardSerialization.descriptorForRequiredKeys() (it includes the note).
        let keys: [CNKeyDescriptor] = [CNContactPostalAddressesKey, CNContactBirthdayKey, CNContactDatesKey, CNContactUrlAddressesKey,
                                       CNContactRelationsKey, CNContactSocialProfilesKey, CNContactInstantMessageAddressesKey,
                                       CNContactJobTitleKey, CNContactDepartmentNameKey, CNContactImageDataAvailableKey,
                                       CNContactMiddleNameKey, CNContactNamePrefixKey, CNContactNameSuffixKey].map { $0 as NSString }
        let c = try store.unifiedContact(withIdentifier: identifier, keysToFetch: keys)
        return !c.postalAddresses.isEmpty || c.birthday != nil || !c.dates.isEmpty || !c.urlAddresses.isEmpty || !c.contactRelations.isEmpty
            || !c.socialProfiles.isEmpty || !c.instantMessageAddresses.isEmpty || !c.jobTitle.isEmpty || !c.departmentName.isEmpty
            || c.imageDataAvailable || !c.middleName.isEmpty || !c.namePrefix.isEmpty || !c.nameSuffix.isEmpty
    }

    private func groupNames(of id: String) throws -> [String] {
        var names: [String] = []
        for g in try store.groups(matching: nil) {
            let members = try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: g.identifier), keysToFetch: [CNContactIdentifierKey as NSString])
            if members.contains(where: { $0.identifier == id }) { names.append(g.name) }
        }
        return names
    }

    public func card(identifier: String) throws -> ContactCard? {
        try requireAccess()
        do {
            let c = try store.unifiedContact(withIdentifier: identifier, keysToFetch: Self.cardKeys)
            var k = Self.card(c)
            k.groups = try groupNames(of: identifier)
            return k
        } catch let e as CNError where e.code == .recordDoesNotExist {
            return nil
        }
    }

    /// iCloud first, then the default container, then any.
    private func preferredContainer() throws -> CNContainer {
        let containers = try store.containers(matching: nil)
        let c = containers.first { $0.type == .cardDAV && $0.name == "iCloud" }
            ?? containers.first { $0.identifier == store.defaultContainerIdentifier() }
            ?? containers.first
        guard let c else { throw ExecError("no Contacts container available") }
        return c
    }

    public func createContact(_ n: NewContact) throws -> String {
        try requireAccess()
        let contact = CNMutableContact()
        contact.givenName = n.given; contact.familyName = n.family; contact.nickname = n.nickname; contact.organizationName = n.org
        contact.phoneNumbers = n.phones.map { CNLabeledValue(label: Self.cnLabel($0.label, defaultLabel: CNLabelPhoneNumberMobile), value: CNPhoneNumber(stringValue: $0.value)) }
        contact.emailAddresses = n.emails.map { CNLabeledValue(label: Self.cnLabel($0.label, defaultLabel: CNLabelHome), value: $0.value as NSString) }
        let container = try preferredContainer()
        let existing = try store.groups(matching: CNGroup.predicateForGroupsInContainer(withIdentifier: container.identifier))
        let save = CNSaveRequest()
        save.add(contact, toContainerWithIdentifier: container.identifier)
        for name in n.groups {
            let group: CNGroup
            if let g = existing.first(where: { $0.name == name }) { group = g }
            else {
                let g = CNMutableGroup()
                g.name = name
                save.add(g, toContainerWithIdentifier: container.identifier)
                group = g
            }
            save.addMember(contact, to: group)
        }
        try store.execute(save)
        return contact.identifier
    }

    public func updateContact(identifier: String, edit e: ContactEdit) throws {
        try requireAccess()
        let c = try store.unifiedContact(withIdentifier: identifier, keysToFetch: Self.cardKeys)
        guard let m = c.mutableCopy() as? CNMutableContact else { throw ExecError("cannot edit contact \(identifier)") }
        if let v = e.given { m.givenName = v }
        if let v = e.family { m.familyName = v }
        if let v = e.nickname { m.nickname = v }
        if let v = e.org { m.organizationName = v }
        var phones = m.phoneNumbers
        if !e.removePhones.isEmpty {
            let gone = Set(e.removePhones)
            phones.removeAll { gone.contains(ContactMath.normalizedPhone($0.value.stringValue)) }
        }
        for p in e.addPhones where !phones.contains(where: { ContactMath.normalizedPhone($0.value.stringValue) == ContactMath.normalizedPhone(p.value) }) {
            phones.append(CNLabeledValue(label: Self.cnLabel(p.label, defaultLabel: CNLabelPhoneNumberMobile), value: CNPhoneNumber(stringValue: p.value)))
        }
        m.phoneNumbers = phones
        var emails = m.emailAddresses
        if !e.removeEmails.isEmpty {
            let gone = Set(e.removeEmails.map { $0.lowercased() })
            emails.removeAll { gone.contains(String($0.value).lowercased()) }
        }
        for a in e.addEmails where !emails.contains(where: { String($0.value).lowercased() == a.value.lowercased() }) {
            emails.append(CNLabeledValue(label: Self.cnLabel(a.label, defaultLabel: CNLabelHome), value: a.value as NSString))
        }
        m.emailAddresses = emails
        let save = CNSaveRequest()
        save.update(m)
        if !e.addGroups.isEmpty {
            let container = try store.containers(matching: CNContainer.predicateForContainerOfContact(withIdentifier: identifier)).first ?? preferredContainer()
            let existing = try store.groups(matching: CNGroup.predicateForGroupsInContainer(withIdentifier: container.identifier))
            let member = Set(try groupNames(of: identifier))
            for name in e.addGroups where !member.contains(name) {
                let group: CNGroup
                if let g = existing.first(where: { $0.name == name }) { group = g }
                else {
                    let g = CNMutableGroup()
                    g.name = name
                    save.add(g, toContainerWithIdentifier: container.identifier)
                    group = g
                }
                save.addMember(m, to: group)
            }
        }
        if !e.removeGroups.isEmpty {
            for g in try store.groups(matching: nil) where e.removeGroups.contains(g.name) {
                let members = try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: g.identifier), keysToFetch: [CNContactIdentifierKey as NSString])
                if members.contains(where: { $0.identifier == identifier }) { save.removeMember(m, from: g) }
            }
        }
        try store.execute(save)
    }

    public func deleteContact(identifier: String) throws {
        try requireAccess()
        let c = try store.unifiedContact(withIdentifier: identifier, keysToFetch: [CNContactIdentifierKey as NSString])
        guard let m = c.mutableCopy() as? CNMutableContact else { throw ExecError("cannot delete contact \(identifier)") }
        let save = CNSaveRequest()
        save.delete(m)
        try store.execute(save)
    }
}
