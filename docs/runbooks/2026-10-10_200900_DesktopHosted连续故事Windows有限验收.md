# DESK-103 Hosted 连续故事 Windows 有限验收（待执行）

准备日期：2026-10-10。源码基线：`2b6164d4c2b2538fa77e0191c6846133091fedb6`，tree `f812ea96ed82f40dcaf049af53ccf08465c7177d`。本清单只整理待验动作，尚未操作 Windows；同源码的完整原 CI 已于 19:59:55–20:09:00 UTC 通过，详见[本片验收](../reports/2026-10-10_191300_DesktopHosted连续故事两页接线验收.md)。本文件是通过后的事实文档，不改变受测产品或测试源码。

范围为两页线性首章/续章、原请求恢复、角色决定、本机保存和出口；不含真实账号/模型/生产请求、部署、安装器或 D4 包执行。本文是执行清单，不授予设备、额外付费、凭据读取或临时工程修改权限。

## 证据边界

- **精确当前基线的 pipe 已验**：`final-save-fence-pipe/REPORT.md` 的 `run-20261010T1957Z`，13 场景通过；实际父 owner → 默认 TS binder/Channel 对象 → 原 Native 模块/SQLite/文件 → 两个合成 HTTP loopback。包括两 product × 两 actor × 两 funding 首续共 16 章、角色未决、accepted 重进程、save/receipt ACK unknown、创建能力撤回、cleanup-pending；总计 20 章。独立复核 13 个库、11 个导出、194 个产品输入和 288 个锁依赖。没有真实 Tauri command runtime/WebView/ACL/OS keyring。
- **当前 TS/DOM 已验**：`ts/owner-ui-storage-reviewed.log` 为本基线 owner/UI 等 8 文件 200/200；`ui-review-probes/final-2b6164d/RE_REVIEW.md` 在精确本基线复验原 4 个 P2 反例及 Close/Back，共 6/6，另有普通出口/foreign-retained 正向组 10/10。4 个旧 P2 已闭合。真实 Router/Form/owner + synthetic Native-shaped peer 仍非真机；Close 是模拟 callback，Back 是 jsdom history。旧 `8e9f45d7` 红例保留作历史，不是当前缺陷；正式完整 CI 结果单列在本片验收，不能用这些定向数量替代。
- **仍未验**：本基线 Windows/Tauri 真 Channel/原生 close、WebView history/真实视觉、隔离 OS SecretStore、真实文件系统出口与真实备份恢复。Linux headless 或 pipe 通过不能填入下面 Windows 结果。

## 执行前必须具备

1. **独立测试身份三层隔离**：沿既有 [D4b runbook](./2026-10-10_030600_D4b隔离窗口Windows有限验收.md) §2，在独立 Windows 测试树使用新 identifier，例如 `me.colanns.mahoshojo.desktop.hostedstoryacceptance`；`.tmp` Tauri config 只覆盖 identifier，保留 `main-ui`、窗口、capability/CSP/withGlobalTauri。测试树 `secret.rs::SECRET_STORE_SERVICE` 临时使用同一隔离 namespace；`WEBVIEW2_USER_DATA_FOLDER` 指向独立空目录。不读/列举日常凭据、不复制日常 AppData；只在此 namespace 放固定无真实权限的 synthetic actor/token/Key。
2. **两个自有 mock origin，尚需 Windows 窄 harness**：Hono 与 Next 分别使用 `http://127.0.0.1:<不同非零端口>`，只收本机合成请求。现 `ArenaState::with_story_loopback_origins` 是 `#[cfg(test)]`；普通 Tauri setup 仍调用 `ArenaState::new`，固定 Hono/Next 目的地。`MAHOSHOJO_CLOUD_ORIGIN` 仅覆盖一般 Cloud/公告 debug 编译期 origin，**不覆盖这两个 Arena origin**。所以当前源码不能仅设置环境变量后直接 `tauri dev` 做本清单。
3. **harness 准入标准（待准备，不在本稿实现）**：在隔离测试构建中明确接入两 origin、共用真实 `Arc<StoryStore>`、真实 Tauri commands/Channel 和实际页面 owner；沿现 factory 的严格 loopback 校验，缺配置直接拒启，禁止回落生产。一般 Cloud/公告请求也在编译前指向其中一个 mock 并补齐其启动响应。保留生产 constructor、endpoint allowlist、TLS、重定向/no-proxy、CSP/ACL、协议和容量；不增加 renderer 任意 URL/凭据/通用文件入口。仅用窄一次性故障点延迟/丢失真实 invoke 回执或模拟隔离 SecretStore 故障，不伪造保存成功。旧 pipe 的 `loopback.cjs` 仅是响应素材，含 Linux 路径且非 Windows 一键服务；须另适配并记录 patch/hash/PID。所需故障点未准备的项目记“阻塞”，不得用 mock JS invoke 冒充真机通过。
4. **启动和记录**：先记录 commit/tree/dirty patch、Windows/WebView2/Tauri/工具链版本、运行方式、当前 DPI/缩放、两 origin/PID、实际数据目录与合成夹具 hash。确认上述 harness 后才按 D4b 既有绝对路径 `--config` 流程启动真实 Tauri；Vite 1420 冲突就报告，不杀他人进程。使用已有工具链，缺少组件不顺带安装。不改 hosts、DNS、证书信任、代理、防火墙或系统安全设置。

## 十项有限检查

每项填写“通过 / 失败 / 阻塞 / 未测”，按 product/子场景分行；一支通过不能代表整项。证据只留合成 request/generation/session/operation 身份、计数、状态、长度/hash和必要截图，不留 cookie/token/Key/header 原文。

### W01 两页首章与续章
- 动作：`#/battle`、`#/arena` 各覆盖 synthetic anonymous/account × system/preset，使用两张合成角色卡，明确首章、续章各一次；包含有计划与明确无计划样本。续章前改变普通草稿，生成中手选旧章
- 预期：每章一个 model POST、需要角色时一个 role POST、一次 prepare/save；顺序为 input seal/pointer → claim/create → 完成 seal → role → freeze/save。续章沿原 seed/plan/revision/head，普通草稿与源卡不被改写，旧章选择不被晚结果抢走
- 证据：两端 mock 计数、真实 IPC 顺序、保存后只读章节/计划/原卡摘要，首续及选章截图

### W02 完成正文与 invoke 门禁
- 动作：mock 返回完整正文/推理及合法 done；分别延迟真实 Native invoke settle、令其晚 reject，并覆盖缺 stream-end/晚畸形事件。另令完成原件首次 seal 失败，再点“重试原件本地封存”
- 预期：invoke 成功且原 owner/actor 仍有效前，全文只标为窗口原文，无完成 seal/role/save；失败仍能分别导出正文/推理。exact 本地 seal 重试成功后角色决定按钮可达，但不自动重模型/角色
- 证据：done/end/invoke 时间线、零后续副作用计数、窗口原文逐字节对照及封存重试前后截图；不可观测的故障支记阻塞

### W03 role unknown 保文与明确旧角色
- 动作：完成原件后使 Next 断连/畸形响应，双击“重试角色同步”；另一路点“保留旧角色保存本章”。补受检 HTTP non-success 对照，并让 keep-old 的 seal 一次失败
- 预期：unknown 保全文且不自动降级；重试单飞、只原 generation、无第二次 model POST。keep-old 的决定/reason 与 frozen commit 同 seal，失败仍 unresolved；成功才一次保存。明确 HTTP 失败保旧角色并给 warning；accepted 后不再 role POST
- 证据：原 generation、role/model/prepare/save 计数、原件与 commit 的合成字段/摘要、告警和动作截图

### W04 save ACK unknown 与保存授权围栏
- 动作：真实 `save_arena_story_pending` 成功后仅丢该次返回；临时隐藏 exact receipt，分别返回 absence/mismatch/读取失败，重复查询并冷重开后再恢复正确回执。另一路在真实 prepare 返回前换 synthetic actor 或离页
- 预期：unknown 只查原 sessionId/operationId receipt，始终 prepare=1、save=1；空回执/重开不授权重存、另存或重生成。prepare 晚返回遇 owner/actor 失效不得继续 save；未知 attempt 保留，只能后续 exact receipt
- 证据：实际成功事务/receipt 的只读核对、命令计数与身份、冷启动截图。没有真实 save 成功就不能记“落盘后 ACK 丢失”

### W05 Stop、Close 与 Back
- 动作：慢流和 done 后 invoke 未 settle 两个时段，分别点页面上方与故事区可见“请求服务器停止”；另用独立样本关闭主窗、Back/跨页导航，先拒绝守卫再接受；放行晚响应
- 预期：两个停止入口均控制原故事，至多一个原 request stop；受理不等于已停止/退费。Close/Back 拒绝保页，接受仅 detach，不偷偷发 server stop、不因晚结果 seal/role/save；已 durable 候选保留，未封存窗口正文风险明确
- 证据：实际 Tauri close 回调、WebView history/窗口状态、stop/detach/写入计数与时间线、关闭前提示截图；不得拿 jsdom 结果代填

### W06 原请求恢复与创建 gate
- 动作：模拟 POST 已收到但首头丢失，lookup 一次 404，再撤回 story-create capability；回原页双击“恢复原请求”。独立合成样本保 Native claim 但缺 pointer；另一样本为 cold input-only 无 claim
- 预期：仅原 request lookup/replay、一个恢复 flight，无第二次 POST/换 host/Direct fallback；新 create 被 gate，旧恢复/导出仍可用（原 C1 基本 capability GET 可存在）。有 claim 缺 pointer 仅显式恢复；冷无 claim 只读/导出/明确放弃，不能猜 funding 补 create
- 证据：request/generation 不变、两服务请求计数、两 product pointer 与 Native claim 的脱敏只读快照。夹具须走现业务/受审窄测试接缝，不能手改数据库抹约束

### W07 冷重开与 backup-restored 分开
- 动作：accepted 尚未保存候选正常关闭/同 namespace 重开，读取后显式继续本地处理；两 product 各留一个候选核跨页导航。另经真实整库备份 UI 备份这些合成候选，再经 UI 新增合成卡，然后确认整体恢复并重启
- 预期：普通 cold accepted 不再 role POST，可在原授权/身份下处理原冻结提交；跨页卡只导航原页，不改绑。backup-restored 明示只读，只有本地读、原 actor replay、exact receipt、导出/明确放弃，零 create/seal/role/prepare/save；保存章节按备份内容恢复，恢复前安全备份保留，OS secret 不随备份恢复
- 证据：普通重启与整库恢复分别记录；真实备份 manifest/hash、恢复 journal 状态、restored 标记、IPC/HTTP 计数、两槽及目录截图。不能用复制 SQLite/Portable ZIP 代替整库恢复

### W08 完整出口、取消与 noclobber
- 动作：分别导出未 seal 的窗口正文/推理、全部 sealed parts+manifest、已存故事完整 Markdown；同候选重复导出，中途取消/受控失败。窄 harness 另制造实际 Native 最终文件名碰撞，预置合成哨兵文件
- 预期：窗口与 durable 出口标签准确；每文件仅最终 receipt 才算成功，部分失败只列已成功文件，取消无 partial 成功/无自动放弃。真实碰撞拒绝覆盖，哨兵字节不变；导出保全部原字节，不截断、不带秘密/上传 token
- 证据：每文件 source/receipt/长度/SHA256 与原 BLOB 的对照、目录前后及哨兵 hash、取消计数；重复不同文件名成功本身不足以证明 noclobber 碰撞拒绝

### W09 明确放弃、foreign-retained 与 cleanup-pending
- 动作：先进入放弃确认并“返回保留”；再明确放弃。合成异 binding/旧身份触发 foreign-retained；另让隔离 SecretStore 删除/读回故障，重启后解除故障并“继续清理原本机候选”
- 预期：默认先导出/返回；最终可明确不导出放弃，绝不删除已存章/receipt。foreign-retained 保留另一恢复身份及诊断/明确 replace 出口，不自动换 secret 或声称全槽释放；cleanup-pending 保原 intent/原件/恢复入口，禁新写，只继续 exact cleanup。正常释放后同页普通 Hosted owner 不滞留旧只读缓存，另一 product 不变
- 证据：候选/claim/abandonRequested/receipt 的前后摘要、按 namespace 记录的脱敏 secret 操作计数、诊断/替换确认截图；无需列举或导出凭据明文

### W10 身份、重复操作与真实可用性收尾
- 动作：分别在完成封存、role、freeze/保存前切换 synthetic actor/离页，放行晚响应；连续点击恢复/角色/本地重试，读取旧章后马上选择新章。两页在 960×640 与 1180×800、当前 DPI、明暗主题检查告警/导出/停止/返回按钮与键盘焦点
- 预期：旧 callback 不写新账号/新 owner/新选章，原件仍可本地导出；无并发重复模型/role/save，busy 不被旧 finally 提前解除。长标题/正文及 unknown/restored/cleanup 文案不遮住退出和保文动作；不把未验证的恢复角色显示成新鲜签名
- 证据：actor/epoch/selection 与请求计数时间线、截图/短录屏、实际未覆盖分支；不外推真实模型质量或整机容量结论

## 回传与停止

提供 `baseline.txt`、`temporary.patch`/harness hash、`cases.csv`（编号/子场景/状态/实际/证据）、脱敏计数/事件日志、合成导出 hash 与截图。发现真实账号/Key、生产或非自有目的地、未授权权限/安全提示，立即停该分支，不绕过；安全隔离不成立则停止整个实例。只关闭自有测试窗口/服务，保留临时证据，恢复测试源码补丁并回传 diff/status，不清日常凭据或用户文件。

仅将有真实证据的子场景标通过；本清单结束不自动关闭 D4、真实生产服务或整个 Desktop 的剩余门禁。

## 依据（相对源码根）

- `docs/decisions/2026-10-10_191200_DesktopHosted连续故事两页接线决策.md`、`docs/specs/2026-09-30_160000_Desktop客户端实施规格.md` DESK-103
- `docs/decisions/2026-10-10_184000_Hosted连续故事候选本地出口决策.md`
- `docs/runbooks/2026-10-10_030600_D4b隔离窗口Windows有限验收.md` §2、`docs/runbooks/2026-10-10_153500_Desktop连续故事Windows有限验收.md`、`docs/runbooks/2026-10-03_155000_Desktop整库备份与恢复验收.md`
- `apps/desktop/src-tauri/src/arena_hosted.rs:540–591`、`lib.rs:1815–1828`、`cloud.rs:36–53`、`secret.rs:20`
- `apps/desktop/src/features/arena/hosted-story-session.ts`、`hosted-recovery.ts`、`story-controls.tsx`、`apps/desktop/src/app/battle-page.tsx`
