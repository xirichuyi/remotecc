#if canImport(SwiftUI)
import SwiftUI
import RemoteCCCore

struct MachineHomeView: View {
    @EnvironmentObject private var model: AppModel
    private var recent: [ChatSession] { Array(model.machineSessions.filter { $0.archived != true }.prefix(6)) }
    private var syncing: Bool { model.currentConfig.map { model.syncingMachines.contains($0.key) } ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.currentConfig == nil ? "你的机器，你的工作。" : "今天，想完成什么？")
                        .font(.system(size: 32, weight: .regular, design: .serif)).tracking(-0.8)
                        .foregroundStyle(WorkbenchTheme.ink)
                    Text(model.currentConfig == nil ? "连接一台机器，找回已有对话。\n在不同机器之间切换，工作始终各归其位。" : "在 \(model.currentConfig!.host) 上开始，或继续最近的对话。")
                        .font(.system(size: 14)).foregroundStyle(.secondary).lineSpacing(6)
                    if model.currentConfig == nil || !model.isConnected {
                    HStack(spacing: 12) {
                        if let config = model.currentConfig {
                            if !model.isConnected {
                                Button("连接机器") { model.perform { try await model.connect(config) } }
                                    .buttonStyle(WorkbenchButtonStyle()).disabled(syncing)
                            }
                        } else {
                            Button { model.showConnect = true } label: { Label("连接第一台机器", systemImage: "plus") }
                                .buttonStyle(WorkbenchButtonStyle(prominent: true))
                            Text("支持 SSH 别名与 user@host").font(.system(size: 11)).foregroundStyle(.tertiary)
                        }
                    }.padding(.top, 4)
                    }
                }
                if model.currentConfig != nil {
                    ComposerArea().padding(.horizontal, -22)
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text("最近对话").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                            Spacer()
                            if syncing { ProgressView().controlSize(.small) }
                            else {
                                Button { if let config = model.currentConfig { Task { await model.discoverHistory(config) } } } label: { Image(systemName: "arrow.clockwise") }
                                    .buttonStyle(.plain).disabled(!model.isConnected).help("同步远端历史")
                            }
                        }
                        if recent.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(syncing ? "正在读取远端历史…" : "还没有对话").font(.system(size: 14, weight: .medium))
                                Text(syncing ? "已有项目和对话会自动出现在这里。" : (model.historyStatus.isEmpty ? "连接后会自动同步历史，无需选择目录。" : model.historyStatus))
                                    .font(.system(size: 12)).foregroundStyle(.secondary)
                            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                                .background(WorkbenchTheme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
                        } else {
                            VStack(spacing: 0) {
                                ForEach(recent) { session in
                                    Button { model.select(session.id) } label: {
                                        HStack(spacing: 14) {
                                            Image(systemName: "bubble.left").font(.system(size: 15)).foregroundStyle(.secondary)
                                            VStack(alignment: .leading, spacing: 5) {
                                                Text(historyDisplayTitle(session.name)).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                                Text(session.directory).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                            }
                                            Spacer()
                                            Text(Date(timeIntervalSince1970: session.updatedAt / 1000), format: .dateTime.month().day())
                                                .font(.system(size: 10)).foregroundStyle(.tertiary)
                                            Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary)
                                        }.padding(16).contentShape(Rectangle())
                                    }.buttonStyle(.plain)
                                    if session.id != recent.last?.id { Divider().padding(.leading, 45) }
                                }
                            }.background(WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(WorkbenchTheme.border))
                        }
                    }
                } else {
                    HStack(alignment: .top, spacing: 32) {
                        feature("历史自动找回", detail: "接着终端里的对话继续", icon: "clock.arrow.circlepath")
                        feature("多台机器", detail: "每台机器保留独立历史", icon: "square.stack.3d.up")
                        feature("沿用现有环境", detail: "使用你的 SSH 配置和密钥", icon: "key")
                    }.padding(.top, 12)
                }
            }
            .frame(maxWidth: 620).padding(.horizontal, 44).padding(.top, 72).padding(.bottom, 48)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func feature(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Image(systemName: icon).font(.system(size: 16)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 12, weight: .medium))
            Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
