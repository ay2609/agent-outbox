import Foundation

/// Generates the AppleScript source for one Messages send. Pure text generation: nothing here executes anything.
///
/// Rules (the only way text reaches the script):
///  - handle: must be an E.164 phone (`^\+[1-9][0-9]{6,14}$`) or a plain ASCII email; anything else is refused.
///  - body: control characters other than \n \t (and \r, folded into \n) are refused. Each line becomes an
///    AppleScript string literal with `\` and `"` escaped; lines are joined with ` & linefeed & `.
///  - the generated script therefore contains no input text outside string literals.
public enum AppleScriptSource {
    public static let maxBodyScalars = 10_000

    public static func validateHandle(_ h: String) -> String? {
        if h.isEmpty { return "empty handle" }
        if h.unicodeScalars.contains(where: { $0.value < 0x21 || $0.value > 0x7E }) { return "handle has control, space or non-ASCII characters" }
        if h.hasPrefix("+") {
            let digits = h.dropFirst()
            guard digits.count >= 7, digits.count <= 15, digits.allSatisfy({ $0 >= "0" && $0 <= "9" }), digits.first != "0" else {
                return "phone handle is not E.164 (+ then 7-15 digits, no leading 0)"
            }
            return nil
        }
        return validateEmail(h)
    }

    static func validateEmail(_ h: String) -> String? {
        guard h.count <= 254 else { return "email too long" }
        let parts = h.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[0].count <= 64 else { return "handle is neither E.164 nor an email" }
        let localOK = parts[0].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._%+-'".contains($0)) }
        guard localOK else { return "email local part has unsupported characters" }
        let labels = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") } }),
              let tld = labels.last, tld.count >= 2, tld.allSatisfy({ $0.isLetter })
        else { return "email domain is invalid" }
        return nil
    }

    /// Reason string if the body can't be sent as written, else nil.
    public static func validateBody(_ b: String) -> String? {
        if b.isEmpty { return "empty body" }
        if b.unicodeScalars.count > maxBodyScalars { return "body longer than \(maxBodyScalars) characters" }
        for u in b.unicodeScalars {
            let v = u.value
            if v == 0x0A || v == 0x09 || v == 0x0D { continue }
            if v < 0x20 || v == 0x7F || (v >= 0x80 && v <= 0x9F) { return "body contains control character U+\(String(format: "%04X", v))" }
        }
        return nil
    }

    /// One escaped AppleScript string literal (quotes included) for text with no newlines.
    public static func literal(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\t": out += "\\t"
            default: out.unicodeScalars.append(u)
            }
        }
        out += "\""
        return out
    }

    /// An AppleScript expression for a multi-line body: `"a" & linefeed & "b"`.
    public static func bodyExpression(_ body: String) -> String {
        let normalized = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        return "(" + lines.map(literal).joined(separator: " & linefeed & ") + ")"
    }

    /// `service` must be "iMessage" or "SMS" (the `auto` fallback is handled by the transport).
    public static func script(handle: String, body: String, service: String) throws -> String {
        guard service == "iMessage" || service == "SMS" else { throw ExecError("service must be iMessage or SMS here, not \(service)") }
        if let why = validateHandle(handle) { throw ExecError(why) }
        if let why = validateBody(body) { throw ExecError(why) }
        return """
        tell application "Messages"
        \twith timeout of 60 seconds
        \t\tset theParticipant to participant \(literal(handle)) of (1st account whose service type = \(service))
        \t\tsend \(bodyExpression(body)) to theParticipant
        \tend timeout
        end tell
        """
    }
}
