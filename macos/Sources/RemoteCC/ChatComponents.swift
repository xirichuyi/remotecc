#if canImport(SwiftUI)
import SwiftUI
import AppKit

struct ThinkingCard: View {
    let text: String
    let active: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 9) {
                    Image(systemName: "sparkles").foregroundStyle(WorkbenchTheme.accent)
                    Text(active ? "正在思考" : "思考过程").font(.system(size: 12, weight: .medium))
                    if active { ProgressView().controlSize(.mini) }
                    Spacer()
                    Text(expanded ? "收起思考" : "查看思考").font(.system(size: 11)).foregroundStyle(.tertiary)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 9)).foregroundStyle(.secondary)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton).accessibilityLabel((active ? "正在思考" : "思考过程") + (expanded ? "，收起" : "，展开"))
            if expanded {
                ScrollView {
                    Text(text.isEmpty ? "等待远端返回思考内容…" : text)
                        .font(.system(size: 13)).lineSpacing(5).foregroundStyle(.secondary)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 260).fixedSize(horizontal: false, vertical: true)
            } else if active {
                Text(text.isEmpty ? "正在分析你的请求…" : String(text.suffix(140)).replacingOccurrences(of: "\n", with: " "))
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    .accessibilityHidden(true)
            }
        }.padding(12)
            .background(WorkbenchTheme.sidebar.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct FencedCodeView: View {
    let text: String
    let language: String
    @State private var copied = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language.isEmpty ? "代码" : language).font(.system(size: 11, weight: .medium, design: .monospaced))
                Spacer()
                Button { copyToPasteboard(text); copied = true } label: {
                    Label(copied ? "已复制" : "复制代码", systemImage: copied ? "checkmark" : "doc.on.doc")
                }.buttonStyle(QuietButtonStyle()).font(.system(size: 11))
            }.foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 3)
            Divider()
            ScrollView([.horizontal, .vertical]) {
                Text(highlightedCode(text, language: language)).font(.system(size: 12, design: .monospaced)).lineSpacing(4)
                    .textSelection(.enabled).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }.defaultScrollAnchor(.topLeading).frame(maxHeight: 380).fixedSize(horizontal: false, vertical: true)
        }.background(WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 10))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(WorkbenchTheme.border))
            .task(id: copied) {
                if copied { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
            }
    }
}

/// macOS wheel events are not SwiftUI drag gestures. Observe only events over this
/// message viewport, return every event unchanged, and remove the monitor on teardown.
struct ScrollReadingDetector: NSViewRepresentable {
    let onReadEarlier: () -> Void
    func makeNSView(context: Context) -> ReadingView {
        let view = ReadingView(); view.onReadEarlier = onReadEarlier; return view
    }
    func updateNSView(_ view: ReadingView, context: Context) { view.onReadEarlier = onReadEarlier }
    static func dismantleNSView(_ view: ReadingView, coordinator: ()) { view.removeMonitor() }

    final class ReadingView: NSView {
        var onReadEarlier: (() -> Void)?
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeMonitor()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown]) { [weak self] event in
                guard let self, let window = self.window, event.window === window else { return event }
                let point = self.convert(event.locationInWindow, from: nil)
                if self.bounds.contains(point) {
                    if event.type == .scrollWheel && event.scrollingDeltaY > 0 { self.onReadEarlier?() }
                    // Clicking a message may start text selection or drag the scrollbar.
                    if event.type == .leftMouseDown { self.onReadEarlier?() }
                }
                return event
            }
        }
        func removeMonitor() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}
#endif
