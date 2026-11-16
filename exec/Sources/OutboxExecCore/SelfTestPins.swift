import Foundation
import CryptoKit

/// Pin modes: hardened (root pin file) and simple (user pin file in the state directory). See CLAUDE.md "Pin modes".
extension SelfTest {
    static func registerPinModeCases(_ test: Reg) {
        test("simple mode: a user-owned 0600 pin whose policy allows live sends live; mode and trust are reported") { h in
            try h.goLiveSimple(allowed: true)
            let pf = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            try expect(pf.mode == .simple && pf.trustedForLive && pf.policy.liveAllowed, "simple pin: mode \(pf.mode), trusted \(pf.trustedForLive)")
            let (_, d, _) = try single(h, liveOpts())
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1 && h.dryLines().isEmpty, "simple-mode live send: \(r)")
            try expect(h.sendRows(d.draftId).first?.str("transport") == "live", "sends row transport should be live")
            try expect(try h.db.one("SELECT pin_file_ok FROM exec_status WHERE id = 1")!.i("pin_file_ok") == 1, "heartbeat should report the user pin as good")
        }
        test("simple mode: a pin whose policy forbids live refuses a live approval (explicit live_allowed=false)") { h in
            try h.goLiveSimple(allowed: false)
            let (_, d, _) = try single(h, liveOpts())
            try expectRefused(h, draft: d, reason: "pin policy")
            try expect(h.live.calls.isEmpty && h.live.preflightCalls == 0, "live transport touched")
            try expect(h.rejectionReasons().contains { $0.contains("live_allowed") }, "reason should name live_allowed: \(h.rejectionReasons())")
            // the same pin still sends dry approvals
            let (_, d2, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d2.draftId, result: "sent") && h.live.calls.isEmpty, "dry send with a no-live user pin")
        }
        test("simple mode: the user pin must not be group- or world-writable (hold, nothing sent, pin_file_ok 0)") { h in
            let (_, d, _) = try single(h)
            for mode: mode_t in [0o620, 0o602, 0o666] {
                try chmodTo(h.config.userPinPath, mode)
                let r = try h.tick()
                try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "mode \(String(mode, radix: 8)) accepted: \(r)")
                try expect(h.lastError().contains("writable"), "last_error should say writable, is '\(h.lastError())'")
                try expect(try h.db.one("SELECT pin_file_ok FROM exec_status WHERE id = 1")!.i("pin_file_ok") == 0, "heartbeat should report a bad pin")
            }
            try chmodTo(h.config.userPinPath, 0o600)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "a 0600 pin works again")
        }
        test("simple mode: a symlinked user pin is refused") { h in
            let real = h.dir + "/elsewhere/passkeys.json"
            try h.writePin(to: real, mode: 0o600)
            try FileManager.default.removeItem(atPath: h.config.userPinPath)
            try FileManager.default.createSymbolicLink(atPath: h.config.userPinPath, withDestinationPath: real)
            let (_, d, _) = try single(h)
            let r = try h.tick()
            try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "symlinked user pin accepted: \(r)")
            try expect(h.lastError().contains("cannot open"), "O_NOFOLLOW should refuse the open, last_error '\(h.lastError())'")
        }
        test("simple mode: the state directory must not be group- or world-writable, and must be ours") { h in
            let (_, d, _) = try single(h)
            for mode: mode_t in [0o775, 0o757] {
                try chmodTo(h.dir, mode)
                let r = try h.tick()
                try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "state dir \(String(mode, radix: 8)) accepted: \(r)")
                try expect(h.lastError().contains("state dir"), "last_error should name the state dir, is '\(h.lastError())'")
            }
            try chmodTo(h.dir, 0o700)
            // ownership: pointing the expected uid elsewhere makes the file (and dir) foreign
            h.config.userExpectedUid = getuid() == 0 ? 1 : 0
            try h.rebuild()
            let r = try h.tick()
            try expect(isHeld(r) && h.dryLines().isEmpty && h.lastError().contains("owned by uid"), "foreign-owned user pin accepted: \(r) / \(h.lastError())")
            h.config.userExpectedUid = getuid()
            try h.rebuild()
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "a 0700 state dir works again")
        }
        test("no downgrade: a root pin that exists but is invalid holds, even with a valid live-allowed user pin") { h in
            try h.goLiveSimple(allowed: true)
            let root = h.dir + "/rootpin/passkeys.json"
            h.config.rootPinPath = root; h.config.rootExpectedUid = getuid(); h.config.checkPinAncestors = false
            try h.rebuild()
            let (_, d, _) = try single(h, liveOpts())
            func plant(_ what: String, _ make: () throws -> Void) throws {
                try? FileManager.default.removeItem(atPath: root)
                try make()
                let r = try h.tick()
                try expect(isHeld(r) && h.live.calls.isEmpty && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "\(what): fell back or acted: \(r)")
                try expect(h.lastError().contains(root), "\(what): last_error should be about the root pin, is '\(h.lastError())'")
                try expect(try h.db.one("SELECT pin_file_ok FROM exec_status WHERE id = 1")!.i("pin_file_ok") == 0, "\(what): heartbeat should report a bad pin")
            }
            try plant("group-writable root pin") { try h.writePin(to: root, mode: 0o664, policy: ["live_allowed": true]) }
            try plant("garbage root pin") { try FileManager.default.createDirectory(atPath: h.dir + "/rootpin", withIntermediateDirectories: true); try Data("not json".utf8).write(to: URL(fileURLWithPath: root)); try chmodTo(root, 0o444) }
            try plant("dangling symlink as root pin") { try FileManager.default.createSymbolicLink(atPath: root, withDestinationPath: h.dir + "/nowhere.json") }
            try plant("root pin owned by someone else") { try h.writePin(to: root, mode: 0o444, policy: ["live_allowed": true]); h.config.rootExpectedUid = getuid() == 0 ? 1 : 0; try h.rebuild() }
            // once the root pin is valid, hardened mode takes over and the live send goes out
            h.config.rootExpectedUid = getuid()
            try h.rebuild()
            try? FileManager.default.removeItem(atPath: root)
            try h.writePin(to: root, mode: 0o444, policy: ["live_allowed": true])
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1, "valid root pin should work")
        }
        test("hardened wins: with a valid root pin the user pin is ignored (a key only in the user pin can't approve)") { h in
            let other = P256.Signing.PrivateKey()
            // simple mode first: a user pin holding only `other` (same credential id) accepts an approval signed by `other`
            try h.writePin(to: h.config.userPinPath, mode: 0o600, key: other)
            var o = ApprovalOpts(); o.signer = other
            let (_, d1, _) = try single(h, o)
            try expect(try h.tick() == .processed(draftId: d1.draftId, result: "sent"), "control: the user pin's own key should approve in simple mode")
            // now a valid root pin with the real key exists: the same kind of approval is refused
            try h.goLive(allowed: false)
            var o2 = ApprovalOpts(); o2.signer = other
            let (_, d2, _) = try single(h, o2)
            let r = try h.tick()
            try expect(r == .idle && h.draftStatus(d2.draftId) == "review" && h.dryLines().count == 1, "user-pin-only key approved under a root pin: \(r)")
            // and the root pin's own key still works
            let (_, d3, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d3.draftId, result: "sent"), "the root pin's key should approve")
            // a user pin that allows live does not make a root pin that forbids it allow it
            try h.writePin(to: h.config.userPinPath, mode: 0o600, policy: ["live_allowed": true])
            let (_, d4, _) = try single(h, liveOpts())
            try expect(try h.tick() == .idle && h.live.calls.isEmpty && h.draftStatus(d4.draftId) == "review", "user pin policy leaked into hardened mode")
        }
        test("simple mode: contacts go live only with contacts_transport=live AND the user pin's contacts_live_allowed") { h in
            ready(h)
            let set = try h.makeSet()
            try h.set("contacts_transport", "live")
            // user pin without contacts_live_allowed (live_allowed alone doesn't count): dry
            try h.goLiveSimple(allowed: true)
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "A", family: "One", phones: ["+15551110001"]))
            _ = try h.tick()
            try expect(h.chg(a.id).str("transport") == "dry" && h.contacts.writeCount == 0, "live_allowed alone enabled live contacts in simple mode")
            // contacts_live_allowed true: live
            try h.goLiveSimple(allowed: false, policy: ["contacts_live_allowed": true])
            let b = try h.approvedCreate(set: set, payload: CP.create(given: "B", family: "Two", phones: ["+15551110002"]))
            _ = try h.tick()
            try expect(h.chg(b.id).str("transport") == "live" && h.contacts.creates.count == 1, "contacts_live_allowed in simple mode should enable live")
            // turned off again: dry
            try h.goLiveSimple(allowed: false, policy: ["contacts_live_allowed": false])
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "C", family: "Three", phones: ["+15551110003"]))
            _ = try h.tick()
            try expect(h.chg(c.id).str("transport") == "dry" && h.contacts.creates.count == 1, "contacts stayed live after the policy was turned off")
        }
        test("OUTBOX_IGNORE_ROOT_PIN style override: the user pin loads but is never trusted for live") { h in
            try h.goLiveSimple(allowed: true, policy: ["contacts_live_allowed": true])
            h.config.userPinTrustedForLive = false
            try h.rebuild()
            let pf = try PinFileLoader.resolve(rootPath: h.config.rootPinPath, userPath: h.config.userPinPath, liveTrust: false)
            try expect(pf.mode == .simple && !pf.trustedForLive, "override pin should be simple and untrusted")
            let (_, d, _) = try single(h, liveOpts())
            try expectRefused(h, draft: d, reason: "not trusted for live")
            try expect(h.live.calls.isEmpty, "live transport touched")
            let (_, d2, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d2.draftId, result: "sent") && h.live.calls.isEmpty, "dry still works under the override")
        }
        test("pin resolution: root file present (any form) means hardened; absent means simple") { h in
            let none = try PinFileLoader.resolve(rootPath: h.dir + "/nope/passkeys.json", userPath: h.config.userPinPath)
            try expect(none.mode == .simple && none.path == h.config.userPinPath, "no root pin should resolve to the user pin")
            let root = h.dir + "/rootpin/passkeys.json"
            try h.writePin(to: root, mode: 0o444)
            let hard = try PinFileLoader.resolve(rootPath: root, userPath: h.config.userPinPath, rootExpectedUid: getuid(), checkRootAncestors: false)
            try expect(hard.mode == .hardened && hard.path == root && hard.trustedForLive, "root pin should resolve to hardened")
            var threw = false
            do { _ = try PinFileLoader.resolve(rootPath: root, userPath: h.config.userPinPath) } catch { threw = true }   // owned by us, not root
            try expect(threw, "an invalid root pin must throw, not fall back to the user pin")
            try expect(PinFileLoader.exists(root) && !PinFileLoader.exists(h.dir + "/nope/passkeys.json"), "exists() wrong")
        }
    }
}
