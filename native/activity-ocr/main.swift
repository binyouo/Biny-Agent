// 独立 OCR 工具：读取图像并输出 Vision 的逐行识别结果。
//
// 默认输出与历史上一致（每行一段文字），Activity 等既有调用方不受影响。
// 传 --coords 时改为输出 `x,y,w,h<TAB>文字`：计算机操控要靠这个把引导浮层
// 对到界面上的那个控件旁边，只有文字没有位置是定位不了的。
import Foundation
import Vision
import AppKit

var arguments = Array(CommandLine.arguments.dropFirst())
let wantsCoordinates = arguments.contains("--coords")
arguments.removeAll { $0 == "--coords" }
if arguments.isEmpty { exit(64) }
let imagePath = arguments[0]
let languages = arguments.count > 1 ? Array(arguments.dropFirst()) : ["en-US", "zh-Hans", "zh-Hant", "ja"]

do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    let url = URL(fileURLWithPath: imagePath)
    try VNImageRequestHandler(url: url).perform([request])
    let results = request.results ?? []
    if wantsCoordinates {
        guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            fputs("OCR failed to read image size\n", stderr); exit(1)
        }
        let width = CGFloat(cg.width), height = CGFloat(cg.height)
        for observation in results {
            guard let text = observation.topCandidates(1).first?.string else { continue }
            // Vision 的 boundingBox 是左下原点归一化坐标；调用方要的是左上原点像素。
            let box = observation.boundingBox
            let x = Int((box.origin.x * width).rounded())
            let y = Int(((1 - box.origin.y - box.height) * height).rounded())
            print("\(x),\(y),\(Int((box.width * width).rounded())),\(Int((box.height * height).rounded()))\t\(text)")
        }
    } else {
        print(results.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
    }
} catch { fputs("OCR failed\n", stderr); exit(1) }
