# 双向聊天机器人 实施文档（Implementation / Tech Design）

> 配套文档：docs/PRD.md
> 版本：v0.2
> 目标读者：开发者（你 + AI 协作）

---

## 1. 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| 运行平台 | Cloudflare Workers | 硬性要求；Serverless、免费额度、全球低延迟 |
| 接入方式 | Telegram Bot Webhook | Workers 适合处理 HTTP 回调，无需轮询 |
| 存储 | Cloudflare KV（绑定 `TG_BOT_KV`） | 单管理员场景够用：会话映射、验证状态、黑名单、拦截记录 |
| 语言 | TypeScript（strict） | 类型安全，便于维护 |
| 部署工具 | Wrangler | CF 官方 CLI，支持本地 dev、secret 管理 |
| AI（主） | 自有中转站（标准 OpenAI `chat/completions`） | 复用你的额度，模型/base_url 可配 |
| AI（备） | Cloudflare Workers AI（`env.AI`） | 中转站超额/故障时自动接管，免外部依赖，免费额度（Neurons）日配额 |

## 2. 总体架构（个人单管理员模式）

```
Telegram 陌生用户私聊
        │ (update)
        ▼
Telegram 服务器 ──webhook──▶ Cloudflare Worker
                                  │
   ┌──────────────────────────────┼───────────────────────────┐
   ▼                ▼              ▼              ▼             ▼
黑名单检查      验证状态检查     频率限制       AI 过滤        KV 读写
   │                │              │              │
   │         未验证→发验证题   超限→丢弃    拦截→记入"已拦截"
   │                │
   └──────► 正常：转发到【管理员个人私聊】，附发送者信息 ◄────────┘

管理员在与机器人私聊中【回复】被转发的消息
        │ (update, reply_to_message)
        ▼
      Worker ──查 reply 映射→定位 userId──▶ 复制内容发回该用户
```

关键点：默认没有管理群、没有话题。管理员就是和机器人本身的私聊，用 **reply（回复）** 来区分要回给哪个用户。

### 模式开关（RELAY_MODE）
- `private`（默认，v1 启用）：转发目标 = `ADMIN_UID` 私聊。
- `group`（预留，本期不启用）：转发目标 = `ADMIN_GROUP_ID` 群内每用户一个话题。
- `relay.ts` 抽象统一的转发目标接口 `RelayTarget`，两种模式各一套实现；v1 只接通 `private`，`group` 留接口占位与 TODO。开启 `group` 只需配 `ADMIN_GROUP_ID` 并切 `RELAY_MODE`，不改业务代码。

## 3. 请求处理流程

### 3.1 入口路由（Worker fetch）
- `POST /webhook`：Telegram 回调，校验 `X-Telegram-Bot-Api-Secret-Token` == `BOT_SECRET`。
- `GET /registerWebhook`：注册 webhook（需带 secret）。
- `GET /unregisterWebhook`：注销。
- `GET /health`：健康检查。

### 3.2 区分消息来源
- `from.id === ADMIN_UID` 且 `chat` 为私聊 → 视为**管理员消息**（回复中继 / 管理命令）。
- 其他私聊用户 → 视为**普通用户入站消息**。

### 3.3 用户 → 管理员（入站）
1. 黑名单检查：命中 → 静默丢弃。
2. 验证状态检查：
   - 未验证 → 进入/继续验证流程（见 3.5），消息**不转发**。
   - 已验证 → 继续。
3. 频率限制（KV 计数 + TTL）：超限 → 丢弃或提示。
4. **AI 过滤**（见 3.6）：
   - 命中拦截 → 写 `intercepted:<id>`，可给用户中性回执，不通知管理员。
   - 正常 → 转发。
5. 转发到管理员私聊：用 `forwardMessage` 或 `copyMessage` + 一段头部信息（昵称、@username、`uid:<id>`）。
5.1. **前台问候**：若配置了 `AUTO_GREETING` 且该用户本会话尚未问候过，回一句身份说明给陌生人（标记 `greeted`，不重复）。陌生人**不进入任何 AI 对话循环**。
6. 记录映射：`msgmap:<adminChatMsgId> -> userId`（带 TTL），供管理员回复时定位。

### 3.4 管理员 → 用户（出站）
1. 管理员在私聊里发消息：
   - 若是 `reply_to_message` → 取被回复消息的 id → 查 `msgmap` → 得 `userId` → `copyMessage` 给该用户。
   - 若是命令（`/block`、`/unblock`、`/intercepted`、`/pass` 等）→ 走管理逻辑。
   - 若 `reply` + `/ai <意向>` → **代笔**：取该会话上下文 + 意向，调用 AI 生成回复（见 3.7）。
   - 若 `/ai <问题>`（无 reply）→ **私人助理**：AI 直接回答管理员（多轮上下文）。
   - 若是普通文本无 reply → 提示"请回复某条转发消息，或用 /to <uid> 指定对象"。
2. 可选：`/to <userId> 内容` 主动发起。
3. 鉴权：以上全部要求 `from.id === ADMIN_UID`。

### 3.5 首次人机验证流程
- 触发：用户首次 `/start` 或首次发消息且 `verified` 未置位。
- `VERIFY_MODE`：
  - `math`（默认）：生成随机算术题（如 `3 + 4 = ?`），答案存 `verify:<userId>`（TTL）。
  - `quiz`：使用 `VERIFY_QUESTION` / `VERIFY_ANSWER`。
  - `turnstile`：返回一个指向 Worker 页面的链接，用户过 Turnstile 后回调置位（后续迭代）。
- 用户回答正确 → 置 `user:<userId>.verified = true`，提示可以开始；错误 → 重试，超过次数可临时限流。

### 3.6 AI 过滤模块设计（多级 Provider）
- 对外函数：`classifyMessage(text) -> { category, confidence, reason, provider }`
- 内部抽象：`AiProvider` 接口，两个实现：
  - `RelayProvider`：`POST {AI_BASE_URL}/chat/completions`，header `Authorization: Bearer {AI_API_KEY}`，body `{ model: AI_MODEL, messages, temperature: 0 }`。
  - `WorkersAiProvider`：调用绑定 `env.AI.run(CF_AI_MODEL, { messages })`（默认 `@cf/meta/llama-3.1-8b-instruct`）。
- **责任链 / 多级降级**（由 `AI_PROVIDER` 与 `AI_FALLBACK_TO_CF` 控制）：
  1. `relay`：中转站（主）。
  2. 中转站失败/超时/非 2xx 且 `AI_FALLBACK_TO_CF=true` → Workers AI（备）。
  3. 两者皆不可用 → 关键词规则。
  4. 规则未命中 → 默认放行并标注 `未过滤`。
  - `AI_PROVIDER=workers_ai` 时直接用 CF；`auto` 时按上面链路自动切换。
- 系统提示：统一设定为"广告/垃圾/诈骗识别器"，要求**只返回 JSON**；两种 provider 复用同一套 prompt 与解析逻辑。
- 超时：`AbortController` + `AI_TIMEOUT_MS`（默认 2500ms，仅对中转站 HTTP 生效；Workers AI 调用同样设保护）。
- 容错解析：从返回中截取 JSON；解析失败按"该级失败"处理并进入下一级。
- 判定：`category ∈ 拦截类` 且 `confidence >= FILTER_THRESHOLD` 才拦截。
- 记录命中的 `provider`，便于排查与统计（如中转站已耗尽时可见已切到 CF）。

### 3.7 AI 前台 / 代笔 / 助理设计
- 复用 3.6 的多级 Provider 通道（中转站 → Workers AI → 降级）。
- **前台（greeter）**：纯模板（`AUTO_GREETING`）即可，不必每次调 AI；默认不调用 AI，零额度消耗。
- **代笔（ghostwriter）**：`reply + /ai <意向>`
  - 取被回复消息 → `msgmap` → `userId` → 读该会话最近 `AI_CONTEXT_ROUNDS` 轮上下文（`ctx:<userId>`）。
  - prompt：系统设定“你在替【管理员】回复用户，语气得体、简洁；严格按管理员意向”，user 部分含意向 + 会话上下文。
  - `AI_REPLY_PREVIEW=preview`（默认）：先把草稿发给管理员，管理员确认/编辑后再发给用户；`send`：直接发给用户。
- **私人助理（assistant）**：`/ai <问题>`（无 reply）
  - 维护管理员自己的对话上下文 `ctx:admin`（最近 N 轮），与陌生人会话上下文隔离。
  - 直接返回给管理员，不外发。
- 鉴权：所有 `/ai` 入口先校验 `from.id === ADMIN_UID`；非管理员发 `/ai` 当普通消息处理，绝不进入 AI 对话。

## 4. 数据模型（KV）

| Key 模式 | Value | 用途 |
|----------|-------|------|
| `user:<userId>` | JSON（昵称、username、verified、createdAt） | 用户档案 |
| `verify:<userId>` | JSON（答案、尝试次数）TTL | 验证临时态 |
| `msgmap:<adminMsgId>` | userId（TTL，如 7 天） | 管理员回复 → 用户定位 |
| `block:<userId>` | 1 / 原因 | 黑名单 |
| `rate:<userId>` | 计数（TTL） | 频率限制 |
| `intercepted:<id>` | JSON（userId、原文、category、reason、time） | 已拦截消息 |
| `intercepted_index` | 最近拦截 id 列表 | 供 `/intercepted` 列表展示 |
| `ctx:<userId>` | 最近 N 轮该陌生人会话（供代笔） | 代笔上下文 |
| `ctx:admin` | 最近 N 轮管理员与助理对话 | 私人助理上下文 |
| `user:<userId>.greeted` | bool | 是否已发过前台问候，避免重复 |

## 5. 目录结构（规划）

```
twochatbot/
├─ docs/
│  ├─ PRD.md
│  ├─ IMPLEMENTATION.md
│  └─ CONVENTIONS.md
├─ src/
│  ├─ index.ts          # Worker 入口 & 路由
│  ├─ telegram.ts       # Telegram API 封装
│  ├─ relay.ts          # 双向中继（reply 映射）
│  ├─ verify.ts         # 首次人机验证
│  ├─ ai-filter.ts      # AI 过滤：多 Provider（中转站/Workers AI）+ 多级降级
│  ├─ moderation.ts     # 黑名单/关键词/频率
│  ├─ store.ts          # KV 封装
│  ├─ assistant.ts      # /ai 代笔 + 私人助理（上下文管理）
│  ├─ admin.ts          # 管理命令/按钮
│  └─ types.ts
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
└─ README.md
```

## 6. 部署步骤（规划）

1. 初始化 Wrangler + TS 项目。
2. 创建 KV：`wrangler kv namespace create TG_BOT_KV`，写入 `wrangler.jsonc` 绑定。
2.1. 启用 Workers AI 绑定：在 `wrangler.jsonc` 增加 `"ai": { "binding": "AI" }`（备份/降级用，无需额外建资源）。
3. 配 vars：`ADMIN_UID`、`AI_BASE_URL`、`AI_MODEL`、`VERIFY_MODE`、过滤开关与阈值等。
4. 配 secrets：`wrangler secret put BOT_TOKEN` / `BOT_SECRET` / `AI_API_KEY`。
5. 本地 `wrangler dev` 调试（用 CF tunnel / ngrok 暴露给 Telegram）。
6. `wrangler deploy`，得到 Worker URL。
7. 访问 `/registerWebhook?secret=...` 注册 webhook（带 secret_token）。
8. Telegram：BotFather 建 bot；用 @userinfobot 获取你的 `ADMIN_UID`。
9. 自测验收（PRD 第 8 节 AC1~AC6）。

## 7. 错误处理与可靠性

- Webhook 必须快速返回 200；耗时操作（AI、转发）用 `ctx.waitUntil`。
- 所有外部调用（Telegram、AI）try/catch + 降级 + 日志。
- AI 不可用绝不阻断正常消息中继（核心原则）。
- 幂等：对重复 `update_id` 用 KV 短 TTL 标记去重。

## 8. 测试策略

- 单元：`classifyMessage` 解析与降级分支；验证题生成与校验；KV 封装。
- 集成：模拟 Telegram update JSON（含普通用户 / 管理员 reply / 命令）打到 `/webhook`，断言行为。
- 手测：真实 bot 走 AC1~AC6。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| reply 映射过期导致无法回复老消息 | TTL 设较长（如 7 天）；过期提示用 `/to <uid>` |
| AI 误杀正常消息 | 阈值可调 + 拦截列表 + 一键放行 |
| AI 中转站不稳/超额 | 自动降级到 Workers AI（`AI_FALLBACK_TO_CF`），再降级关键词；开关可关 AI |
| Workers AI 免费 Neurons 耗尽 | 再降级到关键词规则；不阻断正常消息 |
| Webhook 被伪造 | secret_token 校验 |
| 验证被绕过/骚扰 | 验证 + 频率限制 + 黑名单组合 |

## 10. 迭代路线

- v1：个人双向中继（reply 映射）跑通。
- v2：首次验证 + AI 过滤 + 拦截列表 + 放行/拉黑。
- v3：频率限制、关键词、配置打磨。
- v2 起即内置 Workers AI 降级备份。
- v2/v3：前台问候 + `/ai` 代笔与私人助理。
- v4（可选）：Turnstile 验证、D1 + 全文检索 + 统计、各 provider 用量统计。
