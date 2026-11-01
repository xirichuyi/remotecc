#if canImport(SwiftUI)
import SwiftUI
import AppKit

enum WorkbenchTheme {
    static let canvas = adaptive(light: 0xFAF9F5, dark: 0x262624)
    static let sidebar = adaptive(light: 0xF0EEE6, dark: 0x20201E)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x30302E)
    static let ink = adaptive(light: 0x30302E, dark: 0xECEBE5)
    static let onInk = adaptive(light: 0xFFFFFF, dark: 0x262624)
    static let accent = adaptive(light: 0xB96345, dark: 0xD58B6D)
    static let userBubble = adaptive(light: 0xEEECE5, dark: 0x363632)
    static let border = Color.primary.opacity(0.09)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}

struct WorkbenchButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        WorkbenchButtonBody(configuration: configuration, prominent: prominent)
    }
}

private struct WorkbenchButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let prominent: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false
    var body: some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 13).padding(.vertical, 9)
            .foregroundStyle(prominent ? WorkbenchTheme.onInk : WorkbenchTheme.ink)
            .background(prominent ? WorkbenchTheme.ink : hovered && enabled ? WorkbenchTheme.sidebar : WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(prominent ? .clear : WorkbenchTheme.border))
            .opacity(!enabled ? 0.4 : configuration.isPressed ? 0.72 : 1)
            .onHover { hovered = $0 }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovered)
    }
}

/// Quiet actions retain a consistent hit area without a permanent button border.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { QuietButtonBody(configuration: configuration) }
}
private struct QuietButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @State private var hovered = false
    var body: some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(7)
            .contentShape(RoundedRectangle(cornerRadius: 7))
            .background(hovered && enabled ? Color.primary.opacity(0.055) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .opacity(enabled ? (configuration.isPressed ? 0.6 : 1) : 0.35)
            .onHover { hovered = $0 }
    }
}

struct SheetHeading: View {
    let title: String
    var subtitle: String = ""
    let close: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 7) {
                Text(title).font(.system(size: 21, weight: .semibold)).tracking(-0.4)
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            Button(action: close) { Image(systemName: "xmark").frame(width: 16, height: 16) }
                .buttonStyle(QuietButtonStyle()).help("关闭").accessibilityLabel("关闭")
                .keyboardShortcut(.cancelAction)
        }
    }
}
#endif
