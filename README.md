# twochatbot

部署在 Cloudflare Workers 上的 **Telegram 个人双向聊天机器人**，带 AI 智能过滤。

陌生人给你发消息 → AI 当**门卫**过滤广告/诈骗/垃圾 → **前台**自动回一句身份问候并把消息转发给你 → 你直接回复，或用 `/ai <意向>` 让 AI **代笔**。你也能随时 `/ai <问题>` 和 AI **私人助理**聊天。陌生人**永不**直接与 AI 对话。

详见 `docs/PRD.md`、`docs/IMPLEMENTATION.md`、`docs/CONVENTIONS.md`。

## 功能

- 双向消息中继（个人私聊模式，靠 reply 区分用户；管理群/话题模式 `RELAY_MODE=group` 预留未启用）
- 新用户首次人机验证（默认算术题）
- AI 多级过滤：你的中转站 → Cloudflare Workers AI（额度备份）→ 关键词 → 放行
- 被拦消息进"已拦截"区，不打扰你
- 前台身份问候（模板，零额度）
- `/ai` 代笔（按意向+上下文代写）与私人助理（多轮对话）
- 拉黑/解封、频率限制、Webhook 密钥校验

## 部署

前置：Node 18+、一个 Telegram Bot（@BotFather）、你的 Telegram 用户 ID（@userinfobot）、Cloudflare 账号。

```bash
npm install

# 1. 创建 KV，把输出的 id 填进 wrangler.jsonc 的 kv_namespaces[0].id
npm run kv:create

# 2. 配置 secrets
npx wrangler secret put BOT_TOKEN     # Telegram bot token
npx wrangler secret put BOT_SECRET    # 自定义随机字符串，用于 webhook 校验
npx wrangler secret put AI_API_KEY    # 你的中转站 key

# 3. 在 wrangler.jsonc 的 vars 里填：ADMIN_UID、AI_BASE_URL、AI_MODEL 等

# 4. 部署
npm run deploy

# 5. 注册 webhook（用你设的 BOT_SECRET）
#    浏览器访问：https://<你的worker域名>/registerWebhook?secret=<BOT_SECRET>
```

本地开发：复制 `.dev.vars.example` 为 `.dev.vars` 填入 secrets，然后 `npm run dev`。

## 配置项

见 `wrangler.jsonc` 注释与 `docs/PRD.md` 第 7 节。关键项：
- `ADMIN_UID`：你的 Telegram 用户 ID（鉴权核心）
- `RELAY_MODE`：`private`（默认）/ `group`（预留）
- `AI_PROVIDER`：`relay` / `workers_ai` / `auto`（默认）
- `AI_FALLBACK_TO_CF`：中转站超额时回落 Workers AI
- `VERIFY_MODE`、`AUTO_GREETING`、`AI_REPLY_PREVIEW`、`FILTER_THRESHOLD` 等

## 管理命令（仅 ADMIN_UID 可用）

- reply 转发消息 + 文本 → 回复该用户
- reply 转发消息 + `/ai <意向>` → AI 代笔回复该用户
- `/ai <问题>` → 与私人助理对话
- `/to <uid> 内容` → 主动给某用户发消息
- `/block` / `/unblock`（reply 或带 uid）→ 拉黑/解封
