# switch-auth-plugin 新版兼容性与优化审查

> 最新正式版本复查已改用 OpenCode 1.19.0 / Codex 0.162.1，见 [最新源码复查](latest_source_review_2026-10-12.md)。下面保留第一轮旧版审查及当时的验证记录。

> 这份报告记录重构前 0.1.6 的问题。后续 0.2.0 已实现保存库 v2、token 同步、跨进程事务、权限与结构校验、新版 keymap、原生 auth 写入及可取消登录。现行行为见 [DESIGN.md](DESIGN.md)、[CHANGELOG.md](CHANGELOG.md) 和 [README.md](README.md)。文中“尚未验证新版真实 TUI”是初次审查时的状态；后续已在隔离环境用 OpenCode 1.18.35 验证源码和构建入口的展示、原生切换及其他 provider 保留。真实 OAuth 和 macOS/Windows 仍未实测。

0.2.0 验证结果：43 项回归测试通过，包含 5 个独立进程并发保存、真实 OpenTUI 渲染/键盘输入、确认框自动关闭以及迟到操作不影响其他对话框。安装的 OpenCode 1.18.35 对源码、构建入口和放入 node_modules 的解包产物均通过真实 TUI 检查：账号展示、原生切换与刷新、原生删除确认、活动登录及其他 provider 保留。测试全部使用隔离配置和假 token；解包产物复用冻结锁文件的依赖图，没有向 npm 发布。冻结安装检查未改变依赖。

审查日期：2026-10-12。当前插件：`0.1.6`，Git 提交 `2fdeee0`。

## 审查范围与结论

重新阅读了插件全部 `src/`、测试、构建脚本、README、三份设计文档，以及相关 OpenCode/Codex 认证与 TUI 源码。对照基线是工作区中的 **OpenCode 1.18.33** 和 **Codex 0.159.2**；这是本次可检查的源码版本，不代表已经验证线上最新发行版。OpenCode 旧报告明确基于 `1.2.24`，插件本地安装的 `@opencode-ai/plugin`/SDK 仍为 `1.3.9`。

主要判断：插件的 TUI 单命令设计和复用原生 OAuth 的方向可以保留，但账号身份、刷新后的凭据同步、存储并发、文件权限与宿主路径需要修正。当前测试通过，不能据此认定兼容新版宿主。

插件没有调用 Codex CLI，也没有读取 Codex 的凭据，所以 Codex 版本升级不会直接改变本插件的 TUI API。需要区分 OpenCode 的内置 Codex OAuth provider 与独立的 Codex CLI。

## 优先级

P1 表示影响可靠切换、账号数据或凭据保护，应在下一次发布前处理。P2 表示健壮性、API 迁移或使用体验问题。

| 优先级 | 问题 | 证据类型 |
| --- | --- | --- |
| P1 | refresh token 作为账号主键，原生刷新后保存项过时 | 已复现 + 新版刷新链路 |
| P1 | JSON 读改写无锁，并发保存丢账号 | 已复现 |
| P1 | 凭据写入没有明确限制权限 | `umask 022` 下已复现 |
| P1 | 自行推算认证路径，与宿主 XDG 路径不一致 | 源码确认 |
| P1 | 本地文件切换不能代表远程/环境注入的实际认证；dispose 错误可能被忽略 | 源码确认 |
| P1 | OpenTUI 构建/运行依赖落后，兼容声明过宽 | 版本差异确认；宿主运行待验证 |
| P2 | claims、JWT 和 auth/store schema 校验不完整 | 已复现 |
| P2 | 登录保存顺序、取消及重复操作缺少统一生命周期 | 源码确认 |
| P2 | 旧 command API 已弃用 | 新版仍有 shim，尚非必然运行失败 |
| P2 | UI 操作名与设计文档、实际行为不一致 | 源码与文档确认 |

## 1. 账号主键与凭据刷新：最优先修复

位置：[src/parse.ts](src/parse.ts) 第 45、49 行；[src/store.ts](src/store.ts) 第 169、175、182、219、227 行。

当前 `key()` 始终返回 refresh token 的 SHA-256 截断值；`match()` 和 upsert 也只按 refresh token 匹配。它标识的是一份凭据，不能稳定标识账号。`readStore()` 的 normalization 还会把已有键重新改成 refresh hash，因此仅修改 `key()` 不足以完成迁移。

新版宿主 [openai/codex.ts](../opencode-1.18.33/packages/opencode/src/plugin/openai/codex.ts) 第 363–396 行，在 token 过期时刷新并通过原生 `auth.set` 保存新 refresh/access/expires。插件只在自己的 login 流程保存账号，`listAccounts()` 和 `switchAccount()` 都没有同步当前账号的新凭据。

已用假 token 复现：

- 相同用户、相同 workspace，换一个 refresh token 后 upsert，列表出现 2 条记录。
- 保存 A 的旧凭据后模拟宿主原生刷新，列表不再有任何一项标记为 Current。
- 再选择保存的 A，活动认证被写回旧 refresh token。旧 token 是否被服务端拒绝取决于其轮换策略，本次没有访问服务端；本地回写旧值已经确认。

建议：引入 store v2，将稳定的本地记录 ID 与用户/workspace 身份分开。身份匹配优先使用可用的用户标识与 workspace 的组合；email 可作展示及辅助信息。**不能只用 accountId 去重**，它可能表示多人共享的 workspace；也不能只用 email，否则同一用户的个人及企业 workspace 会合并。

打开列表、切换离开当前账号之前，更新能可靠匹配到的已有记录的最新凭据；处理原生 `/connect` 的登录变化。删除过的记录不要在后台同步时无条件重新创建。保留旧键迁移映射和时间信息；无法确认身份的旧记录先保留，不做猜测性合并。

这不要求在打开列表时向远端刷新全部账号，仍可保留现有“不主动探测、不因过期删除”的约束。同步本机已更新的凭据即可修复主要问题。

## 2. 并发读改写会丢数据；读取时也有写操作

位置：[src/store.ts](src/store.ts) 第 48、117、182、227、245 行。

upsert/delete/switch 都分别读取整个 JSON，再覆盖写回，没有串行队列或文件锁。`readStore()` 发现需 normalization 的记录时也会写文件，单纯打开选择框就可能与其他写入竞争。

临时目录中，已有 1 个账号，再并行 upsert 12 个不同账号：预期 13，实际只剩 2。具体残留数量受调度影响，丢失更新已经确认。

建议使用一个保存库事务入口，覆盖“读取、迁移、修改、落盘”全流程，并为多个 OpenCode 进程提供文件锁。单进程 mutex 只解决一个进程内的竞争。采用同目录临时文件及 rename，避免直接截断正式文件；仅使用原子 rename 不能解决丢失更新。若需要崩溃持久性，再结合文件/目录同步。

活动 auth 与账号库也是两个不同文件。现在先写 auth，再写 lastUsedAt；第二步失败会提示“切换失败”，但认证已经改变。应分开表达切换结果与历史记录保存结果，避免用户误判。

切换活动认证优先使用宿主认证 API，减少重复实现原生存储逻辑；宿主 API 本身是否保证跨进程事务需另行确认，不能把这一调整当作全局并发锁。

## 3. 凭据文件权限依赖 umask

位置：[src/store.ts](src/store.ts) 第 48、109 行。

`fs.mkdir` 和 `Bun.write` 没有显式 mode，保存库包含完整 access/refresh token。当前运行环境的默认 umask 恰好使新文件/目录为 `600/700`；在同一临时测试中切换为 `022` 后，结果为 **accounts.json 644、auth-switch 755**。

新版原生 [auth/index.ts](../opencode-1.18.33/packages/opencode/src/auth/index.ts) 第 81 行明确使用 `0o600` 写认证。

建议 Unix 下目录 `0700`、新文件/临时文件 `0600`，并修复已有保存库的宽松权限。Windows 需要按平台处理 ACL，不能声称 chmod 数字等价于 Windows 的访问控制。可恢复备份与临时文件也应遵守同样的权限。

## 4. 路径规则与宿主不一致

位置：[src/paths.ts](src/paths.ts) 第 4 行；[README.md](README.md) 的 Storage。

新版 [core/global.ts](../opencode-1.18.33/packages/core/src/global.ts) 的 data 使用 `xdg-basedir` 的 `xdgData`，再拼 `opencode`，没有插件当前的 macOS `Library/Application Support` 和 Windows `LOCALAPPDATA` 分支。未设置 XDG 覆盖时，插件的这些分支不能代表宿主的实际目录。Linux 的正常 XDG 情况相对一致。

`OPENCODE_TEST_HOME` 也只覆盖宿主的 home getter，不直接重定向 data；宿主 [test/preload.ts](../opencode-1.18.33/packages/opencode/test/preload.ts) 单独设置 XDG 各目录。插件优先把 TEST_HOME 当成 data 根，因此在宿主测试环境中会读错文件。

建议按宿主实际规则确定路径，测试显式注入路径，避免继续维护与宿主不同的 OS 分支。若 SDK 没有暴露认证目录，不要用其 `state` 或 `config` 路径猜成 data。新版 `api.state.path` 并未提供 data。

调整默认目录时，需检查原保存库位置并给出有备份、可恢复的迁移行为，避免升级后账号列表突然变空。README 应说明真实 XDG 规则及其覆盖方式。

## 5. 本机 auth.json 与实际生效认证、刷新结果必须区分

位置：[src/store.ts](src/store.ts) 第 100、109 行；[src/tui.tsx](src/tui.tsx) 第 157 行；[src/login.tsx](src/login.tsx) 第 178 行。

原生 OAuth 请求通过 `api.client` 访问服务器，插件却通过本地文件读取及切换凭据。如果 TUI attach 到另一台机器，登录回调在服务器写 auth，而插件读取本机 auth；切换则改本机文件、dispose 远程实例，容易显示成功却没有切换服务器账号。

即使是本地宿主，[auth/index.ts](../opencode-1.18.33/packages/opencode/src/auth/index.ts) 第 59 行也优先读取 `OPENCODE_AUTH_CONTENT`。环境注入认证时，修改磁盘 auth 不会改变实际认证。插件仍按文件显示 Current 和切换成功。

新版 SDK 默认以 `{ data, error }` 返回请求结果。[src/tui.tsx](src/tui.tsx) 的 `instance.dispose()` 返回值没有检查，只捕获 Promise reject；服务端返回 error 对象时仍可能出现成功 toast。login 中也有相同问题。

此外，`api.client.sync.bootstrap()` 是类型断言出来的假设，并不是新版 SDK 的能力：SDK 的 `sync` 是服务端同步接口，TUI 的 `sync.bootstrap()` 在独立 context 中。新版 [tui/context/sync.tsx](../opencode-1.18.33/packages/tui/src/context/sync.tsx) 第 178 行会监听 `server.instance.disposed` 再 bootstrap，因此应按真实事件与状态契约刷新，并检查 dispose 结果，不继续依赖不存在的 client 方法。

建议切换时使用新版 `api.client.auth.set({ providerID: "openai", auth })` 并显式处理错误。当前公开 SDK 没有对应的活动认证读取接口；要完整支持远程保存/切换，需要增加服务端保存库能力或可用的服务端读取契约。若下一版继续维持本地 TUI 插件，应明确、可检测地限制支持环境；有环境认证覆盖时不要声称磁盘切换已经生效。

原生 dispose 还负责关闭 OpenAI WebSocket pool：[openai/codex.ts](../opencode-1.18.33/packages/opencode/src/plugin/openai/codex.ts) 第 280 行。换号时应保留有效的释放/重建步骤，并加入同一 session 的 WebSocket 验证；仅仅写文件或刷新列表不能证明连接已使用新账号。本次没有运行宿主网络集成测试。

## 6. 新版 OpenTUI 与 SDK 的兼容边界需要重建

位置：[package.json](package.json) 第 29、46、49 行；[scripts/build.ts](scripts/build.ts)。

| 项目 | 插件当前基线 | OpenCode 1.18.33 源码基线 |
| --- | --- | --- |
| @opencode-ai/plugin / SDK | 本地安装 1.3.9 | 1.18.33 |
| @opentui/core、solid | 0.1.93；声明 ^0.1.93 | 0.4.5 |
| TUI 命令注册 | api.command.register | keymap.registerLayer；保留旧 shim |

`^0.1.93` 不接受 `0.4.5`，而 `engines.opencode: ^1.0.0` 与 plugin peer `^1.0.0` 都声明了很宽的 1.x 支持范围。安装/类型检查通过并不代表宿主渲染与运行接口匹配。

新版宿主有运行模块支持机制，不能仅凭版本号就断言旧插件一定启动失败；旧编译产物是否兼容，需要在真实宿主加载验证。建议将构建工具、TUI/SDK 开发类型对齐目标宿主，运行 source 与打包产物的加载测试，然后根据已验证范围收紧兼容声明。是否将运行库改为 peer，应结合宿主的模块共享机制及实际 npm 安装验证。

`api.command` 在新版类型中为 optional/deprecated，运行时仍提供 shim。这是应迁移的 API，不是本次已经确认的“新版 /switch 必坏”。迁移到 `api.keymap.registerLayer` 时保留命令 ID 和 slashName；若继续支持旧版，使用明确的能力检测及兼容路径，并结合 `lifecycle` 清理资源。

## 7. JWT、claims 和文件结构校验

位置：[src/parse.ts](src/parse.ts) 第 12、22、29、33 行；[src/store.ts](src/store.ts) 第 7、19、109、117 行。

已复现：

- 嵌套 `https://api.openai.com/auth.chatgpt_plan_type` 的真实含义是 auth 对象中的字段；插件只读取点号拼接的扁平键，因此嵌套 plan 返回 undefined。
- 同样的嵌套 accountId 在没有显式 `auth.accountId` 时解析失败。原生 OpenCode 已支持这个嵌套对象；正常原生登录常会写显式 accountId，所以不是所有登录都会受影响。
- 嵌套 profile.email 已能解析；顶层 email 尚未支持。
- JWT payload 为合法 JSON `null` 时，`parseJwtClaims()` 返回 null，随后 extractEmail 抛异常。
- `validAuth()` 接受 `expires: -1` 和 `0.5`，新版宿主 schema 是 `NonNegativeInt`，这些条目会出现插件认为有效、宿主拒绝的情况。
- `{ version: 1, openai: [] }` 被接受为正常保存库，因为 obj 没有排除数组。
- 活动 auth 文件为 `[]` 时，`writeCurrentOpenAI()` 返回成功但最终文件仍为 `[]`，认证并没有写入。

建议显式校验 JSON record，JWT 至少要求三段及对象 payload；支持嵌套 namespace，并保留旧扁平字段的兼容读取。expires 与宿主保持一致的非负整数规则。无法解析身份的 token 可以保留原凭据，不应让展示信息解析异常破坏整个列表。JWT 解码仅用来提取元数据，不能视为签名验证。

区分文件不存在、空文件、JSON 语法错误、结构错误与 I/O 错误；现在部分读取失败被归为 malformed，空文件则被当作 missing。自动 pruning/migration 前保留可恢复内容，避免读取一个结构错误就静默抹去记录。

## 8. 登录状态与取消

位置：[src/login.tsx](src/login.tsx) 第 178、213、241 行；[src/tui.tsx](src/tui.tsx) 第 92、136 行。

`save()` 在读活动凭据、写保存库之前就 dispose；一旦刷新失败，登录已完成的账号也可能没有保存。设计文档要求的顺序恰好相反：回调成功、读取并保存、刷新宿主。

建议回调成功后立即保存原生已写入的凭据，再刷新实例；分别呈现登录、保存、刷新三个结果。已有账号可以正常更新，不要把“refresh token 与登录前相同”直接判作登录失败，这会阻止某些重新保存当前账号的操作。登录成功本来就会改变活动认证，UI 与文档应明确这一实际行为。

auto 流程没有 onClose 的本地取消状态，也没有关联本次登录的 operation ID。用户关闭对话框后，等待请求仍可继续；若随后成功，会保存账号并重新打开 /switch。新版宿主原生等待屏也存在相似异步处理，但插件自己的“回到 /switch”行为仍需有明确生命周期。code 流程还可能重复提交 callback。

建议使用 per-operation 标识、busy 状态和 lifecycle signal，取消/卸载后阻止过时任务 toast 或替换新对话框。可取消 HTTP 等待不等于撤销服务器的 OAuth 操作；若服务端已完成写入，需保留并正确同步这个事实。

`seq` 目前只处理多个 open 请求的结果次序，没有覆盖关闭对话框、切换、登录、卸载。`open()` 中读 auth 抛错也没有最终 catch，调用者使用 `void open()`，可能出现未处理 rejection 并停留在 Loading。

## 9. 使用体验和旧文档

- `logout` 实际只是删除保存项，建议界面直接叫 Remove saved account。保持删除保存项与退出活动认证的语义独立。
- `CodePrompt` 仍注册无修饰键 `c` 为复制，并 preventDefault/stopPropagation，会与授权码文本输入竞争；改为有修饰键快捷键或显式操作，并在 TUI 测试中验证。
- 展示 plan、workspace 和明确的当前账号；expires 只作为提示，不能因为 access token 过期就删除账号，refresh 仍可能有效。
- login 不可用时区分“宿主没有 OAuth 方法”和“服务端请求失败”；当前 `authMethods()`/`hasLogin()` 吞掉错误，用户无法判断原因。
- storage_design 仍写 email-first，todo/file_plan 也保留同类规则，但实现已经是 refresh-hash-only；三份文档应合并为一份现行设计，并标记旧方案状态。
- [opencode_analysis.md](../opencode_analysis.md) 基于 1.2.24；[opencode_auth_analysis.md](../opencode_auth_analysis.md) 与 [oauth_openai_gemini_login_guide.md](../oauth_openai_gemini_login_guide.md) 仍引用旧 `plugin/codex.ts` 等路径。新版相关路径已变成 `plugin/openai/codex.ts`、`packages/core`、`packages/tui`，认证也已采用 Effect/Schema。优先更新认证与插件开发文档中的路径、类型和版本范围。
- 仓库根部的 [opencode-auth-switch](opencode-auth-switch) 是旧的整文件复制方案，帮助文字仍称“指向选定文件”，实际使用 cp；它也会替换其他 provider 的认证，且与当前 JSON 保存库无关。应明确标为旧工具或移入 legacy，避免误用。

## 10. Codex 参考报告需要更新的内容

旧 [codex_login_analysis.md](../../CodexReport/codex_login_analysis.md) 把认证主体放在 `codex-rs/core/src/auth.rs` / `core/src/auth/storage.rs`。在 0.159.2 中，主要实现位于：

- [login/src/auth/manager.rs](../../CodexReport/codex-rust-v0.159.2/codex-rs/login/src/auth/manager.rs)：认证模式、缓存、刷新与限制。
- [login/src/auth/storage.rs](../../CodexReport/codex-rust-v0.159.2/codex-rs/login/src/auth/storage.rs)：凭据结构、file/keyring/auto/ephemeral，以及 keyring 后端与兼容读取。
- [login/src/token_data.rs](../../CodexReport/codex-rust-v0.159.2/codex-rs/login/src/token_data.rs)：ID token claims、用户/workspace 信息。

具体变化：CodexAuth 已不止旧报告里的三种模式，还包含 Headers、AgentIdentity、PersonalAccessToken、BedrockApiKey、BedrockAccessKeys；AuthDotJson 也增加了相关字段。keyring 有直接后端与 Secrets 后端路径，不能把旧的单一 keyring 实现当作完整当前实现。

AuthManager 第 2034 行明确说明外部修改 auth.json 不会自动反映到内存缓存，需要 reload。因此未来做 Codex 切换器时，不能复制本插件“写文件即切换”的假设。官方文档也确认 file/keyring/auto/ephemeral 存储选择和 CODEX_HOME；仅修改默认文件并不覆盖所有认证来源。[OpenAI 官方认证文档](https://developers.openai.com/codex/auth)

跨 OpenCode/Codex 可以复用身份元数据解析思路，不能直接共享整个 auth 文件结构：OpenCode 是 provider-keyed OAuth 结构；Codex 是 AuthDotJson/TokenData，包括原始 id_token、last_refresh 及其它认证模式。也不应将同一 refresh token 的两份副本交给两个独立刷新者长期维护；原生 Codex 明确识别 refresh_token_reused 错误。需要设计凭据归属及轮换同步后再考虑导入/共享。

此次没有将插件扩展为 Codex 账号管理器；这些是参考文档修正与未来扩展的边界。

## 验证结果与发布前应补的检查

本次验证均用临时目录和假 token，没有读取真实 auth 或调用真实 OAuth：

| 检查 | 结果 |
| --- | --- |
| 原有 bun test，Bun 1.3.11 | 8 pass，0 fail |
| 本地 tsc --noEmit | 通过，使用已安装的旧 SDK/TUI 类型 |
| 使用现有构建配置输出到 /tmp | index.js / tui.js 构建成功 |
| 同一身份、更换 refresh token | 生成重复账号 |
| 原生刷新后打开列表/重选保存项 | Current 丢失、旧 refresh 被回写 |
| 1 个已有账号 + 12 个并发 upsert | 最终 2 条，预期 13 条 |
| 新建保存库、umask 022 | 文件 644、目录 755 |
| 嵌套 claims、null JWT、数组 root、非法 expires | 确认上述解析及校验问题 |

临时复现脚本：`/tmp/switch-auth-review-20261012.ts`。构建检查脚本：`/tmp/switch-auth-review-build-20261012.ts`。这些临时文件不是发布产物。

没有安装新版宿主依赖，没有运行 1.18.33 的真实 TUI/OAuth/WebSocket 集成；OpenTUI 运行兼容、macOS/Windows 实机表现、远端 OAuth、token 服务端失效类型仍需要对应环境验证。本报告把这些与已复现的本地缺陷分开列出。

建议按以下顺序落地，每一步建立对应的行为验证：

1. 保存库事务/锁、原子写和权限；收紧结构校验，保留损坏文件。
2. 稳定记录 ID 与用户/workspace 身份、v1 迁移、原生刷新后的同步；重点验证 A→B→A 及同一企业中不同用户不被合并。
3. 对齐宿主路径、auth API、dispose 错误处理、环境注入与远程支持边界。
4. 更新 SDK/OpenTUI 构建基线、keymap 注册与登录生命周期，加载 source 与 npm 打包产物验证。
5. 更新 README/现行设计及旧认证报告，验证真实登录、取消重试、删除当前保存项、同一 session 的 HTTP/WebSocket 换号。

无需先换 SQLite，也无需接管 OpenAI token endpoint。修好现有 JSON 保存库和原生 OAuth 接口之间的同步契约，已经能覆盖主要可靠性问题。
