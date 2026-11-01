#if canImport(SwiftUI)
import SwiftUI
import AppKit
import RemoteCCCore

struct ChatAttachmentView: View {
    @EnvironmentObject private var model: AppModel
    let file: Attachment
    @State private var thumbnail: NSImage?
    @State private var loading = false
    @State private var error = ""
    private var imageFile: Bool { ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains((file.name as NSString).pathExtension.lowercased()) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let thumbnail { Image(nsImage: thumbnail).resizable().scaledToFit().frame(maxWidth: 280, maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 7)) }
            HStack(spacing: 8) {
                Image(systemName: imageFile ? "photo" : "doc.text")
                    .font(.system(size: 18)).foregroundStyle(WorkbenchTheme.accent)
                    .frame(width: 36, height: 36).background(WorkbenchTheme.sidebar, in: RoundedRectangle(cornerRadius: 9))
                Text(file.name).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)).foregroundStyle(.secondary)
            }.font(.caption)
            HStack {
                Button("打开") { model.open(file.path) }
                Button("下载") { model.download(file.path) }
                if imageFile && thumbnail == nil { Button("加载缩略图") { load() }.disabled(loading) }
                if loading { ProgressView().controlSize(.mini) }
            }.font(.caption).buttonStyle(QuietButtonStyle()).disabled(!model.isConnected)
            if !error.isEmpty { Text(error).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
        }.padding(12).background(WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(WorkbenchTheme.border))
    }
    private func load() {
        guard let session = model.active, let engine = model.engine else { return }
        loading = true; error = ""
        Task {
            defer { loading = false }
            do {
                let preview = try await engine.files.preview(session.config, file.path)
                guard let data = preview.data, let image = NSImage(data: data) else { error = "此文件无法生成图片预览"; return }
                thumbnail = image
            } catch { self.error = error.localizedDescription }
        }
    }
}
#endif
