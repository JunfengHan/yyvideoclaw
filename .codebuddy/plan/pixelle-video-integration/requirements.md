# 需求文档：Pixelle Video 深度集成为 yyvideoclaw 原生页面

## 引言

本文档定义将开源项目 **yy-Pixelle-Video**（本地路径 `/Users/johnhan/Desktop/myself/yy-Pixelle-Video`，Python FastAPI + Streamlit + ComfyUI/RunningHub 视频生成流水线）作为一个**原生页面**深度集成进 **yyvideoclaw** 的需求。

> 方案代号：**"Video Studio as First-Class Tab"**（下文简称"嵌入式方案"）

### 与上一版方案的核心差异

| 维度      | 旧方案（Plugin + Streamlit 独立进程）          | 本方案（嵌入式）                                                                                                   |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 用户形态  | 打开 Pixelle 单独的 Streamlit 页面             | 在 yyvideoclaw 左侧导航里看到 **Video Studio** Tab                                                                 |
| 前端      | Pixelle 自带 Streamlit UI                      | yyvideoclaw 内新增一个 **Lit view**（`video-studio-view`），UI 风格与现有 Chat / Settings / Dreams 等 tab 完全一致 |
| 后端      | 外部进程 + 插件 HTTP 调用                      | yyvideoclaw 托管并生命周期管理 Pixelle Python backend（`api/app.py`），前端直连本地 `127.0.0.1:<port>`             |
| LLM 凭据  | 用户需要复制 Gateway token 到 Pixelle 配置文件 | **零配置**：Pixelle backend 由 yyvideoclaw 启动，启动时自动注入一次性进程内 token，用户侧不感知 token 的存在       |
| 鉴权面    | 双份（Gateway token + Pixelle token）          | 单份（yyvideoclaw 本身，进程级信任链）                                                                             |
| 错误/日志 | 两个系统各自维护                               | 统一进 yyvideoclaw 日志/诊断面板                                                                                   |
| 模型切换  | Pixelle 设置页 + yyvideoclaw 设置页            | 只在 yyvideoclaw Settings 里一个下拉                                                                               |

### 核心设计原则

1. **Pixelle 成为 yyvideoclaw 的子系统**，不是"被打通的外部系统"。
2. **Pixelle 的 Python 源码不做破坏性修改**，改造集中在：(a) 新增 OpenClaw LLM provider；(b) 接受一次性进程 token；(c) 被 yyvideoclaw 子进程化启动。
3. **前端 UI 完全重写为 Lit 原生视图**（不使用 iframe 嵌入 Streamlit），以获得原生体验、暗色主题一致、键盘/焦点/国际化统一。
4. **全部 Python 业务逻辑通过 Pixelle 已有的 FastAPI 路由（`api/routers/*`）复用**，不迁移到 TypeScript。
5. **用户侧的 LLM 配置唯一来源是 yyvideoclaw Settings**；Pixelle 自己的 LLM 配置 UI 在嵌入模式下被隐藏/禁用。

---

## 需求

### 需求 1：新增左侧导航项 "Video Studio"

**用户故事：** 作为一名 yyvideoclaw 用户，我希望在主界面左侧导航栏看到"Video Studio"入口，以便一键进入视频生成工作台，而不是去 Pixelle 的独立网页。

#### 验收标准

1. WHEN 用户首次启动新版 yyvideoclaw THEN 系统 SHALL 在 `TAB_GROUPS` 中 `agent` 组尾部新增一项 `videoStudio`，路径 `/video-studio`，图标为 `film`（或近似多媒体语义图标）。
2. WHEN 用户点击该导航项 THEN 系统 SHALL 切换主内容区到 `<video-studio-view>` Lit 组件，且 URL 同步更新为 `<basePath>/video-studio`。
3. WHEN 用户直接访问 `<basePath>/video-studio` URL THEN 系统 SHALL 正确解析并渲染该 tab（复用现有 `tabFromPath` / `pathForTab`）。
4. WHEN 用户已在其他 tab 且有未保存草稿 THEN 系统 SHALL 不丢失该草稿（与现有其他 tab 的切换行为一致）。
5. IF 当前用户的 yyvideoclaw 安装包**未启用 Video Studio 功能开关**（`features.videoStudio = false`）THEN 系统 SHALL 不渲染该 tab，且路径访问回退到 `chat`。
6. WHEN 渲染该 tab THEN i18n 标题与副标题 SHALL 通过 `t("tabs.videoStudio")` / `t("subtitles.videoStudio")` 翻译，默认英文 "Video Studio"、中文 "Pixelle-Video"。

---

### 需求 2：yyvideoclaw 托管与生命周期管理 Pixelle backend

**用户故事：** 作为一名用户，我不想手动启动 Pixelle 服务，我希望 yyvideoclaw 能像管理自身的 Gateway 进程那样自动拉起、监控、关闭 Pixelle 后端，以便做到开箱即用。

#### 验收标准

1. WHEN 用户**首次进入** Video Studio tab 且 Pixelle backend 未运行 THEN 系统 SHALL 按需（lazy）启动一个 Pixelle 子进程。
2. WHEN 启动 Pixelle 子进程 THEN 系统 SHALL：
   - 使用随机可用端口（`127.0.0.1:<ephemeral-port>`），不占用用户固定端口；
   - 通过环境变量向子进程注入：
     - `PIXELLE_LLM_PROVIDER=openclaw`
     - `PIXELLE_OPENCLAW_BASE_URL=http://127.0.0.1:<yyvideoclaw-gateway-port>/v1`
     - `PIXELLE_OPENCLAW_TOKEN=<一次性进程 token>`（每次启动新生成，仅该子进程内有效）
     - `PIXELLE_OPENCLAW_AGENT=openclaw/llm-passthrough`
     - `PIXELLE_OPENCLAW_MODEL=<用户当前选择的默认模型>`
     - `PIXELLE_EMBEDDED_MODE=1`
   - 指定 `PIXELLE_DATA_ROOT` 到 yyvideoclaw 的用户数据目录（`<userData>/video-studio/`），隔离生成物。
3. WHEN Pixelle 子进程启动成功（健康检查 `GET /health` 返回 200）THEN 系统 SHALL 把该 endpoint 发布给前端（`window.videoStudioEndpoint` 或 UI state）。
4. WHEN 健康检查在 30s 内未通过 THEN 系统 SHALL 渲染错误卡片（"Video backend failed to start"），并暴露"查看日志"按钮（显示 stderr 最后 200 行）。
5. WHEN 用户退出 yyvideoclaw 主窗口 / 退出应用 THEN 系统 SHALL 优雅关闭 Pixelle 子进程（先 SIGTERM 给 10s，再 SIGKILL），绝不残留孤儿进程。
6. WHEN yyvideoclaw Gateway 重启或 token 轮换 THEN 系统 SHALL 同步重启 Pixelle 子进程以注入新 token（而不是热更新）。
7. IF 检测不到 Pixelle 安装（见需求 3）THEN 系统 SHALL 不尝试启动，而是在 UI 中提示"Install Video Studio"。

---

### 需求 3：Pixelle backend 的打包与分发

**用户故事：** 作为一名用户，我希望我装一次 yyvideoclaw 就能用上视频生成，而不需要去 git clone Pixelle 仓库、装 Python 依赖。

#### 验收标准

1. 系统 SHALL 支持以下至少一种分发形态（按优先级从高到低）：
   - **A. 二进制打包（首选）**：用 PyInstaller / Nuitka 把 `pixelle_video` + `api/app.py` 打成单文件可执行 `pixelle-backend`，放入 yyvideoclaw 的 `dist-runtime/video-studio/`。
   - **B. 本地虚拟环境**：yyvideoclaw 首次进入 Video Studio 时，通过内置 `uv` 在 `<userData>/video-studio/venv/` 安装 `pixelle-video` 包（从仓库固定 commit / PyPI wheel）。
2. WHEN 用户首次进入该 tab 且 backend 二进制/虚拟环境不存在 THEN 系统 SHALL 显示一个"安装向导卡片"：
   - 展示将要下载/安装的内容与大小；
   - 用户点击 "Install" 后显示实时进度；
   - 安装成功自动进入正常界面。
3. 系统 SHALL 记录已安装的 Pixelle 版本号（`<userData>/video-studio/VERSION`），并在 yyvideoclaw 升级时校验兼容矩阵。
4. IF 用户所处环境缺失 Pixelle 运行前置依赖（FFmpeg、Chromium / Playwright for frame rendering）THEN 系统 SHALL 检测并在"安装向导"中一并处理或给出安装指引。
5. 系统 SHALL 提供 `Uninstall Video Studio` 操作（Settings → Storage），可完整删除 `<userData>/video-studio/`。

---

### 需求 4：LLM 凭据自动注入（零配置）

**用户故事：** 作为一名用户，我不想再为 Pixelle 单独管理 API Key 或 Gateway token，我希望 yyvideoclaw 自动处理好一切。

#### 验收标准

1. WHEN yyvideoclaw 启动 Pixelle 子进程 THEN 系统 SHALL：
   - 为该子进程生成一个**一次性、进程生命周期的 bearer token**（例如 `proc-<uuid>`），通过 `GatewayEndpointStore` 注册为允许访问的内部客户端，标记为 `internal=true` 且不出现在用户可见的 Tokens 列表。
   - 仅把该 token 通过环境变量传入子进程的 stdin/env，不写入任何磁盘文件。
2. WHEN Pixelle 子进程终止 THEN 系统 SHALL 立即在 Gateway 侧撤销该 token。
3. 系统 SHALL 在 `llm-passthrough` agent 配置中强制：`tools.profile = "none"`、`memory.enabled = false`、`skills.enabled = false`、`hooks.enabled = false`、`compaction.enabled = false`、`heartbeat.enabled = false`。
4. IF Pixelle 子进程中的代码尝试调用非 `/v1/chat/completions` 的 Gateway endpoint THEN Gateway SHALL 返回 403，并记入审计日志。
5. WHEN 用户在 yyvideoclaw Settings 修改 "Video Studio Default Model" THEN 系统 SHALL 将新的模型 id 通过 **SIGHUP / IPC / 重启**策略应用到 Pixelle 子进程，UI 无需用户手动刷新。

---

### 需求 5：Video Studio 原生 Lit 视图

**用户故事：** 作为一名用户，我希望 Video Studio 的界面跟 yyvideoclaw 的 Chat、Settings 一样是原生风格、支持暗/亮主题、响应式布局、支持国际化，而不是嵌套一个风格迥异的 Streamlit 页面。

#### 验收标准

1. 系统 SHALL 在 `ui/src/ui/views/` 新增 `video-studio-view.ts`（Lit Element），并由 `app-render.ts` 的 tab 分发逻辑渲染。
2. 该视图 SHALL 至少提供以下子区块（MVP 范围）：
   - **(A) Topic 输入区**：单行标题 + 多行文案 + "Aspect Ratio" 单选（9:16 / 16:9 / 1:1） + "Frame Template" 下拉（枚举从 Pixelle `/api/frame/templates` 拉取）。
   - **(B) Pipeline 选择器**：`standard` / `asset-based` / `linear` / `custom`（与 Pixelle 现有 pipeline 一致）。
   - **(C) 生成按钮** 与 **实时进度面板**（订阅 `/api/tasks/{id}/events` SSE 或轮询 `/api/tasks/{id}`，分阶段展示：title → narration → images → frames → tts → compose）。
   - **(D) 结果区**：视频播放器 + 下载 / 复制链接 / 在 Finder 打开 / 重新生成 按钮。
   - **(E) 历史记录侧栏**：最近 N 次生成（读 Pixelle `/api/tasks` 列表），点击可重新查看/播放。
3. 所有文本 SHALL 通过 `t("videoStudio.*")` i18n key 翻译，至少提供 `en` 与 `zh-CN`。
4. 视图 SHALL 遵循现有暗/亮主题 CSS 变量（`var(--bg)`、`var(--text)` 等），不引入独立主题。
5. 视图 SHALL 响应式：在宽度 < 900px 时，历史记录侧栏折叠为抽屉。
6. 视图中的所有 HTTP 调用 SHALL 走一个集中封装 `videoStudioClient`（`ui/src/ui/video-studio/client.ts`），该客户端基于运行期 `window.videoStudioEndpoint` 与进程内 loopback token 访问。
7. WHEN Pixelle 子进程未就绪（启动中 / 失败 / 未安装）THEN 视图 SHALL 优雅降级为对应占位状态，不出白屏或报错 uncaught。
8. 视图 SHALL 不使用 iframe / webview 嵌入 Pixelle Streamlit；原 Streamlit UI 在嵌入模式下可关闭启动（`web/app.py` 不随 backend 启动）。

---

### 需求 6：Pixelle 侧的最小改造

**用户故事：** 作为一名维护者，我希望 Pixelle 仍然能作为独立开源项目运行（便于上游合并），同时在 yyvideoclaw 嵌入模式下表现为"听话的子进程"。

#### 验收标准

1. 系统 SHALL 在 `pixelle_video/services/llm_service.py` 新增 `OpenClawLLMProvider`（OpenAI 兼容 HTTP 客户端），当 `PIXELLE_LLM_PROVIDER=openclaw` 时启用。
2. 系统 SHALL 扩展 `pixelle_video/config/schema.py` 支持 `llm.provider = "openclaw"` 以及 `base_url` / `api_key` / `agent` / `model` 四个字段。
3. WHEN 环境变量 `PIXELLE_EMBEDDED_MODE=1` THEN Pixelle SHALL：
   - 不启动 Streamlit（`web/app.py`）；
   - 在 `/health` 响应中附加 `"embedded": true`；
   - 在所有日志前缀加 `[embedded]`；
   - 禁用自身的"LLM Settings" Streamlit 页面（即便被访问也返回提示）。
4. 系统 SHALL 在 `scripts/verify_pixelle_llm.py` 基础上增加一个 `--embedded-handshake` 模式，供 yyvideoclaw 启动后健康检查调用。
5. Pixelle SHALL 绑定 `127.0.0.1` 而**非** `0.0.0.0`（嵌入模式下强制），拒绝来自非 loopback 的连接。
6. 在独立模式（未设 `PIXELLE_EMBEDDED_MODE`）下，Pixelle 行为 SHALL 与上游保持完全一致，允许用户自行填 OpenAI/Claude 等 API Key。

---

### 需求 7：yyvideoclaw Settings 整合

**用户故事：** 作为一名用户，我希望在 yyvideoclaw 现有的 Settings 面板里找到所有 Video Studio 相关设置，而不是跳到另一个页面。

#### 验收标准

1. 系统 SHALL 在 `ui/src/ui/app-settings.ts` 对应侧栏新增一个 **"Video Studio"** section（位于 "AI Agents" 之后）。
2. 该 section SHALL 提供以下字段：
   - `Enable Video Studio`（功能总开关，对应需求 1.5 的 `features.videoStudio`）；
   - `Default LLM Model`（下拉，列表来自 yyvideoclaw 既有模型目录，按"LLM-capable"过滤；默认值 `qwen/qwen-max`）；
   - `Default Aspect Ratio`（9:16 / 16:9 / 1:1）；
   - `Default Frame Template`；
   - `Backend Status`（只读，显示：running / stopped / port / PID / uptime）；
   - `Install / Reinstall / Uninstall` 按钮；
   - `Open Logs` 按钮（跳到 Logs tab 并预筛 `source=video-studio`）。
3. WHEN 用户切换 Default Model 并 Save THEN 系统 SHALL 按需求 4.5 重启 Pixelle 子进程。
4. 这些配置 SHALL 持久化到用户配置文件（与现有 yyvideoclaw 配置相同位置），key 前缀 `videoStudio.*`。

---

### 需求 8：安全与隔离

**用户故事：** 作为一名注重安全的用户，我希望 Video Studio 的加入不会扩大 yyvideoclaw 的攻击面。

#### 验收标准

1. Pixelle 子进程 SHALL 仅监听 loopback，不开放外部端口。
2. 嵌入用的一次性 token SHALL 从不写盘、从不出现在日志、从不在 UI 展示。
3. 前端 `videoStudioClient` SHALL 只接受从 `window.videoStudioEndpoint` 获取的 URL，拒绝任意来源的 URL（防止 XSS 后被劫持请求）。
4. Pixelle 生成出的媒体文件 SHALL 写入 `<userData>/video-studio/outputs/` 沙箱目录，yyvideoclaw 的其他模块不允许写入此目录外的磁盘位置（遵循现有 `HostEnvSecurityPolicy`）。
5. 在 yyvideoclaw 的 `SECURITY.md` 与用户设置提示中 SHALL 新增一段说明："Video Studio uses a sandboxed local backend; no external API keys are required or stored by this feature."

---

### 需求 9：可观测性与故障恢复

**用户故事：** 作为一名维护者，出问题时我需要能在一个地方定位到根因，而不是要同时看两个系统的日志。

#### 验收标准

1. 系统 SHALL 把 Pixelle 子进程的 stdout/stderr 以行为单位转发至 yyvideoclaw 的 Logs tab，`source=video-studio`。
2. WHEN Pixelle 子进程意外退出 THEN 系统 SHALL 自动重试启动，最多 3 次，间隔 2s / 5s / 15s；超过后进入 `stopped` 状态并在 Video Studio 视图显示错误卡。
3. 系统 SHALL 在 Debug tab 新增一块 `Video Studio` 诊断，包含：
   - 子进程 PID / 端口 / 启动命令；
   - 最近一次健康检查耗时；
   - 最近 20 条 LLM 调用（仅显示 model id / token 消耗 / 耗时，不显示 prompt 内容）。
4. WHEN 用户点击 Debug 面板中的"Copy diagnostics" THEN 生成的诊断包 SHALL 包含 Video Studio 版本、Pixelle commit、最近 100 行日志（已脱敏 token）。

---

### 需求 10：性能与资源占用

**用户故事：** 作为一名未使用视频功能的用户，我不希望 yyvideoclaw 启动时就被 Pixelle 拖慢。

#### 验收标准

1. yyvideoclaw **冷启动时** SHALL 不启动 Pixelle 子进程，不加载任何 Pixelle Python 代码。
2. Pixelle 子进程 SHALL 仅在用户首次进入 Video Studio tab、或显式点击"Start Backend"时启动（lazy）。
3. WHEN 用户离开 Video Studio tab 且连续 **30 分钟**无活动任务 THEN 系统 SHALL 自动停止 Pixelle 子进程以回收资源（用户可在 Settings 关闭此行为）。
4. Pixelle backend 启动冷时间 SHALL 在 MacBook Pro M1 级别机器 ≤ 8s（二进制打包形态）。
5. 嵌入后的 yyvideoclaw 安装包体积增量 SHALL ≤ 150MB（排除可选 ComfyUI / Playwright 浏览器依赖）。

---

### 需求 11：与现有 Plugin 方案的关系

**用户故事：** 作为之前阅读过旧方案的利益相关者，我需要知道旧的 `yy-pixelle-video` 插件如何处置。

#### 验收标准

1. 本方案 SHALL 取消 "yyvideoclaw plugin" 形态；旧计划中提到的 `src/extensions/yy-pixelle-video/` 不再创建。
2. 如果上一轮已经存在任何 plugin 脚手架文件 THEN 在本轮实施中 SHALL 清理或改造为"嵌入式托管"用的进程管理模块（建议路径 `src/video-studio/`）。
3. 旧版 `scripts/verify_pixelle_llm.py` SHALL 保留并拓展为嵌入模式握手工具（见需求 6.4）。
4. 上游 `yy-Pixelle-Video` 仓库中新增的 OpenClaw provider SHALL 同时保留"独立运行"能力（见需求 6.6）以便回馈 / 保持 fork 可同步。

---

### 需求 12：成功标准

本集成 SHALL 在以下场景全部通过方可视为完成：

1. 用户全新安装 yyvideoclaw → 点击 Video Studio → 走完 Install 向导 → 输入主题"原子习惯" → 选择 9:16 → 点 Generate → ≤ 10 分钟内看到可播放 MP4。**全程零 API Key 输入**。
2. 用户在 Settings 把 Default Model 从 `qwen/qwen-max` 改为 `openai/gpt-4o-mini` → 下一次生成使用新模型，日志可验证。
3. 用户从任务管理器强行 kill Pixelle 子进程 → yyvideoclaw UI 在 15s 内显示 `backend crashed (retrying...)` 并自愈。
4. 用户断网 → 前端显示清晰错误而不是崩溃；恢复网络后能立即重试。
5. 用户卸载 Video Studio → `<userData>/video-studio/` 被完全清理，后续启动 yyvideoclaw 表现为"从未装过"。
6. 卸载/未启用 Video Studio 时，yyvideoclaw 启动时间与内存占用相比集成前差异 ≤ 5%。
