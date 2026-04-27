# yyvideoclaw Side: Gateway + Passthrough Agent Configuration Reference

> 此文件为 **参考配置片段**，供实施阶段人手合并进用户的 `~/.openclaw/config.yaml`（或等价的 `config.json5`）。
>
> 该配置完成以下两件事：
>
> 1. 启用 OpenAI 兼容 Gateway `/v1/chat/completions`（Pixelle 的 `LLMService` 通过它复用 yyvideoclaw 的 LLM 能力）。
> 2. 定义一个名为 `llm-passthrough` 的透明 agent：空 system prompt、禁用一切工具/记忆/钩子，默认使用 `qwen/qwen-max` 作为底层 model。
>
> 配合 `x-openclaw-model` 请求头，Pixelle 侧可以在每次请求时动态切换任何 yyvideoclaw 支持的底层模型（见 `requirements.md` §3）。

---

## 1. Gateway OpenAI-Compat 端点

```yaml
gateway:
  http:
    # Bind loopback only. 远程部署请配合 SSH tunnel / tailnet，切勿开放到公网。
    listen: "127.0.0.1:18789"
    endpoints:
      chatCompletions:
        enabled: true
        # 允许 Pixelle 在本地或容器宿主上调用；建议与默认值保持一致。
        # maxBodyBytes: 2_000_000

  # Bearer token 鉴权（Pixelle 会在 Authorization: Bearer <token> 中携带）
  auth:
    mode: "token"
    # 生产环境请改为通过环境变量注入，或使用 auth profile 存储：
    #   token: "${OPENCLAW_GATEWAY_TOKEN}"
    token: "replace-me-with-a-strong-random-token"
```

## 2. `llm-passthrough` 透明 Agent

```yaml
agents:
  list:
    - id: "llm-passthrough"
      # 重要：空 system prompt，让 Pixelle 的业务 prompt 完整直达底层模型
      systemPrompt: ""

      # 默认底层模型；可被请求头 x-openclaw-model 覆盖
      model: "qwen/qwen-max"

      # 关闭一切 agent-style 加工，保证"prompt in / text out"语义等价于直连
      tools:
        profile: "none" # 禁用所有工具
        alsoAllow: []
      memory:
        enabled: false
      skills:
        enabled: false
      hooks:
        enabled: false
      thinkingDefault: false
      reasoningDefault: false
      compaction:
        enabled: false
      heartbeat:
        enabled: false
```

> 注：字段名以 yyvideoclaw 当前 schema 为准。若某字段在当前 schema 下不存在，说明默认就是"关闭"或"空"，**无需声明**；本参考里列出是为了让意图显式。

---

## 3. 验证链路可用性（curl）

启动 yyvideoclaw 后，执行以下命令验证 Gateway + passthrough agent 通路：

```bash
# ①最基础：使用 agent 自身默认 model（qwen/qwen-max）
curl -sS -X POST "http://127.0.0.1:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw/llm-passthrough",
    "messages": [{"role": "user", "content": "ping"}],
    "max_tokens": 16
  }'

# ②通过 x-openclaw-model 在请求级别 override 底层模型
curl -sS -X POST "http://127.0.0.1:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "x-openclaw-model: openai/gpt-4o-mini" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw/llm-passthrough",
    "messages": [{"role": "user", "content": "ping"}],
    "max_tokens": 16
  }'
```

预期：返回标准 OpenAI 格式 `{ "choices":[{"message":{"content":"..."}}], ... }`。

---

## 4. 备注

- 本参考片段不直接修改仓库内任何代码；完整用户文档将在计划第 9 步产出至 [docs/plugins/yy-pixelle-video.md](../../../docs/plugins/yy-pixelle-video.md)（届时含 Docker / 安全警告 / live test 指引）。
- 若用户使用 JSON5 而非 YAML：字段路径一致，仅格式不同。
- 远程部署场景请务必参考 `requirements.md` §7（安全边界）。
