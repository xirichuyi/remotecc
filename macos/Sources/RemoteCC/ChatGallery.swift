#if DEBUG && canImport(SwiftUI)
import SwiftUI
import RemoteCCCore

/// Local fixtures for visual QA; never submits messages or requests to a server.
struct ChatGallery: View {
    @Environment(\.dismiss) private var dismiss
    @State private var phase = "思考中"
    @State private var answered = false
    private let phases = ["思考中", "工具执行", "回复完成", "已停止", "失败", "权限确认"]
    private var sample: ChatMessage {
        var tool = Block(type: "tool", name: "Bash", input: ["command": "swift test --filter ChatTests", "description": "验证聊天状态"], status: phase == "工具执行" ? "running" : "done", output: "Executed 9 tests, with 0 failures.")
        tool.elapsed = 2
        var blocks = [Block(type: "thinking", text: "这是界面测试用的示例思考内容，不是模型的真实推理。\n\n先核对消息类型，再检查流式更新、工具执行结果和用户确认状态。长内容可以展开阅读，收起后不会占满聊天区域。")]
        if phase != "思考中" { blocks.append(tool) }
        if phase == "回复完成" { blocks.append(Block(type: "text", text: "## 聊天界面已更新\n支持 **思考折叠**、工具状态和代码复制。\n\n```swift\nlet state = ChatState.completed\nprint(state)\n```\n\n| 状态 | 展示 |\n| --- | --- |\n| 思考 | 可展开 |\n| 工具 | 状态与输出 |\n\n> 上滚阅读时暂停跟随。")) }
        var message = ChatMessage(role: "assistant", blocks: blocks)
        if phase == "已停止" { message.interrupted = true }
        if phase == "失败" { message.error = "示例：连接中断，已生成的内容保留。" }
        return message
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("聊天交互预览 · 本地示例").font(.headline)
                Spacer()
                Button("关闭") { dismiss() }
            }.padding(20)
            Picker("状态", selection: $phase) { ForEach(phases, id: \.self) { Text($0) } }.pickerStyle(.segmented).padding(.horizontal, 20)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    MessageRow(message: ChatMessage(role: "user", text: "请检查聊天界面的展示效果。"), busy: false, actions: FileActions(open: { _, _ in }))
                    if phase == "权限确认", let permission = try? JSONDecoder().decode(PermissionRequest.self, from: Data(#"{"id":"preview","name":"Bash","title":"运行项目测试","description":"示例请求：仅用于检查界面，不会执行命令。","input":{"command":"swift test","description":"运行单元测试"}}"#.utf8)) {
                        if answered { Label("已处理 · 本地示例，未执行命令", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
                        else { PermissionCard(permission: permission, onAnswer: { _ in answered = true }) }
                    } else {
                    MessageRow(message: sample, busy: phase == "思考中" || phase == "工具执行", sessionStatus: "working", actions: FileActions(open: { _, _ in }))
                        .id(phase)
                    }
                }.padding(28)
            }
        }.frame(width: 760, height: 660).background(WorkbenchTheme.canvas)
    }
}
#endif
