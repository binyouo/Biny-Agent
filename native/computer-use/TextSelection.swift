import Foundation

/// 无障碍选区使用 UTF-16 偏移；必须唯一匹配，不能默认选择重复文字的第一处。
func matchingTextRange(in text: String, match: String, prefix: String? = nil, suffix: String? = nil, selectionType: String = "text") throws -> NSRange {
    func failure(_ code: String) -> NSError { NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: code]) }
    guard !match.isEmpty else { throw failure("text_match_invalid") }
    let source = text as NSString
    let before = (prefix ?? "") as NSString
    let after = (suffix ?? "") as NSString
    var start = 0
    var selected: NSRange?
    while start < source.length {
        let found = source.range(of: match, options: .literal, range: NSRange(location: start, length: source.length - start))
        if found.location == NSNotFound { break }
        let end = found.location + found.length
        if found.location >= before.length && end + after.length <= source.length,
           source.substring(with: NSRange(location: found.location - before.length, length: before.length)) == prefix ?? "",
           source.substring(with: NSRange(location: end, length: after.length)) == suffix ?? "" {
            if selected != nil { throw failure("text_match_ambiguous") }
            selected = found
        }
        start = found.location + 1
    }
    guard let result = selected else { throw failure("text_match_not_found") }
    switch selectionType {
    case "text": return result
    case "cursor_before": return NSRange(location: result.location, length: 0)
    case "cursor_after": return NSRange(location: result.location + result.length, length: 0)
    default: throw failure("text_selection_type_invalid")
    }
}
