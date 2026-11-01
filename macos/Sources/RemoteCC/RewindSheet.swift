#if canImport(SwiftUI)
import SwiftUI
import RemoteCCCore

struct RewindSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    let checkpoint: String
    @State private var preview: JSON?
    @State private var busy = false
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SheetHeading(title: "回退本轮之前的文件") { dismiss() }.disabled(busy)
            Text("这会恢复已跟踪文件，也可能删除本轮新建的文件。聊天记录保持原样；Bash 与子代理修改不保证被跟踪。").font(.callout).foregroundStyle(.secondary)
            if busy { ProgressView("正在处理…") }
            if let preview {
                ScrollView { VStack(alignment: .leading, spacing: 6) {
                    ForEach(preview["filesChanged"]?.array?.compactMap(\.string) ?? [], id: \.self) { Text($0).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 240)
                if preview["canRewind"]?.bool != true { Text(preview["error"]?.string ?? "无可回退的文件").foregroundStyle(.secondary) }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            HStack {
                Button("重新预览") { perform(apply: false) }.disabled(busy)
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(WorkbenchButtonStyle()).disabled(busy)
                Button("确认回退这些文件", role: .destructive) { perform(apply: true) }
                    .disabled(busy || preview?["canRewind"]?.bool != true || preview?["token"]?.string == nil)
            }
        }.padding(24).frame(width: 580).background(WorkbenchTheme.canvas).interactiveDismissDisabled(busy)
            .task { perform(apply: false) }
    }
    private func perform(apply: Bool) {
        guard let engine = model.engine else { return }
        let token = apply ? preview?["token"]?.string : nil
        busy = true; error = ""
        Task {
            defer { busy = false }
            do {
                let result = try await engine.rewindFiles(sessionId, checkpoint: checkpoint, token: token)
                if apply {
                    guard result["canRewind"]?.bool == true else { error = result["error"]?.string ?? "回退未完成"; preview = nil; return }
                    model.show((result["skippedLinks"]?.int ?? 0) > 0 ? "回退已执行，部分特殊路径被跳过，请检查文件。" : "文件已回退，聊天记录保持不变。")
                    if model.activeId == sessionId { await model.activeWorkspace?.reload(force: true) }
                    dismiss()
                } else { preview = result }
            } catch { self.error = error.localizedDescription; preview = nil }
        }
    }
}
#endif
