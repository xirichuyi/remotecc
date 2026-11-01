#if canImport(SwiftUI)
import SwiftUI
import MarkdownUI

/// Shared by messages, tool output and document previews.
/// Configure the complete theme together so inherited document backgrounds do not leak into chat.
extension Theme {
    static let remoteCC = Theme()
        .text {
            FontSize(14)
            ForegroundColor(WorkbenchTheme.ink)
            BackgroundColor(nil)
        }
        .strong { FontWeight(.semibold) }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.9))
            BackgroundColor(WorkbenchTheme.sidebar)
        }
        .link { ForegroundColor(WorkbenchTheme.accent) }
        .heading1 { heading($0.label, size: 23, top: 20) }
        .heading2 { heading($0.label, size: 19, top: 18) }
        .heading3 { heading($0.label, size: 16, top: 14) }
        .heading4 { heading($0.label, size: 14, top: 12) }
        .heading5 { heading($0.label, size: 14, top: 12) }
        .heading6 { heading($0.label, size: 14, top: 12) }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.3))
                .markdownMargin(top: 0, bottom: 12)
        }
        .listItem { configuration in
            configuration.label.markdownMargin(top: 3, bottom: 3)
        }
        .blockquote { configuration in
            configuration.label
                .markdownTextStyle { ForegroundColor(.secondary) }
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(WorkbenchTheme.accent.opacity(0.35)).frame(width: 3)
                }
                .markdownMargin(top: 6, bottom: 12)
        }
        .codeBlock { configuration in
            FencedCodeView(text: configuration.content, language: configuration.language ?? "")
                .markdownMargin(top: 6, bottom: 14)
        }
        .taskListMarker { configuration in
            Image(systemName: configuration.isCompleted ? "checkmark.square.fill" : "square")
                .foregroundStyle(configuration.isCompleted ? WorkbenchTheme.accent : Color.secondary)
                .font(.system(size: 13))
                .relativeFrame(minWidth: .em(1.5), alignment: .trailing)
        }
        .table { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownTableBorderStyle(.init(color: WorkbenchTheme.border))
                    .markdownTableBackgroundStyle(.alternatingRows(.clear, WorkbenchTheme.sidebar.opacity(0.45)))
            }
            .markdownMargin(top: 6, bottom: 14)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(13)
                    if configuration.row == 0 { FontWeight(.semibold) }
                    BackgroundColor(nil)
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(configuration.row == 0 ? WorkbenchTheme.sidebar : .clear)
        }
        .thematicBreak {
            Rectangle().fill(WorkbenchTheme.border).frame(height: 1)
                .markdownMargin(top: 16, bottom: 16)
        }
}

private func heading<Content: View>(_ label: Content, size: CGFloat, top: CGFloat) -> some View {
    label
        .markdownTextStyle { FontSize(size); FontWeight(.semibold); BackgroundColor(nil) }
        .relativeLineSpacing(.em(0.15))
        .markdownMargin(top: top, bottom: 10)
}
#endif
