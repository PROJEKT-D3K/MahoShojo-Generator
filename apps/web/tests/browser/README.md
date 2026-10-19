# 竞技场本地组件浏览器验收

从仓库根运行，复用已经安装的 workspace 依赖与 Playwright。Windows 默认使用已安装的 Edge；其它环境使用已经安装的 Playwright Chromium。脚本不安装浏览器，也不读取 Next 配置、`.env`、真实账号或 Provider Key。

```sh
# 只编译真实组件、样式和内置 Web 包，不启动浏览器或 HTTP 服务
node scripts/verify-web-arena-report.mjs --prepare-only

# 有可用浏览器的本机运行；不要对已被拒绝的浏览器启动改参数绕过
node scripts/verify-web-arena-report.mjs

# 如需选择另一份已经安装的 Chromium
node scripts/verify-web-arena-report.mjs --browser-executable "C:\实际路径\chrome.exe"
```

每次产物写入新的 `.local/web-arena-acceptance/run-*`。先看 `report.json`：`prepared-browser-not-run` 仅表示编译准备完成；`failed` 是失败；`passed-pixel-review-required` 表示浏览器断言完成，仍需人工打开图片验收。失败保留非零退出、原始错误及已采集资料，不等同于跳过。

## 真实链路与隔离边界

- 真实 engine/store、结果卡、修复 hook/domain、生成快照、样式、snapdom PNG 和下载
- 流式/非流式 × Markdown/Web，缺模型用量、失败残文、修改下一场设置、修复草稿不自动应用与明确取消/确认
- Web 使用内置包和合成输出，通过真实许可 UI 打开受限 iframe 后切回普通显示；不预存许可或提升信任
- 包的安全源码视图没有 PNG 操作，按产品合同下载生成目标；PNG 只在实际支持的 Markdown 卡点击保存。不要为了验收给产品补造导出能力
- 红/蓝错误在亮暗样式下留图，并记录帮助文字继承、父级透明度、焦点与悬停；这不是全站 AA 或物理键盘/读屏验收
- 仅替换外部边界。合成署名只是 `useAuth` 展示替身，传输始终匿名无凭据；不证明认证或真实用户名来源

Node 只监听随机 `127.0.0.1` 端口，不代理请求。浏览器使用全新 context，禁止 Service Worker；只允许精确 origin、路径、方法，未知 API、媒体代理、站外地址与 WebSocket 均拒绝。每例必须观察到一次真实合成生成请求，并用未知本地 API 作为拒绝正控；不能把没有发请求当成功。服务器与 context 只清理本次创建的实例。

## 必须查看的产物

- `waiting/reasoning/streaming/completed.png`、`page.png`：卡片、正文、动作与元数据是否完整
- Markdown 的 `export.png`：实际打开确认正文首尾、模型/Tokens、Logo/二维码、合成署名、中文字形；没有思考/操作按钮。签名头与解码尺寸只证明 PNG 可读，不证明像素内容正确
- Web 的 `web-consented.png` 和 `generated-target.html`：原始目标字节相同；不要把下载文件打开到日常账号浏览器，沙箱外行为不在本验收范围
- `fonts.json`：computed 字体声明与 CDP rendered 字体/字形数分开记录；缺采样不能填一致，也没有自动判定字体是否符合期待
- `evidence.json` 或 `failure.json`：合成请求、已拒绝负控、对话框及错误；截图是组件浏览器证据，不是完整 Next 路由/SSR、真实后端、Tauri 或 Windows WebView2 验收

Node 回归无需浏览器：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/web-arena-acceptance.test.ts
```

隔离 jsdom smoke 不点击 PNG、不生成视觉通过结论。它使用已编译的真实组件与合成 HTTP；页面重挂载也不等于刷新恢复，当前持久化不保存完整结果/修复快照。
