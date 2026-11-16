import Foundation

// Selftest cases for optional pacing ("Spread out messages"). Clock, random draw and time zone are injected through the Harness:
// the base time is 12:00 on 2026-11-10 in America/New_York (17:00Z), and `h.rand` is the 0..<1 value the random pause is drawn from.
extension SelfTest {
    static let nyMidnightNext = Time.parse("2026-11-11T05:00:00Z")!     // 00:00 Nov 11 in New York
    static let ny9amNext = Time.parse("2026-11-11T14:00:00Z")!          // 09:00 Nov 11 in New York

    /// Turns pacing on with these values (the settings rows exist from the schema).
    static func paceOn(_ h: Harness, min: Int = 60, max: Int = 120, cap: Int = 0, quiet: (String, String)? = nil) throws {
        try h.set("pace_enabled", "1"); try h.set("pace_min_s", String(min)); try h.set("pace_max_s", String(max)); try h.set("daily_cap", String(cap))
        try h.set("quiet_start", quiet?.0 ?? ""); try h.set("quiet_end", quiet?.1 ?? "")
    }
    static func stateValue(_ h: Harness, _ k: String) -> String { ((try? h.exec.state.get(k)) ?? nil) ?? "" }
    static func approvedBatch(_ h: Harness, _ n: Int, _ o: ApprovalOpts = ApprovalOpts()) throws -> (batch: String, drafts: [ItemSpec]) {
        let b = try h.makeBatch()
        let ds = try (0..<n).map { try h.makeDraft(batch: b, handle: "+1555000400\($0)", position: $0) }
        try h.approve(batch: b, items: ds, o)
        return (b, ds)
    }

    static func registerPacingCases(_ test: Reg) {
        test("pacing off (the default rows) sends right away, 2 s apart, whatever the other pacing values say") { h in
            try expect(h.setting("pace_enabled") == "0" && h.setting("daily_cap") == "0" && h.setting("quiet_start") == "", "off defaults: \(h.setting("pace_enabled"))")
            try h.set("pace_min_s", "3600"); try h.set("pace_max_s", "3600"); try h.set("daily_cap", "1"); try h.set("quiet_start", "00:00"); try h.set("quiet_end", "23:59")
            let (_, ds) = try approvedBatch(h, 3)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "first send is immediate")
            try expect(heldText(try h.tickNow()).contains("2 s gap"), "off: the fixed 2 s gap, not a pacing hold")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "second send 2 s later (cap 1 and quiet hours are ignored while off)")
            try expect(stateValue(h, "next_send_at") == "" && stateValue(h, "pace_hold") == "", "nothing published while off")
        }
        test("pacing on: a random pause in [min, max] follows every attempt, is saved in exec_state and survives a restart") { h in
            try paceOn(h, min: 100, max: 200)
            h.rand = 0.25                                                   // 100 + 100 * 0.25 = 125 s
            let (_, ds) = try approvedBatch(h, 3)
            let t0 = h.clock.now
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "the first send isn't delayed")
            try expect(Time.parse(stateValue(h, "next_send_at")) == t0.addingTimeInterval(125), "next_send_at should be +125 s, is \(stateValue(h, "next_send_at"))")
            let r = try h.tickNow()
            try expect(isHeld(r) && heldText(r).contains("next message at") && stateValue(h, "pace_hold") == "gap" && Time.parse(stateValue(h, "pace_until")) == t0.addingTimeInterval(125), "gap hold not reported: \(r)")
            h.clock.now = t0.addingTimeInterval(124.9)
            try h.rebuild()                                                 // an executor restart keeps the pause
            try expect(isHeld(try h.tickNow()) && h.sendRows(ds[1].draftId).isEmpty, "124.9 s after, even after a restart: still held")
            h.clock.now = t0.addingTimeInterval(125)
            h.rand = 1.0
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "125 s after: the next one goes")
            let t1 = h.clock.now
            try expect(isHeld(try h.tickNow()) && Time.parse(stateValue(h, "next_send_at")) == t1.addingTimeInterval(200), "the longest draw is max (200 s): \(stateValue(h, "next_send_at"))")
            try expect(Pacing.drawGap(PaceSettings.load(["pace_enabled": "1", "pace_min_s": "100", "pace_max_s": "200"]), random: { 0 }) == 100, "the shortest draw is min")
        }
        test("pacing on: a failed attempt also starts the pause, and the pause counts from when it finished") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("e")])
            try h.rebuild()
            try paceOn(h, min: 60, max: 60)
            let (_, ds) = try approvedBatch(h, 2)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "failed"), "first attempt fails")
            h.clock.now = h.clock.now.addingTimeInterval(59)
            try expect(isHeld(try h.tickNow()), "59 s after a failure: still paused")
            h.clock.now = h.clock.now.addingTimeInterval(1)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "60 s after: the retry goes")
        }
        test("pacing on: loosening the settings takes effect at once (the pause is capped at the new longest pause)") { h in
            try paceOn(h, min: 600, max: 600)
            let (_, ds) = try approvedBatch(h, 2)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "first send")
            h.clock.now = h.clock.now.addingTimeInterval(31)
            try expect(isHeld(try h.tickNow()), "31 s into a 600 s pause: held")
            try h.set("pace_min_s", "2"); try h.set("pace_max_s", "30")
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "after loosening to 30 s the pause is over")
        }
        test("pacing on, then off again: the saved pause is ignored and the fixed 2 s gap applies") { h in
            try paceOn(h, min: 600, max: 600)
            let (_, ds) = try approvedBatch(h, 2)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "first send")
            try h.set("pace_enabled", "0")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "pacing off: 2 s is enough")
        }
        test("pacing on: the daily limit counts sends started since local midnight, then waits for the next day") { h in
            try paceOn(h, min: 2, max: 2, cap: 2)
            let (_, ds) = try approvedBatch(h, 3)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "send 1")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "send 2")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            let r = try h.tickNow()
            try expect(isHeld(r) && heldText(r).contains("daily limit reached (2/2)") && h.sendRows(ds[2].draftId).isEmpty, "third must wait: \(r)")
            try expect(stateValue(h, "pace_hold") == "daily" && Time.parse(stateValue(h, "pace_until")) == nyMidnightNext, "daily hold until the next local midnight: \(stateValue(h, "pace_until"))")
            h.clock.now = nyMidnightNext.addingTimeInterval(-1)
            try expect(isHeld(try h.tickNow()), "1 s before midnight: still held")
            h.clock.now = nyMidnightNext
            try expect(try h.tickNow() == .processed(draftId: ds[2].draftId, result: "sent"), "after local midnight the count starts again")
            h.clock.now = h.clock.now.addingTimeInterval(5)
            try expect(try h.tickNow() == .idle && stateValue(h, "pace_hold") == "", "nothing waiting: the hold is cleared")
        }
        test("pacing on: quiet hours that wrap midnight (21:00 to 09:00) hold sending and resume at the end") { h in
            try paceOn(h, min: 2, max: 2, quiet: ("21:00", "09:00"))
            var long = ApprovalOpts(); long.notAfter = Harness.baseTime.addingTimeInterval(7 * 86_400)    // the window a paced batch gets
            let (_, ds) = try approvedBatch(h, 2, long)
            h.clock.now = Time.parse("2026-11-11T02:30:00Z")!               // 21:30 in New York
            var r = try h.tickNow()
            try expect(isHeld(r) && heldText(r).contains("quiet hours until 09:00"), "21:30 is quiet: \(r)")
            try expect(stateValue(h, "pace_hold") == "quiet" && Time.parse(stateValue(h, "pace_until")) == ny9amNext, "quiet hold until 09:00 tomorrow: \(stateValue(h, "pace_until"))")
            h.clock.now = Time.parse("2026-11-11T08:00:00Z")!               // 03:00
            try expect(isHeld(try h.tickNow()), "03:00 is still quiet")
            h.clock.now = ny9amNext.addingTimeInterval(-1)
            try expect(isHeld(try h.tickNow()), "08:59:59 is still quiet")
            h.clock.now = ny9amNext
            r = try h.tickNow()
            try expect(r == .processed(draftId: ds[0].draftId, result: "sent"), "09:00 sharp is open: \(r)")
            h.clock.now = Time.parse("2026-11-12T01:59:00Z")!               // 20:59 that evening
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "20:59 is open: quiet hours start at 21:00")
        }
        test("pacing on: quiet hours inside one day (12:00 to 13:00) and an hour of daily-limit plus quiet resume together") { h in
            try paceOn(h, min: 2, max: 2, quiet: ("12:00", "13:00"))
            let (_, ds) = try approvedBatch(h, 1)
            let r = try h.tickNow()                                         // 12:00 sharp in New York
            try expect(isHeld(r) && Time.parse(stateValue(h, "pace_until")) == Time.parse("2026-11-10T18:00:00Z")!, "12:00 is quiet until 13:00: \(r)")
            h.clock.now = Time.parse("2026-11-10T18:00:00Z")!
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "13:00 is open")
            // limit reached today AND quiet overnight: it resumes at 09:00 tomorrow and says "daily limit"
            let h2 = try Harness(schema: h.schema, name: "pace-combo", parent: (h.dir as NSString).deletingLastPathComponent)
            try paceOn(h2, min: 2, max: 2, cap: 1, quiet: ("21:00", "09:00"))
            let (_, d2) = try approvedBatch(h2, 2)
            try expect(try h2.tickNow() == .processed(draftId: d2[0].draftId, result: "sent"), "first send at noon")
            h2.clock.now = h2.clock.now.addingTimeInterval(5)
            let r2 = try h2.tickNow()
            try expect(isHeld(r2) && stateValue(h2, "pace_hold") == "daily" && Time.parse(stateValue(h2, "pace_until")) == ny9amNext, "limit + quiet: daily, until 09:00: \(r2) \(stateValue(h2, "pace_until"))")
            h2.clock.now = ny9amNext
            try expect(try h2.tickNow() == .processed(draftId: d2[1].draftId, result: "sent"), "09:00 tomorrow: the rest goes out")
        }
        test("pacing applies to live sends as well as dry ones") { h in
            try h.goLiveSimple(allowed: true)
            try paceOn(h, min: 60, max: 60)
            let b = try h.makeBatch()
            let d0 = try h.makeDraft(batch: b, position: 0), d1 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            try h.approve(batch: b, items: [d0, d1], liveOpts())
            try expect(try h.tickNow() == .processed(draftId: d0.draftId, result: "sent") && h.live.calls.count == 1, "first live send")
            try expect(isHeld(try h.tickNow()) && h.live.calls.count == 1, "the second live send waits")
            h.clock.now = h.clock.now.addingTimeInterval(60)
            try expect(try h.tickNow() == .processed(draftId: d1.draftId, result: "sent") && h.live.calls.count == 2, "and goes after the pause")
        }
        test("pacing on: contact changes are not paced (an approved create applies while a message waits out its pause)") { h in
            ready(h)
            try paceOn(h, min: 600, max: 600)
            let (_, ds) = try approvedBatch(h, 2)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "first message")
            let set = try h.makeSet(status: "drafting")
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            let r = try h.tickNow()
            try expect(isHeld(r) && h.sendRows(ds[1].draftId).isEmpty, "the message still waits: \(r)")
            try expect(h.chgStatus(c.id) == "applied", "the contact change ignores the pause, is \(h.chgStatus(c.id))")
        }
        test("pacing settings: clamped into range, bad quiet hours ignored, off by default") { _ in
            try expect(!PaceSettings.load([:]).enabled, "missing rows = off")
            var p = PaceSettings.load(["pace_enabled": "1", "pace_min_s": "0", "pace_max_s": "99999", "daily_cap": "-5", "quiet_start": "25:00", "quiet_end": "09:00"])
            try expect(p.enabled && p.minS == 2 && p.maxS == 3600 && p.dailyCap == 0 && p.quietStart == nil && p.quietEnd == nil, "clamping: \(p)")
            p = PaceSettings.load(["pace_enabled": "1", "pace_min_s": "90", "pace_max_s": "30", "quiet_start": "21:00", "quiet_end": "21:00"])
            try expect(p.minS == 90 && p.maxS == 90 && p.quietStart == nil, "max below min is raised to min; equal quiet times mean none: \(p)")
            p = PaceSettings.load(["pace_enabled": "1", "quiet_start": "21:00", "quiet_end": "09:00"])
            try expect(p.quietStart == 1260 && p.quietEnd == 540, "21:00 / 09:00 parse")
            try expect(Pacing.evaluate(now: Harness.baseTime, pace: PaceSettings(), nextSendAt: Harness.baseTime.addingTimeInterval(500), sentToday: 99, tz: .current) == nil, "off is never a hold")
        }
    }
}
