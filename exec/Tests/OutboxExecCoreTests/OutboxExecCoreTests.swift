import Testing
import Foundation
@testable import OutboxExecCore

// The AppleScript tests only GENERATE script text; nothing here executes AppleScript or touches Messages/Contacts.
@Suite struct AppleScriptSourceTests {
    @Test func nastyInputsStayInsideLiterals() throws {
        let nasty = [
            "say \"hi\"", "back\\slash \\\" mix", "a\nb\n\nc", "emoji 😀👍🏽",
            "\" & do shell script \"touch /tmp/pwned\" & \"", "windows\r\nnewline",
        ]
        for body in nasty {
            let script = try AppleScriptSource.script(handle: "+15551234567", body: body, service: "iMessage")
            try AppleScriptCheck.verify(script: script, handle: "+15551234567", body: body, service: "iMessage")
        }
    }

    @Test func exampleOutput() throws {
        let script = try AppleScriptSource.script(handle: "+15551234567", body: "a \"b\" \\ c\n\" & do shell script \"id\" & \"", service: "iMessage")
        #expect(script.contains("send (\"a \\\"b\\\" \\\\ c\" & linefeed & \"\\\" & do shell script \\\"id\\\" & \\\"\") to theParticipant"))
    }

    @Test func badHandlesRefused() {
        for h in ["", "+0123456789", "+12345", "5551234567", "+1555\"", "+15551234567\n", "a b@c.com"] {
            #expect(AppleScriptSource.validateHandle(h) != nil, "accepted \(h.debugDescription)")
        }
    }

    @Test func controlCharactersRefused() {
        #expect(AppleScriptSource.validateBody("bell\u{07}") != nil)
        #expect(AppleScriptSource.validateBody("tab\tand\nnewline") == nil)
    }
}

@Suite struct EncodingTests {
    @Test func base64urlAcceptsPaddingOrNot() {
        #expect(B64.decodeURL("YQ") == Data("a".utf8))
        #expect(B64.decodeURL("YQ==") == Data("a".utf8))
        #expect(B64.decodeURL("YQ=") == nil)
        #expect(B64.decodeURL("a+b/") == nil)
    }
}

/// The full verification suite (also available as `outbox-exec selftest`).
@Suite struct SelftestSuite {
    @Test func selftestPasses() {
        #expect(SelfTest.run(keep: false, schemaPath: nil))
    }
}
