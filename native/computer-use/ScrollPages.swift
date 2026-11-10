enum PageScrollResult: Equatable {
    case unavailable
    case complete(Int)
    case partial(Int)
    case unknown(Int, Int32)
}

func scrollPageFraction(viewport: Double, content: Double) -> Double? {
    guard viewport.isFinite, content.isFinite, viewport > 0, content > viewport else { return nil }
    return min(1, viewport / (content - viewport))
}

func performPageScroll<Candidate>(pages: Int, candidates: [Candidate], perform: (Candidate) throws -> AccessibilityActionResult) rethrows -> PageScrollResult {
    guard pages > 0 else { return .unavailable }
    for candidate in candidates {
        switch try perform(candidate) {
        case .unsupported: continue
        case .unknown(let code): return .unknown(0, code)
        case .success: break
        }
        for completed in 1..<pages {
            switch try perform(candidate) {
            case .success: continue
            case .unsupported: return .partial(completed)
            case .unknown(let code): return .unknown(completed, code)
            }
        }
        return .complete(pages)
    }
    return .unavailable
}
