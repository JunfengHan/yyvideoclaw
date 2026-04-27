# 实施计划：Pixelle Video 深度集成为 yyvideoclaw 原生页面

> 目标：落地"Video Studio as First-Class Tab"嵌入式方案。任务以"可编码、可验证、可渐进交付"为准绳，控制在 10 项左右，按依赖顺序排列。

---

- [ ] 1. 清理旧 plugin 方案 & 建立嵌入式骨架目录
  - 在 `yyvideoclaw` 仓库下清理/归档旧 `extensions/yy-pixelle-video/` 脚手架（若存在），改为标记 deprecated 而不真实 load。
  - 新建 `src/video-studio/` 目录（TypeScript 核心模块）与 `ui/src/ui/video-studio/` 目录（前端模块），并写入各自的 `README.md` 说明边界与入口。
  - 在 `features` 配置骨架中新增开关 `features.videoStudio`（默认 `false`，Dev 构建下 `true`）。
  - _需求：11.1, 11.2, 1.5_

- [ ] 2. Pixelle 侧最小改造（Python）：OpenClaw provider + embedded 模式
  - 2.1 在 `pixelle_video/config/schema.py` 扩展 `LLMConfig`：`provider: Literal["openai","openclaw"]`、`base_url`、`api_key`、`agent`、`model`；默认值保持向后兼容。
  - 2.2 在 `pixelle_video/services/llm_service.py` 新增 `OpenClawLLMProvider`（基于 OpenAI SDK，`extra_headers={"x-openclaw-model": model}`），并在工厂里按 `PIXELLE_LLM_PROVIDER=openclaw` 优先于 config 读取。
  - 2.3 在 `api/app.py` 启动处理 `PIXELLE_EMBEDDED_MODE=1`：强制 `host=127.0.0.1`、不拉 Streamlit、`/health` 返回 `{embedded:true}`、日志前缀 `[embedded]`；禁用 `web/pages/settings.py` 中 LLM 区块（嵌入模式下显示只读提示）。
  - 2.4 扩展 `scripts/verify_pixelle_llm.py` 支持 `--embedded-handshake` 子命令，供父进程用作启动探针。
  - 2.5 为 2.1 / 2.2 / 2.3 补齐 `tests/services/test_llm_service.py` 与 `tests/conftest.py` 中相应 pytest 用例（独立模式与嵌入模式各一条 happy path）。
  - _需求：6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 4.1, 4.5_

- [ ] 3. Pixelle backend 打包与分发机制（yyvideoclaw 侧）
  - 在 `scripts/video-studio/` 新增 `build-backend.mjs`：调用 PyInstaller 将 Pixelle 打成 `pixelle-backend` 单文件二进制，产物放 `dist-runtime/video-studio/<platform>-<arch>/`。
  - 在 `src/video-studio/installer.ts` 实现：(a) 检测二进制是否存在；(b) 版本文件 `<userData>/video-studio/VERSION` 读写；(c) 回退策略——用 `uv` 在 `<userData>/video-studio/venv/` 从固定 commit 构建 venv；(d) `uninstall()` 删除整个 `<userData>/video-studio/`。
  - 前置依赖（FFmpeg、Chromium/Playwright）检测放在 `src/video-studio/preflight.ts`，返回结构化报告供 UI 消费。
  - 配套 vitest 单测：安装 / 升级 / 卸载三条路径各一个。
  - _需求：3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 4. Pixelle 子进程生命周期管理器（yyvideoclaw 核心）
  - 在 `src/video-studio/process-manager.ts` 实现 `PixelleBackendSupervisor`：lazy 启动、端口探测（ephemeral port）、环境变量注入（`PIXELLE_LLM_PROVIDER`/`PIXELLE_OPENCLAW_*`/`PIXELLE_EMBEDDED_MODE`/`PIXELLE_DATA_ROOT`）、`/health` 探活（30s timeout）、stdout/stderr 行级转发、SIGTERM→SIGKILL 优雅关闭。
  - 实现崩溃指数退避重试（2s/5s/15s，≤3 次），超限进入 `stopped` 状态并对外发 `backend-crashed` 事件。
  - 暴露 `startIfNeeded()`、`stop()`、`restart()`、`getStatus()` 供 UI 与 Settings 调用；并注册应用退出钩子确保无孤儿进程。
  - 实现 30 分钟空闲自动停（用户可在 Settings 关闭，配置键 `videoStudio.autoStopIdleMinutes`）。
  - 补 vitest 用例：启动成功/启动超时/崩溃重试/优雅关闭四条路径。
  - _需求：2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 9.1, 9.2, 10.1, 10.2, 10.3_

- [ ] 5. Gateway 集成：一次性进程 token + llm-passthrough agent
  - 在 `src/video-studio/internal-token.ts` 新增 `issueEphemeralToken()`：调用现有 `GatewayEndpointStore`，注册 `internal=true` 且不出现在用户可见 Tokens 列表的临时 bearer；暴露 `revoke(token)`，由 `PixelleBackendSupervisor` 在进程终止时调用。
  - 在 Gateway 鉴权中间件中加校验：`internal` token **仅允许** `POST /v1/chat/completions`，其它路径返回 403 并审计；补单测。
  - 在 yyvideoclaw 默认 agents 配置中新增 `llm-passthrough` agent，强制 `tools.profile="none"`、`memory/skills/hooks/compaction/heartbeat` 全部 `enabled=false`，并在启动时校验（配置漂移即报警）。
  - _需求：4.1, 4.2, 4.3, 4.4, 8.2_

- [ ] 6. 左侧导航注册 Video Studio tab
  - 修改 `ui/src/ui/navigation.ts`：在 `TAB_GROUPS` 的 `agent` 组追加 `videoStudio`，新增 `TAB_PATHS.videoStudio = "/video-studio"`，`iconForTab` 返回 `film`（若 icon set 无则新增 `film` SVG 到 `ui/src/ui/icons/`）。
  - 修改 `ui/src/ui/app-render.ts`（或等效分发处）把 `videoStudio` tab 渲染为 `<video-studio-view>`，并在 `features.videoStudio=false` 时隐藏入口 + 路径回退到 `chat`。
  - 在 `ui/src/i18n/en.json` 与 `ui/src/i18n/zh-CN.json` 补 `tabs.videoStudio` / `subtitles.videoStudio` 以及下方 5/7 用到的所有 `videoStudio.*` key。
  - 补 vitest/DOM 测试：tab 切换、URL 同步、功能开关关闭时的回退。
  - _需求：1.1, 1.2, 1.3, 1.5, 1.6_

- [ ] 7. `videoStudioClient` 前端 SDK
  - 在 `ui/src/ui/video-studio/client.ts` 封装对 Pixelle FastAPI 的 fetch 调用：`getTemplates()`、`getPipelines()`、`createVideoTask(req)`、`getTask(id)`、`listTasks()`、`streamTaskEvents(id)`（SSE 优先、回退轮询）、`getMediaUrl(path)`。
  - 所有请求必须读取 `window.videoStudioEndpoint`（由核心侧注入），非 loopback 一律拒绝；带上 supervisor 提供的 loopback token。
  - 添加错误归一化层（`BackendNotReadyError` / `InstallRequiredError` / `TaskFailedError`），供视图直接 switch 渲染。
  - 补 vitest 用例 + msw mock Pixelle API。
  - _需求：5.6, 8.1, 8.3_

- [ ] 8. `<video-studio-view>` Lit 视图（MVP 五大区块）
  - 新建 `ui/src/ui/views/video-studio-view.ts`（Lit Element），布局：Topic 输入区 / Pipeline 选择 / Generate 按钮 + 进度面板 / 结果播放器 / 历史记录侧栏（<900px 折叠）。
  - Topic 输入区：标题 + 文案 + Aspect Ratio 单选（9:16/16:9/1:1） + Frame Template 下拉（从 `videoStudioClient.getTemplates()` 拉）。
  - Progress 面板订阅 `streamTaskEvents()`，按阶段（title→narration→images→frames→tts→compose）渲染。
  - Result 区：`<video>` 播放 + 下载/复制链接/在 Finder 打开/重新生成。
  - 历史记录侧栏：调用 `listTasks()`，点击回灌任务到结果区。
  - 后端未就绪态：渲染 Install 向导卡 / 启动中 loading / 错误卡 + 查看日志 按钮（跳 Logs tab）。
  - 使用 `var(--bg)`/`var(--text)` 等既有 CSS 变量，保持暗/亮主题与现有 view 一致；i18n 全覆盖。
  - 补 Playwright 或 Storybook 级交互测试一个 happy path。
  - _需求：5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 2.4, 2.7_

- [ ] 9. Settings 面板接入 & 持久化配置
  - 修改 `ui/src/ui/app-settings.ts`：在 "AI Agents" 之后插入 "Video Studio" section，字段：`Enable Video Studio`、`Default LLM Model`（下拉，来源于现有模型目录，默认 `qwen/qwen-max`）、`Default Aspect Ratio`、`Default Frame Template`、只读 Backend Status（PID/port/uptime）、Install/Reinstall/Uninstall 按钮、Open Logs 按钮。
  - 在用户配置 schema 中注册 `videoStudio.*` 键，读写走现有持久化层。
  - Save 时若 Default Model 变更，调用 `PixelleBackendSupervisor.restart()`（对应需求 4.5）。
  - 补 vitest 单测 + 配置迁移（老用户首次加载时无 `videoStudio` 节点走默认值）。
  - _需求：7.1, 7.2, 7.3, 7.4, 4.5_

- [ ] 10. 可观测性、安全说明 & 端到端验证脚本
  - 10.1 日志/诊断：将 Pixelle stdout/stderr 转发到 yyvideoclaw Logs tab（`source=video-studio`）；在 Debug tab 注册 `VideoStudioDiagnostics` 模块显示 PID/port/启动命令/最近健康检查耗时/最近 20 次 LLM 调用摘要（脱敏）；`Copy diagnostics` 生成的诊断包追加 Video Studio 版本与 Pixelle commit。
  - 10.2 安全固化：沙箱目录写入加到 `HostEnvSecurityPolicy` 白名单只允许 `<userData>/video-studio/outputs/`；在 `SECURITY.md` 追加 "Video Studio" 段落；确认 token 不落盘/不进日志（审计单测一条）。
  - 10.3 新增 `scripts/video-studio/e2e-smoke.mjs`：冷启动→进入 tab→（若需）Install→提交"原子习惯"主题→等待任务完成→断言 MP4 存在且可播放；并加一条"强 kill 子进程后 15s 内自愈"的断言。
  - 10.4 在 `CHANGELOG.md` 与 `docs/` 下新增 `docs/features/video-studio.md` 用户文档（安装/使用/卸载/FAQ）。
  - _需求：8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 10.4, 10.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_
