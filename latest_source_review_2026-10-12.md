# 最新正式版本源码复查：2026-10-12

本次重新检查的是当前 0.2.0 实现，而非历史 0.1.6。已按官方最新稳定版获取认证及 TUI 相关源码，发现的问题已修正。

## 源码基线

| 项目 | 本机版本 | 原工作区源码 | 本次官方最新稳定版 | 对应提交 |
| --- | --- | --- | --- | --- |
| OpenCode | 1.18.35 | 1.18.33 | [1.19.0](https://github.com/anomalyco/opencode/releases/tag/v1.19.0)，2026-10-11 发布 | `733b2c627e5aec39cb33cc22373bdce33053ef2c` |
| Codex CLI | 0.160.1 | 0.159.2 | [0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1)，2026-10-09 发布 | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` |

通过官方 releases/latest、Git tag 和 npm 元数据交叉核对版本。Codex tag 是 annotated tag，上表采用解引用后的源码提交。此次针对正式版，不把开发分支或 alpha 当作已支持版本。

直接下载并阅读 OpenCode 的 21 个相关文件和 Codex 的 6 个相关文件；[upstream-source-manifest.json](upstream-source-manifest.json) 记录路径、固定提交链接及每个文件的 SHA-256。另检查 OpenCode 从旧基线到 1.19.0 的提交差异。没有审计两个上游项目的所有模块。

## 本轮修正

### 1. 最新宿主被兼容范围排除

原 engines/peer 范围为 `<1.19.0`，开发依赖是 SDK 1.18.35。源码对照确认当前使用的 auth、provider OAuth、TUI API、keymap、弹窗、插件生命周期和 WebSocket 清理协议均未发生破坏性变化。

已将 `@opencode-ai/plugin` / SDK 升到 1.19.0，更新冻结锁文件，兼容范围改为 `>=1.18.33 <1.20.0`。OpenTUI 0.4.5 / Solid 1.9.12 与官方 1.19.0 的依赖基线一致。新范围的依据包含源码核对与 1.19.0 实际运行；不代表所有未来版本或所有平台都已测试。

### 2. 首页和后台会话可以绕过响应状态检查

原实现只读取当前可见 session 的缓存状态；从首页打开 `/switch` 或离开正在生成的 session 后，会跳过检查。切换/login 会更换共享凭据并 dispose 实例，可能影响仍在运行的请求。

最新 [session HTTP handler](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts) 的 status 接口返回实例的状态映射。现已在切换和登录前查询 `client.session.status`，任何 busy/retry 状态都会阻止动作；查询失败也不会继续写入凭据。可见 session 的快速检查保留。

删除保存项仅影响插件快照，仍可在响应期间执行。测试覆盖首页后台 busy/retry、OAuth 开始前阻止登录、状态查询错误，以及删除不查询运行状态。

这仍是先查询后写入的两步操作，不能锁住原生会话调度，也无法覆盖其他项目/进程的请求。文档保留多窗口并发切换的限制。

### 3. 取消后的排队操作仍可能写入

先前 UI 会取消 Operation，但 `store.switch` 和 native auth 请求没有收到取消信号；等待文件锁或本地校验的操作可能在关闭弹窗后才写入。

现已传递同一个 AbortSignal，在取得锁后、读完活动凭据后、提交写入前重新检查，并合并到 SDK auth.set 的请求信号中。状态查询结束后也重新检查，防止迟到响应触发切换。

测试覆盖存储锁排队后取消、本地环境校验期间取消、会话查询期间关闭，以及已接受写入迟到时不覆盖其他宿主弹窗。服务端已经接受的写入不能通过客户端取消撤销，README/DESIGN 已明确这一边界。

### 4. 真实宿主验证可以指定版本

`test:live` 现在允许传入 OpenCode 可执行文件路径。官方 1.19.0 Linux npm 包经 integrity 校验后解包到临时目录，用于测试；没有替换本机安装或操作真实登录。

## OpenCode 源码对照结果

以下 17 个关键文件与工作区 1.18.33 的内容一致：

- Auth schema/读写、Global XDG 路径、ProviderAuth methods/authorize/callback。
- OpenAI/Codex 原生 OAuth 与 ws-pool。
- TUI 插件类型、实际插件运行时、TUI runtime/API、command shim。
- TUI sync、DialogSelect、DialogPrompt、DialogConfirm、dialog 管理。
- provider/session HTTP handlers。

因此保留原生 OAuth callback 写入、读取最新快照、使用 native auth.set、checked instance.dispose 的实现。确认框接受回调后的同步 clear 仍存在，当前 dialog ownership 处理与之匹配。新版更新通知和 service tier 变更不需要账号插件自行处理。

1.19.0 的发布说明提供 OpenCode 2 升级入口；当前插件仍按 1.x 的 TUI 和认证契约工作，本次没有声明 2.x 兼容。

## Codex 0.162.1 对照结果

[manager.rs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/login/src/auth/manager.rs)、[storage.rs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/login/src/auth/storage.rs) 和 token_data.rs 继续确认：Codex 的认证模式、存储后端、TokenData 与 OpenCode 的 provider-keyed auth 结构不同。AuthManager 在运行中使用缓存，外部修改存储后需要显式 reload。

0.162.1 新增 storage_error.rs 和 storage_telemetry.rs：凭据 JSON 的数据错误会去掉可能携带凭据的错误链，存储遥测记录后端尝试/回退，不读取认证内容。auto 的 keyring 失败与 file 回退都会被记录。登录/登出注释也改为“操作选定存储后端”，不再误称始终修改 auth.json。

当前插件的 UI 只显示受控错误文案，不序列化 SDK error/request/response；新增状态查询错误测试使用假 secret，验证不会把 payload 展示出来。没有引入 Codex CLI 文件导入或两个刷新者共享 refresh token 的机制。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| SDK 1.19.0 typecheck | 通过 |
| Bun 回归测试 | 49 pass / 0 fail，166 assertions |
| 清洁构建 | 通过 |
| 冻结依赖安装 | 通过，未改变依赖 |
| OpenCode 1.19.0：源码 / 构建 / 解包产物 | 三种入口均通过实际 TUI：展示、native switch/refresh、删除确认、保留活动登录及其他 provider |
| OpenCode 1.18.35：源码 / 构建 / 解包产物 | 同样三种入口通过 |

实际 TUI 证据目录：1.19.0 为 `/tmp/auth-switch-live-H8zSnb`，1.18.35 为 `/tmp/auth-switch-live-M84Xhx`。脚本只使用临时 XDG 配置和假凭据；解包产物复用项目锁文件的依赖图，不是独立的 npm 安装测试。

真实浏览器/device OAuth、真实模型请求和跨账号 HTTP/WebSocket 切换、macOS/Windows 尚未实测。没有向 npm 发布 0.2.0。
