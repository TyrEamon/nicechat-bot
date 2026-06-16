# nicechat-bot

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

---

## 配置变量总表

手动网页部署时，下列配置都要在 Cloudflare 后台对应位置添加。

### 一、Secrets（机密变量 — 必须加密，不可明文）

后台位置：`Workers & Pages` → 你的 Worker → `Settings` → `Variables and Secrets` → 添加时勾选 **Encrypt / Secret**。

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `BOT_TOKEN` | ✅ | Telegram bot token，@BotFather 给的 | `123456:ABC-DEF...` |
| `BOT_SECRET` | ✅ | 自定义随机字符串，校验 webhook 来源（注册 webhook 时也用它） | 自己生成一长串随机字符 |
| `AI_API_KEY` | ✅ | 你的中转站 API key | `sk-xxxx` |
| `SEARCH_API_KEY` |  | Brave Search 或 Tavily 的搜索 API key；不填则自动搜索关闭 | `BSA...` / `tvly-...` |

### 二、Vars（普通环境变量 — 明文即可）

后台同一页面，添加时**不勾选** Secret。

| 变量名 | 必填 | 默认/建议值 | 说明 |
|--------|------|------------|------|
| `ADMIN_UID` | ✅ | （你的数字ID） | 你的 Telegram 用户 ID，@userinfobot 获取。鉴权核心 |
| `RELAY_MODE` | ✅ | `private` | `private`=个人私聊（启用）；`group`=管理群/话题（预留，暂别用） |
| `ADMIN_GROUP_ID` |  | （留空） | 仅 `group` 模式用，以 `-100` 开头。现在留空 |
| `AI_BASE_URL` | ✅ | （中转站地址） | OpenAI 兼容 base url，**不要带** `/chat/completions`。如 `https://your-relay.com/v1` |
| `AI_MODEL` | ✅ | `gpt-4o-mini` | 中转站使用的模型名 |
| `AI_TIMEOUT_MS` |  | `2500` | 中转站调用超时（毫秒），超时自动降级 |
| `AI_PROVIDER` |  | `auto` | `relay`=只用中转站；`workers_ai`=只用CF；`auto`=主备自动切换（推荐） |
| `AI_FALLBACK_TO_CF` |  | `true` | 中转站失败时回落 Cloudflare Workers AI |
| `CF_AI_MODEL` |  | `@cf/meta/llama-3.1-8b-instruct` | Workers AI 备用模型名 |
| `FILTER_ENABLED` |  | `true` | AI 过滤总开关 |
| `FILTER_THRESHOLD` |  | `0.6` | 判为垃圾的置信度阈值（0~1）。调高=更宽松不易误杀，调低=更严格 |
| `BLOCK_KEYWORDS` |  | （留空） | 硬拦截关键词，用 `|` 或换行分隔。AI 不可用时的兜底 |
| `VERIFY_MODE` |  | `math` | 首次验证方式。`math`=算术题（默认）；`quiz`=自定义问答 |
| `VERIFY_QUESTION` |  | （留空） | `quiz` 模式的问题 |
| `VERIFY_ANSWER` |  | （留空） | `quiz` 模式的答案 |
| `WELCOME_MESSAGE` |  | 见下 | 用户发 `/start` 的欢迎语 |
| `AUTO_GREETING` |  | 见下 | 前台自动身份问候语。**留空则不自动问候** |
| `AI_REPLY_PREVIEW` |  | `preview` | 代笔模式。`preview`=草稿先给你确认；`send`=直接发给对方 |
| `AI_CONTEXT_ROUNDS` |  | `6` | AI 多轮上下文保留轮数 |
| `AUTO_SEARCH_ENABLED` |  | `true` | 自动搜索判断开关；只有配置 `SEARCH_API_KEY` 后才会真正搜索 |
| `SEARCH_PROVIDER` |  | `brave` | 搜索服务：`brave` / `tavily` |
| `SEARCH_MAX_RESULTS` |  | `5` | 每次搜索取回的结果数，建议 3~5 |
| `SEARCH_DECISION_MODEL` |  | （留空） | 搜索决策用模型；留空则使用当前模型 |

文本类建议值：
- `WELCOME_MESSAGE`：`你好，我是这台双向机器人。请先通过一个简单验证再开始对话。`
- `AUTO_GREETING`：`您好，这里是主人的助理，消息已转达，请稍候回复。`

### 三、绑定（Bindings — 不是变量，单独配）

| 绑定 | 类型 | 后台位置 | 说明 |
|------|------|----------|------|
| `TG_BOT_KV` | KV Namespace | `Settings` → `Bindings` → `KV namespace` | Variable name 必须填 `TG_BOT_KV`；先去 `Storage & Databases` → `KV` 创建命名空间再绑定 |
| `AI` | Workers AI | `Settings` → `Bindings` → `Workers AI` | Variable name 必须填 `AI`；无需额外建资源 |

---

## 网页手动部署步骤

1. **建 bot**：@BotFather → 拿 `BOT_TOKEN`；@userinfobot → 拿你的 `ADMIN_UID`。
2. **建 Worker**：`Workers & Pages` → `Create` → `Create Worker` → 起名（如 `nicechat-bot`）→ Deploy（先用默认 Hello World）。
3. **传代码**：网页编辑器适合单文件，本项目是多文件 TS。**推荐**连 GitHub 自动部署：Worker → `Settings` → 连接 `TyrEamon/nicechat-bot` 仓库，Cloudflare 会按 `wrangler.jsonc` 自动构建部署。之后只改仓库即可。
4. **建并绑 KV**：`Storage & Databases` → `KV` → 创建命名空间 → 回 Worker 的 `Settings` → `Bindings` 添加，名字填 `TG_BOT_KV`。
5. **绑 Workers AI**：`Settings` → `Bindings` → 添加 `Workers AI`，名字填 `AI`。
6. **填 Secrets + Vars**：按上面两张表，在 `Settings` → `Variables and Secrets` 全部填好。
7. **注册 webhook**：浏览器访问
   `https://<你的worker域名>/registerWebhook?secret=<你填的BOT_SECRET>`
   看到 `✅ webhook set to ...` 即成功。
7.1 **注册命令菜单**（可选）：访问
   `https://<你的worker域名>/setcommands?secret=<你填的BOT_SECRET>`
   陌生人菜单只显示 `/start`，你（ADMIN_UID）的私聊显示完整管理菜单。
8. **测试**：换个小号给 bot 发消息走验证→转发；你这边 reply 那条转发消息试回复；发 `/ai 你好` 试助理。

---

## 注意事项

- `wrangler.jsonc` 里 `kv_namespaces[0].id` 的 `REPLACE_WITH_YOUR_KV_ID`：若走 GitHub 自动部署，需替换成你建的 KV 真实 id（KV 命名空间详情页可见），否则构建报错。改完 push 即可。
- `AI_BASE_URL` 末尾**别加** `/chat/completions`，代码会自动拼。带不带末尾 `/` 都行。
- 改了 Secret/Var 后 Worker 一般自动生效；若没生效重新 Deploy 一次。
- webhook 注册一次即可，除非换了域名或 `BOT_SECRET`。

---

## 本地开发（可选）

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入 BOT_TOKEN / BOT_SECRET / AI_API_KEY
npm run dev
```

CLI 部署（替代网页方式）：

```bash
npm run kv:create                 # 把输出的 id 填进 wrangler.jsonc
npx wrangler secret put BOT_TOKEN
npx wrangler secret put BOT_SECRET
npx wrangler secret put AI_API_KEY
npm run deploy
```

---

## 管理命令（仅 ADMIN_UID 可用）

- reply 转发消息 + 文本 → 回复该用户
- reply 转发消息 + `/ai <意向>` → AI 代笔草稿，草稿下方可点“确认回复 / 重新生成 / 自行回复”
- `/ai <问题>` → 与私人助理对话
- `/model` → 查看当前模型；`/model list` 列出可用模型；`/model <名字>` 切换；`/model default` 恢复默认
- `/to <uid> 内容` → 主动给某用户发消息
- `/block` / `/unblock`（reply 或带 uid）→ 拉黑/解封
