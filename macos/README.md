# RemoteCC（macOS 原生客户端）

SwiftUI 客户端，通过系统 SSH 使用服务器上的 Claude Code。需要 macOS 14+ 和 Xcode 15.3+（或对应的命令行工具）。

## 构建

```sh
# 在仓库根目录安装打包服务端程序所需的 Claude Agent SDK
npm ci --ignore-scripts
# 生成 macos/dist/RemoteCC.app
macos/scripts/build-app.sh
open macos/dist/RemoteCC.app
```

## 结构

- `Sources/RemoteCCCore`：只依赖 Foundation，包含 SSH、代理协议、任务恢复、文件、历史、存储和展示逻辑，可在 Linux 上编译测试。
- `Sources/RemoteCC`：SwiftUI / AppKit 界面，只在 macOS 上编译。
- `scripts/prepare-server.cjs`：把 `../src` 下的服务端程序（`remote-agent.cjs` 和基于官方 SDK 的任务进程）打包进应用资源。

本地数据保存在 `~/Library/Application Support/RemoteCC Native`，与 Electron 版互不影响。

## 测试

```sh
cd macos && swift test
```

测试以真实子进程运行服务端代理（`sh -c` 代替 SSH 通道），需要 Node.js 和 `npm ci`。
