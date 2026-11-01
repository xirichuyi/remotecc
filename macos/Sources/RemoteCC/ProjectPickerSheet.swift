#if canImport(SwiftUI)
import SwiftUI
import RemoteCCCore

struct ProjectPickerSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var directory = ""
    @State private var busy = false
    @State private var error = ""

    private var recent: [String] {
        Array(Set(model.sessions.filter { $0.config.key == model.active?.config.key }.map(\.directory))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SheetHeading(title: "选择项目") { dismiss() }.disabled(busy)
            Label(model.active?.host ?? "", systemImage: "server.rack").font(.callout).foregroundStyle(.secondary)
            TextField("远端项目路径", text: $directory).textFieldStyle(.roundedBorder)
            if !recent.isEmpty {
                Text("最近的项目").font(.caption).foregroundStyle(.secondary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(recent, id: \.self) { path in
                            Button { directory = path } label: {
                                HStack {
                                    Label(path, systemImage: "folder").lineLimit(1).truncationMode(.middle)
                                    Spacer()
                                    if directory == path { Image(systemName: "checkmark") }
                                }.padding(3).contentShape(Rectangle())
                            }.buttonStyle(QuietButtonStyle())
                        }
                    }
                }.frame(maxHeight: 140)
            }
            Text("切换到其他项目会新建对话，并带上未发送的草稿。原对话保留在原项目中。")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "检查目录…" : "使用此项目") {
                    busy = true; error = ""
                    Task {
                        do { try await model.chooseProject(directory); dismiss() }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }.buttonStyle(WorkbenchButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
                    .disabled(busy || directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.isConnected)
            }
        }
        .padding(28).frame(width: 460).background(WorkbenchTheme.canvas)
        .interactiveDismissDisabled(busy)
        .onAppear { directory = model.proposedProject ?? model.active?.directory ?? "~" }
    }
}
#endif
