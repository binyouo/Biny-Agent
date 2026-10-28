import AppKit
import CoreGraphics

func appshotIconDataURL(_ icon: NSImage?) -> String? {
    guard let icon, let image = icon.cgImage(forProposedRect: nil, context: nil, hints: nil), image.width > 0, image.height > 0,
          let context = CGContext(data: nil, width: 96, height: 96, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    let scale = min(96.0 / Double(image.width), 96.0 / Double(image.height))
    let width = Double(image.width) * scale, height = Double(image.height) * scale
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: (96 - width) / 2, y: (96 - height) / 2, width: width, height: height))
    guard let scaled = context.makeImage(), let png = NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
}
