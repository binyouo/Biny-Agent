// 独立 OCR 工具：读取图像并输出 Vision 的逐行识别结果。
import Foundation
import Vision
import AppKit
let arguments = CommandLine.arguments
if arguments.count < 2 { exit(64) }
do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = arguments.count > 2 ? Array(arguments.dropFirst(2)) : ["en-US", "zh-Hans", "zh-Hant", "ja"]
    try VNImageRequestHandler(url: URL(fileURLWithPath: arguments[1])).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print(lines.joined(separator: "\n"))
} catch { fputs("OCR failed\n", stderr); exit(1) }
