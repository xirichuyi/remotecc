import Foundation

/// Keeps the last online state across disconnects, so catch-up results aren't lost.
public struct TaskNotificationTracker {
    private struct Snapshot { var status: String; var background: Set<String> }
    private var snapshots: [String: Snapshot] = [:]
    public init() {}
    public mutating func update(id: String, status: String, background: Set<String>, connected: Bool, isViewed: Bool) -> String? {
        guard connected, status != "detached" else { return nil }
        let previous = snapshots.updateValue(Snapshot(status: status, background: background), forKey: id)
        guard let previous, !isViewed else { return nil }
        let completed = ["working", "connecting", "permission", "stopping"].contains(previous.status) && ["idle", "error", "stopped"].contains(status)
        let changed = previous.status != status && (status == "permission" || completed)
        guard changed || !previous.background.subtracting(background).isEmpty else { return nil }
        return status == "permission" ? "有一项任务等待你的确认" : status == "error" ? "一项任务未完成，请查看错误" : "一项任务已有新结果"
    }
}
