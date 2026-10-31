#if canImport(SwiftUI)
import SwiftUI
import AppKit
import RemoteCCCore

struct PreferencesSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var capabilities: Capabilities?
    @State private var loadError = ""
    @State private var agent = ""
    @State private var selectedModel = ""
    @State private var customModel = ""
    @State private var effort = ""
    @State private var permissionMode = "default"
    @State private var fastMode = false
    @State private var outputStyle = ""
    @State private var directories = ""
    @State private var error = ""
    @State private var saving = false

    private let customTag = "__custom__"
    private var currentModel: RemoteModel? { capabilities?.models.first { $0.value == (selectedModel.isEmpty ? "default" : selectedModel) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("模型与会话设置").font(.headline).padding()
            if let capabilities { form(capabilities) }
            else if !loadError.isEmpty { Text(loadError).foregroundStyle(.red).padding().textSelection(.enabled) }
            else { ProgressView("读取远端能力…").padding().frame(maxWidth: .infinity) }
            HStack {
                Button("刷新模型列表") { load(refresh: true) }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("应用") { apply() }.keyboardShortcut(.defaultAction).disabled(capabilities == nil || saving)
            }
            .padding()
        }
        .frame(width: 520)
        .task { load(refresh: false) }
    }

    private func form(_ capabilities: Capabilities) -> some View {
        let session = model.active
        return Form {
            Picker("Agent", selection: $agent) {
                Text("远端默认").tag("")
                ForEach(capabilities.agents ?? []) { Text($0.name).tag($0.name) }
                if !agent.isEmpty, capabilities.agents?.contains(where: { $0.name == agent }) != true { Text(agent + "（远端已不可用）").tag(agent) }
            }
            .disabled(session?.messages.isEmpty == false)
            .help(session?.messages.isEmpty == false ? "请在新对话中选择 Agent" : capabilities.agents?.first { $0.name == agent }?.description ?? "")
            Picker("模型", selection: $selectedModel) {
                Text("远端默认").tag("")
                ForEach(capabilities.models.filter { $0.value != "default" }) { Text($0.displayName ?? $0.value).tag($0.value) }
                Text("自定义模型 ID").tag(customTag)
            }
            if selectedModel == customTag { TextField("模型 ID", text: $customModel) }
            Picker("思考强度", selection: $effort) {
                Text("自动").tag("")
                ForEach(["low", "medium", "high", "xhigh", "max"].filter { currentModel == nil || currentModel?.supportedEffortLevels?.contains($0) == true }, id: \.self) { Text($0).tag($0) }
            }
            Picker("权限", selection: $permissionMode) {
                Text("默认 · 请求时确认").tag("default")
                Text("计划 · 不执行修改").tag("plan")
                Text("自动接受文件编辑").tag("acceptEdits")
                Text("拒绝未授权操作").tag("dontAsk")
                if currentModel == nil || currentModel?.supportsAutoMode == true { Text("自动判断权限").tag("auto") }
            }
            Toggle("快速模式（由模型与账户支持情况决定）", isOn: $fastMode).disabled(currentModel != nil && currentModel?.supportsFastMode != true)
            Picker("输出样式", selection: $outputStyle) {
                Text("远端默认").tag("")
                ForEach(capabilities.outputStyles ?? [], id: \.self) { Text($0).tag($0) }
            }
            VStack(alignment: .leading) {
                Text("额外工作目录（每行一个远端绝对路径）")
                TextEditor(text: $directories).font(.system(size: 12, design: .monospaced)).frame(height: 54).disabled(session?.isBusy == true)
            }
            Text("设置由远端确认。上一轮实际模型：" + (session?.model ?? "尚未调用")).font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }

    private func load(refresh: Bool) {
        guard let engine = model.engine, let session = model.active else { loadError = "请先连接 SSH"; return }
        loadError = ""
        let preferences = session.preferences ?? Preferences()
        Task {
            do {
                let result = try await engine.capabilities(session.id, refresh: refresh)
                agent = preferences.agent ?? ""
                let selected = preferences.selectedModel ?? ""
                if selected.isEmpty || result.models.contains(where: { $0.value == selected }) { selectedModel = selected }
                else { selectedModel = customTag; customModel = selected }
                effort = preferences.effort ?? ""
                permissionMode = preferences.permissionMode ?? "default"
                fastMode = preferences.fastMode ?? false
                outputStyle = preferences.outputStyle ?? ""
                directories = (preferences.additionalDirectories ?? []).joined(separator: "\n")
                capabilities = result
            } catch { loadError = error.localizedDescription }
        }
    }

    private func apply() {
        guard let engine = model.engine, let session = model.active else { return }
        var next = session.preferences ?? Preferences()
        next.agent = agent
        next.selectedModel = selectedModel == customTag ? customModel.trimmingCharacters(in: .whitespaces) : selectedModel
        next.effort = effort; next.permissionMode = permissionMode; next.fastMode = fastMode; next.outputStyle = outputStyle
        next.additionalDirectories = directories.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        saving = true; error = ""
        Task {
            do { try await engine.configure(session.id, next); dismiss() }
            catch { self.error = error.localizedDescription }
            saving = false
        }
    }
}

struct CommandPickerSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let interaction: CommandInteraction
    @State private var value = ""
    @State private var custom = ""

    private var options: [CommandOption] {
        var list = interaction.options
        if interaction.kind == .model, let selected = interaction.selected, !list.contains(where: { $0.value == selected }) {
            list.append(CommandOption(value: selected, label: selected))
        }
        return list
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("/" + interaction.command).font(.headline)
            Picker(interaction.kind == .model ? "选择模型" : "选择参数", selection: $value) {
                ForEach(options) { Text($0.label).tag($0.value) }
            }
            if interaction.kind == .model { TextField("或输入自定义模型 ID", text: $custom).textFieldStyle(.roundedBorder) }
            if let description = options.first(where: { $0.value == value })?.description ?? interaction.description {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(interaction.kind == .model ? "切换模型" : "执行") {
                    let choice = custom.trimmingCharacters(in: .whitespaces)
                    model.applyCommandPicker(interaction, value: choice.isEmpty ? value : choice)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(value.isEmpty && custom.isEmpty)
            }
        }
        .padding(20).frame(width: 440)
        .onAppear { value = interaction.selected ?? options.first?.value ?? "" }
    }
}

struct SessionToolsSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = "会话"
    @State private var content = ""
    @State private var localPort = ""
    @State private var remotePort = ""
    @State private var tunnels: [Tunnel] = []
    @State private var error = ""

    private let sections = [("status", "状态"), ("cost", "用量"), ("context", "上下文"), ("skills", "技能"), ("agents", "Agents"), ("mcp", "MCP"), ("plugins", "插件"), ("tasks", "任务")]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let session = model.active {
                HStack {
                    Button("新对话") { dismiss(); model.newConversation() }
                    Button("分支当前对话") { model.perform { if let fork = try model.engine?.fork(session.id) { dismiss(); model.select(fork.id) } } }
                    Button("导出…") { model.exportConversation(session) }
                    Button(session.pinned == true ? "取消固定" : "固定") { model.perform { try model.engine?.setPinned(session.id, session.pinned != true) } }
                    Button(session.archived == true ? "恢复" : "归档") { model.perform { try model.engine?.setArchived(session.id, session.archived != true) } }
                }
                HStack {
                    Button("模型与权限") { dismiss(); model.showPreferences = true }
                    Button("刷新远端命令") { model.refreshCapabilities(force: true); dismiss() }
                }
                HStack {
                    ForEach(sections, id: \.0) { section in
                        Button(section.1) { load(section.0, title: section.1, id: session.id) }
                    }
                }
                .controlSize(.small)
                Divider()
                Text("SSH 端口转发").font(.subheadline)
                HStack {
                    TextField("本地端口", text: $localPort).frame(width: 110)
                    TextField("远端端口", text: $remotePort).frame(width: 110)
                    Button("转发") { forward(session) }.disabled(Int(localPort) == nil || Int(remotePort) == nil)
                }
                .textFieldStyle(.roundedBorder)
                ForEach(tunnels) { tunnel in
                    HStack {
                        Button("localhost:\(tunnel.localPort) → 远端 \(tunnel.remotePort)") {
                            if let url = URL(string: "http://127.0.0.1:\(tunnel.localPort)") { NSWorkspace.shared.open(url) }
                        }.buttonStyle(.link)
                        Button("关闭") { close(tunnel, session) }.controlSize(.small)
                    }
                }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            }
            if !content.isEmpty { CodeBlock(text: content).frame(maxHeight: 300) }
        }
        .padding(20).frame(width: 640)
        .onAppear { if let session = model.active { tunnels = model.connections?.tunnels(session.config) ?? [] } }
    }

    private func load(_ section: String, title: String, id: String) {
        self.title = title; content = "读取中…"
        Task {
            do { content = try await model.engine?.details(id, section: section).text(pretty: true) ?? "" }
            catch { content = error.localizedDescription }
        }
    }

    private func forward(_ session: ChatSession) {
        guard let local = Int(localPort), let remote = Int(remotePort), let connections = model.connections else { return }
        error = ""
        Task {
            do { try await connections.forward(session.config, Tunnel(localPort: local, remotePort: remote)); tunnels = connections.tunnels(session.config) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func close(_ tunnel: Tunnel, _ session: ChatSession) {
        guard let connections = model.connections else { return }
        Task {
            do { try await connections.forward(session.config, tunnel, remove: true); tunnels = connections.tunnels(session.config) }
            catch { self.error = error.localizedDescription }
        }
    }
}
#endif
