# Notion 按钮 → Claude Code 自动化：交接文档

> 给 Claude Code 的说明：这是在 Claude 对话中讨论定下的设计，请先完整读完本文件和 `fixtures/notion-button-payload.json`，再动手。标注「待定」的地方先问我，不要自行决定。

## 1. 目标

在 Notion 数据库里点一个按钮，就让**按钮所有者自己的** Claude Code 去处理那一页（比如补全笔记、出例题），结果写回该 Notion 页面。

后台（多用户）可以：
- 修改每个按钮对应的「操作」（提示词模板），不用回 Notion 改配置
- 管理按钮归属：按钮属于谁、用谁的 Claude routine token、允许哪些 Notion 用户点击
- 查看运行记录

技术栈：**Appwrite**（Functions + TablesDB + Sites）+ **Clerk**（后台登录）+ **Claude Code Routines**（执行）。

## 2. 已确认的外部约束

### Notion「Send webhook」动作
- 只发 POST；只能自定义 URL 和 header，**请求体格式不可自定义**
- 只发送数据库页面的**属性**，不含页面正文；relation 只给 ID
- 需要 Notion 付费计划
- 请求失败（非 2xx）后，Notion 会**自动暂停该自动化**，需手动恢复 → 中转函数对业务层面的拒绝一律返回 200
- 实测 payload 见 `fixtures/notion-button-payload.json`：
  - `source.event_id`：每次点击唯一；`source.attempt`：重试计数（重试时 event_id 不变）→ 用 event_id 去重
  - `source.user_id`：点击者的 Notion 用户 ID → 用于白名单
  - `source.automation_id` / `source.action_id`：标识哪个按钮
  - `data.id` / `data.url` / `data.parent.data_source_id`：页面与数据库
  - `data.properties`：按每个属性的 `type` 取值（title→`title[0].plain_text`，select→`select.name`，status→`status.name`，number→`number`，multi_select→`multi_select[].name`，relation→`relation[].id`）
- 请求里没有签名，必须靠我们自己在 header 里放的密钥校验

### Claude Code Routine API 触发器
- 端点：`POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire`
- Header：`Authorization: Bearer sk-ant-oat01-...`（每个 routine 一个 token）、`anthropic-version: 2026-10-21`、`Content-Type: application/json`
- Body：`{"text": "..."}`，可选，最长 65,536 字符；未知字段被忽略
- 返回 200：`{ type: "routine_fire", claude_code_session_id, claude_code_session_url }`，创建会话后立即返回，不等执行完
- **无幂等键**：每次成功调用都新建会话 → 必须自己去重
- 限流：每 routine 30 次/小时（含 Run now），每账号 100 次 API 触发/小时；超限 429 + `Retry-After`
- token 只能在 claude.ai/code/routines 手动生成，只显示一次，重新生成会作废旧 token，**没有管理 API**
- 文档：https://platform.claude.com/docs/en/api/claude-code/routines-fire ，https://code.claude.com/docs/en/routines

## 3. 架构

```
Notion 按钮
  ├─ 动作1：把状态改为「排队中」（可选）
  └─ 动作2：Send webhook → https://<appwrite-function-domain>/?b=<button_id>
                            header: x-webhook-secret: <secret>
        ↓
Appwrite Function: notion-relay（Node）
  校验 → 去重 → 渲染模板 → 解密 token → POST /fire → 写 runs
        ↓
Claude Code Routine（按钮所有者自己的账号，云端运行）
  通过所有者的 Notion 连接器读取页面正文、写回结果

后台：Appwrite Sites（Next.js 或 React）+ Clerk 登录
  所有数据读写走 Appwrite Function（服务端校验 Clerk JWT 后用 API key 操作）
```

### 关键设计决定
1. **每个按钮一个专属地址**：后台「新建按钮」生成 `button_id` + 密钥，用户把 URL 和 header 填进 Notion。按钮归属 = 谁在后台创建了它。
2. **首次调用绑定 automation_id**：之后 automation_id 不一致的请求一律拒绝（防止 URL+密钥被复制到别的按钮）。
3. **routine 提示词通用、操作放在后台**：每个用户在 claude.ai 只建一个通用 routine，提示词类似「按 text 中的指令执行；页面 ID 和要求都在 text 里；结果用 Notion 连接器写回该页面」。后台的「操作」是提示词模板，中转函数用页面属性渲染后作为 `text` 发送。
4. **点击人白名单**：工作区是共享的，队友点击会消耗所有者的 Claude 额度，所以按钮要配置允许的 Notion user_id。

## 4. 数据模型（Appwrite TablesDB）

| 表 | 字段 | 说明 |
|---|---|---|
| `credentials` | owner（Clerk userId）、name、routine_fire_url、token_ciphertext、token_last4、last_used_at、status | 客户端**无任何权限**；token 只写不读，前端只显示掩码 |
| `actions` | owner、name、prompt_template、credential_id、enabled | 模板变量如 `{{知识点}}`、`{{小节}}`、`{{教材页码}}`、`{{page_url}}`、`{{page_id}}` |
| `buttons` | owner、name、secret_hash、automation_id（首次绑定）、action_id、allowed_notion_user_ids[]、enabled | 密钥只存哈希 |
| `runs` | **行 ID = event_id**（去重）、button_id、owner、page_id、page_url、clicker_notion_user_id、status、reject_reason、session_url、error、created_at | |

## 5. 中转函数 `notion-relay` 流程

1. 读 query `b` → 查 `buttons`；不存在或停用 → 记录并返回 200
2. 常量时间比较 `x-webhook-secret` 与 `secret_hash`；不符 → 返回 401（这是唯一可以返回非 200 的情况，用来暴露配置错误；待定：是否也改为 200）
3. automation_id：未绑定则绑定；已绑定且不一致 → 拒绝（200 + 记录）
4. `source.user_id` 不在白名单 → 拒绝（200 + 记录）
5. 以 `event_id` 为行 ID 创建 `runs`；冲突（已存在）→ 视为重试，直接返回 200
6. 加载 action → 用 `data.properties` 渲染模板 → 拼出 `text`（含 page_id、page_url）
7. 加载 credential → 解密 token → 调 `/fire`；429 时记录 `Retry-After`
8. 更新 `runs`：成功写 session_url，失败写 error
9. 函数执行权限设为任何人可调用；安全完全依赖第 2–4 步

## 6. 安全要求

- token 用 AES-256-GCM 应用层加密，密钥放函数环境变量 `TOKEN_ENC_KEY`
- 按钮密钥只存哈希（如 SHA-256 + 每按钮随机 salt），生成时只展示一次
- 后台所有 API 先用 `@clerk/backend` 校验 Clerk JWT，再按 owner 过滤
- 不在日志里打印 token、密钥或完整 header

## 7. 后台页面

1. 我的 Claude 凭证：添加 / 替换 / 测试（测试 = 发一次 ping，会消耗一次会话）
2. 操作模板：编辑 + 预览（用 fixture payload 渲染出最终 text）
3. 我的按钮：新建（生成 URL 和密钥）、选操作、管理白名单、启停、查看绑定状态
4. 运行记录：状态、会话链接、拒绝原因、错误

## 8. 实施顺序

1. 建 4 张表 + `notion-relay` 函数（先不接 Clerk，用一个固定 owner）
2. 用 `fixtures/notion-button-payload.json` 写单元测试：属性解析、模板渲染、去重、白名单
3. 在 Notion 配一个真实按钮，跑通「费马引理」这一页
4. 做后台 + 接 Clerk
5. 补齐运行记录与错误展示

## 9. 待定事项（先问我）

- 第一个按钮具体让 Claude 做什么（补全笔记正文 / 出例题 / 复习卡片并更新复习次数）
- Clerk 与 Appwrite 的对接方式：全部走函数（当前倾向）还是用 Appwrite 自定义 token 建立会话
- 后台前端框架
- 示例页面所在的笔记已公开发布在 aethedit.notion.site，写回的内容外人可见，确认是否可以

## 10. 背景

- 示例数据库：「高数（上）笔记」，属性包括 知识点（title）、章节、小节、类型、重要度、来源（select）、掌握程度（status）、复习次数、教材页码（number）、前置知识/后续知识（relation）、手写/截图（files）、考试范围（multi_select）、编号（unique_id，前缀 GS-NOTE）
- Notion 工作区 AethEdit 与队友共享
