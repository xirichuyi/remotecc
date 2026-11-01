#if canImport(SwiftUI)
import SwiftUI
import RemoteCCCore

struct ActivitySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var stopping = Set<String>()
    @State private var stopErrors: [String: String] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SheetHeading(title: "所有机器的任务", subtitle: "查看进行中的工作、待确认操作与新结果") { dismiss() }
            Toggle("任务完成或等待确认时通知我", isOn: Binding(get: { model.notificationsEnabled }, set: { model.setNotifications($0) }))
                .font(.caption)
            HStack {
                Button("发送测试通知") { model.testNotification() }.disabled(!model.notificationsEnabled || model.notificationTestRunning)
                if model.notificationsAuthorizing { ProgressView().controlSize(.small) }
                Text(model.notificationTestStatus).font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(model.savedMachines, id: \.key) { machine in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label(machine.host, systemImage: "desktopcomputer").font(.headline)
                                Spacer()
                                let online = model.engine?.connectionState(machine).status == .connected
                                Text(online ? "已连接" : "离线 · 状态可能不是最新").font(.caption).foregroundStyle(.secondary)
                                if !online { Button("连接") { model.perform { try await model.connect(machine) } } }
                            }
                            let sessions = model.attentionSessions.filter { $0.config.key == machine.key }
                            if sessions.isEmpty { Text("暂无待处理任务").font(.caption).foregroundStyle(.secondary) }
                            ForEach(sessions) { session in
                                VStack(alignment: .leading, spacing: 8) {
                                    Button { model.select(session.id); dismiss() } label: {
                                        HStack {
                                            Text(historyDisplayTitle(session.name)).lineLimit(1)
                                            Spacer()
                                            Text(!session.permissions.isEmpty ? "等待确认" : model.unreadSessions.contains(session.id) && !session.isBusy ? "有新结果" : statusLabel(session.status))
                                                .font(.caption).foregroundStyle(WorkbenchTheme.accent)
                                            Image(systemName: "chevron.right").font(.caption)
                                        }.contentShape(Rectangle())
                                    }.buttonStyle(.plain)
                                    ForEach(Array((session.tasks?.array ?? []).enumerated()), id: \.offset) { _, task in
                                        HStack(alignment: .top) {
                                            Image(systemName: task["status"]?.string == "running" ? "circle.dotted" : "checkmark.circle")
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(task["description"]?.string ?? "后台任务").font(.caption).lineLimit(2)
                                                if let summary = task["summary"]?.string { Text(summary).font(.caption2).foregroundStyle(.secondary).lineLimit(3) }
                                                if let id = task["id"]?.string, let error = stopErrors[session.id + id] { Text(error).font(.caption2).foregroundStyle(.red) }
                                            }
                                            Spacer()
                                            if task["status"]?.string == "running", let id = task["id"]?.string {
                                                let key = session.id + id
                                                Button(stopping.contains(key) ? "正在停止…" : "停止") {
                                                    stopping.insert(key); stopErrors[key] = nil
                                                    Task {
                                                        defer { stopping.remove(key) }
                                                        do { try await model.engine?.stopBackgroundTask(session.id, task: id) }
                                                        catch { stopErrors[key] = error.localizedDescription }
                                                    }
                                                }
                                                .disabled(stopping.contains(key) || model.engine?.connectionState(session.config).status != .connected)
                                            }
                                        }.foregroundStyle(.secondary)
                                    }
                                }.padding(12).background(WorkbenchTheme.canvas, in: RoundedRectangle(cornerRadius: 9))
                            }
                        }.padding(16).background(WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if model.attentionSessions.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "checkmark.circle").font(.system(size: 30, weight: .light)).foregroundStyle(WorkbenchTheme.accent.opacity(0.7))
                            Text("暂时没有需要处理的任务").font(.system(size: 14, weight: .medium))
                            Text(model.savedMachines.isEmpty ? "连接机器后，任务会汇总在这里。" : "正在运行、等待确认和未读的结果都会出现在这里。")
                                .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                }
            }
        }.padding(24).frame(width: 680, height: 480).background(WorkbenchTheme.canvas)
    }
}
#endif
