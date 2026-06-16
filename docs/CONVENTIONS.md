# 开发规范（Conventions）

> 配套：docs/PRD.md、docs/IMPLEMENTATION.md
> 版本：v0.1

---

## 1. 技术栈基线

- 语言：TypeScript（`strict: true`）。
- 运行时：Cloudflare Workers（Module Worker，`export default { fetch, scheduled }`）。
- 工具链：Wrangler + npm。
- 存储：Cloudflare KV（绑定名 `TG_BOT_KV`）。本项目为个人单管理员双向工具，默认 KV；后续如需检索/统计再评估 D1。

## 2. 目录与命名

- 源码放 `src/`，按职责分模块（见实施文档第 5 节）。
- 文件名：小写中划线或简洁单词，如 `ai-filter.ts`、`store.ts`。
- 类型集中放 `src/types.ts`，导出 `interface` / `type`。
- 命名约定：
  - 变量 / 函数：`camelCase`（不使用单字母变量）。
  - 类型 / 接口：`PascalCase`。
  - 常量：`UPPER_SNAKE_CASE`。
  - 环境变量：`UPPER_SNAKE_CASE`，集中在 `Env` 接口声明。

## 3. 配置与密钥（强制）

- **严禁**把 Token / Key / Secret 写进代码或提交到仓库。
- 密钥类用 `wrangler secret put`（如 `BOT_TOKEN`、`BOT_SECRET`、`AI_API_KEY`）；`ADMIN_UID` 等非敏感项用 vars。
- 非敏感配置用 `wrangler.jsonc` 的 `vars`。
- 新增配置必须同步更新：`Env` 接口 + 实施文档配置表 + README。
- 提交前检查：`.gitignore` 必含 `.dev.vars`、`.wrangler/`、`node_modules/`。

## 4. 代码风格

- 格式化：Prettier（2 空格缩进，单引号，行宽 100，结尾分号）。
- Lint：ESLint（`@typescript-eslint`）。提交前需通过。
- 不写无意义注释；仅在逻辑不自明处加简短中文/英文注释。
- 函数短小单一职责；对外副作用（网络、KV）集中在封装层，不散落业务逻辑里。
- 错误处理：外部调用一律 try/catch，并有明确降级路径；禁止吞错不记录。

## 5. 核心工程原则（与本项目强相关）

- P1 **AI 不可阻断主链路**：AI 调用失败 / 超时必须降级，正常消息绝不因 AI 丢失或卡住。降级顺序固定：中转站 → Workers AI → 关键词 → 放行。
- P2 **Webhook 快速返回**：耗时操作用 `ctx.waitUntil`，先回 200 给 Telegram。
- P3 **安全入口**：`/webhook` 必校验 `secret_token`；管理操作必校验来源是管理员/管理群。
- P4 **幂等**：处理 `update_id` 去重，避免重试导致重复转发。
- P5 **最小数据留存**：只存必要字段；敏感日志默认关闭，调试用开关控制。
- P6 **个人单管理员模型**：无管理群/话题；管理员=与机器人的私聊，靠 reply 映射区分目标用户；管理操作必校验 `from.id === ADMIN_UID`。
- P7 **先验证后处理**：未通过首次人机验证的用户消息不得转发给管理员。
- P8 **模式可扩展不可删**：管理群/话题模式以 `RELAY_MODE=group` 预留，默认 `private`；新增转发逻辑须经 `relay.ts` 的统一转发接口，禁止把模式判断散落各处。
- P9 **AI 不对陌生人开放对话**：陌生人永不进入 AI 多轮对话循环；`/ai` 代笔与私人助理仅 `ADMIN_UID` 可用，非管理员发 `/ai` 一律按普通消息处理。
- P10 **前台问候零额度优先**：前台身份问候用模板（`AUTO_GREETING`），默认不调用 AI，避免无谓额度消耗。

## 6. AI 调用规范

- 统一走 `ai-filter.ts`，对外暴露 `classifyMessage(text)`；内部以 `AiProvider` 接口实现中转站与 Workers AI，禁止在业务层直接拼 AI 请求。
- 新增/调整 provider 必须走责任链与统一 prompt，保持两端解析逻辑一致。
- 请求带超时（`AbortController` + `AI_TIMEOUT_MS`）。
- 强制要求模型只输出 JSON，并对返回做**容错解析**（截取 JSON、解析失败即降级）。
- `temperature: 0`，保证判定稳定可复现。
- 任何 prompt 变更需在 PR 描述里说明，并附测试样例（正常/广告/诈骗各一）。

## 7. Git 与提交规范

- 分支：`main` 稳定可部署；功能用 `feat/xxx`、修复用 `fix/xxx`。
- 提交信息（Conventional Commits）：
  - `feat: 双向中继跑通`
  - `fix: AI 超时未降级`
  - `docs: 更新 PRD`
  - `refactor: 拆分 relay 模块`
  - `chore: 配置 wrangler`
- 一次提交聚焦一件事；不混入无关格式化大改动。
- 不提交密钥、构建产物、`.wrangler/`。

## 8. 测试与验收

- 改动核心逻辑（中继 / 过滤）需补或更新对应测试。
- 部署前自测 PRD 第 8 节 AC1~AC5。
- AI 相关改动额外验证：构造广告样本被拦、正常样本不误杀、AI 故障降级正常。

## 9. 文档同步（强制）

- 改了行为 → 更新 PRD；改了架构/流程 → 更新实施文档；改了约定 → 更新本规范。
- README 保持"如何部署、如何配置、如何注册 webhook"可照做。

## 10. Definition of Done（完成定义）

一个功能算"完成"需满足：
- 代码合入 `main` 且能 `wrangler deploy` 成功。
- 相关配置/密钥说明已更新。
- 通过对应 AC 自测。
- 文档（PRD/实施/规范/README）与现状一致。



