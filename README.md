# notion-agent-trigger

点击 Notion 数据库里的按钮 → 后台校验、去重、渲染提示词 → 记录为一次运行（run）。
设计见 [HANDOFF.md](HANDOFF.md)。

> **当前范围：只做到「Notion → 后台」这一段。** AI 执行部分（凭证存储、调用 Claude routine / Codex）
> 要等合规确认后再做。现在被接受的点击会以 `queued` 状态写入 `runs`，渲染好的提示词保存在
> `rendered_text`，之后的执行器可以直接从这里取任务。

## 目录

```
appwrite.config.json   Appwrite 项目配置：notion_agent 数据库的 3 张表 + 2 个函数
functions/             两个 Appwrite Function 共用一个 Node 包（部署时都上传这个目录）
  src/lib/             属性解析、模板渲染、密钥哈希、TablesDB 存储层
  src/relay/           notion-relay：接收 Notion webhook
  src/admin/           admin-api：后台 API（Clerk JWT 鉴权）
  fixtures/            实测的 Notion webhook payload
  test/                单元测试（node --test）
web/                   后台前端：React + Vite + Clerk，部署到 Appwrite Sites
```

## notion-relay 流程

1. 用 query `?b=<button_id>` 找到按钮；不存在 → 200 + 日志
2. 常量时间比较 `x-webhook-secret` 与按钮的 `secret_hash`（SHA-256，每个按钮一个随机 salt）；
   不符 → **401**（可用环境变量 `BAD_SECRET_STATUS=200` 改成 200）
3. 以 `event_id` 检查是否为重试 → 重复则直接返回 200
4. 按钮停用 → 拒绝
5. 未绑定 `automation_id` 则绑定；已绑定但不一致 → 拒绝
6. 点击者 `source.user_id` 不在白名单 → 拒绝（白名单为空 = 所有人都被拒绝）
7. 加载操作，用页面属性渲染提示词
8. 以 `event_id` 为行 ID 创建 run（`queued` 或 `rejected`），冲突视为重试

除密钥错误外，所有业务拒绝都返回 200 并记录，避免 Notion 自动暂停该自动化。
意外的后端错误也返回 200（只记日志），代价是这次点击会丢失。

### 模板变量

- 页面的任意属性名：`{{知识点}}`、`{{小节}}`、`{{教材页码}}`、`{{手写/截图}}`……
  多值属性（multi_select、relation 等）用 `, ` 连接
- 内置：`{{page_id}}` `{{page_url}}` `{{public_url}}` `{{page_title}}` `{{database_id}}`
  `{{data_source_id}}` `{{clicker_id}}` `{{event_id}}` `{{properties}}`（所有非空属性，每行「名称: 值」）
- 未知变量替换为空，并记录在 run 的 `missing_variables` 中

## admin-api 路由

所有请求都要带 `Authorization: Bearer <Clerk session token>`，数据按 Clerk `userId`（`owner`）隔离。
路径可带或不带 `/api` 前缀。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | 当前用户 |
| GET/POST | `/actions` | 列出 / 新建操作 |
| PATCH/DELETE | `/actions/:id` | 修改 / 删除（有按钮在用时返回 409） |
| POST | `/preview` | 用示例 payload（或传入的 `payload`）渲染模板 |
| GET/POST | `/buttons` | 列出 / 新建按钮（新建时返回一次性 `secret`） |
| PATCH/DELETE | `/buttons/:id` | 改名称、操作、白名单、启停 / 删除 |
| POST | `/buttons/:id/rotate-secret` | 重新生成密钥（返回一次性 `secret`） |
| POST | `/buttons/:id/unbind` | 解除 automation 绑定 |
| GET | `/runs?button_id=&status=&limit=&cursor=` | 运行记录（新的在前，游标分页） |
| GET | `/runs/:id` | 单条运行记录 |

## 本地测试

```bash
cd functions && npm install && npm test
```

## 部署

### 1. Clerk

在 Clerk 新建应用，记下 Publishable key 和 Secret key（或 JWT public key）。

### 2. Appwrite 表和函数

```bash
npm install -g appwrite-cli
appwrite login
appwrite push tables
appwrite push functions
```

在 Appwrite 控制台给函数设置环境变量：

| 函数 | 变量 | 值 |
|---|---|---|
| 两个都要 | `DATABASE_ID` | `notion_agent`（默认值，可不设） |
| notion-relay | `BAD_SECRET_STATUS` | 可选，默认 `401` |
| admin-api | `CLERK_SECRET_KEY` 或 `CLERK_JWT_KEY` | Clerk 密钥（二选一，JWT key 可免网络校验） |
| admin-api | `ALLOWED_ORIGINS` | 后台站点的 origin，逗号分隔，如 `https://admin.example.appwrite.network,http://localhost:5173`；同时用作 CORS 白名单和 Clerk `authorizedParties` |
| admin-api | `RELAY_URL` | notion-relay 函数的域名，如 `https://notion-relay.example.appwrite.run/` |

两个函数的执行权限都是 `any`；表没有任何客户端权限，只有函数的动态 API key（scope `rows.read`、`rows.write`）能读写。

### 3. 后台站点（Appwrite Sites）

在 Appwrite Sites 里从仓库创建站点：根目录 `web`，框架 Vite/React，构建命令 `npm run build`，
输出目录 `dist`；设置环境变量 `VITE_CLERK_PUBLISHABLE_KEY` 和 `VITE_ADMIN_API_URL`（admin-api 函数域名）。
在 Clerk 里把站点域名加到允许的来源。

本地开发：

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

### 4. Notion

1. 后台「我的按钮」→ 新建按钮，复制 URL、请求头名称和值（值只显示一次）
2. Notion 数据库按钮 → 添加动作「Send webhook」→ 填入 URL 和请求头
3. 点一次按钮：第一次会因为白名单为空被拒绝。到「运行记录」里点「加入白名单」，再点一次即可变成「排队中」

## 当前线上部署（Appwrite 项目 6a4c8b530018b2bc88be，新加坡）

| 组件 | 地址 |
|---|---|
| notion-relay | https://notion-relay-6a4c8b53.sgp.appwrite.run/ |
| admin-api | https://admin-api-6a4c8b53.sgp.appwrite.run/ |
| 后台站点 | https://notion-admin-6a4c8b53.appwrite.network/ |
| Clerk 应用 | notion-agent-trigger（development 实例） |

代码直接从 GitHub 分支 tarball 部署（`https://codeload.github.com/junzhij/notion-agent-trigger/tar.gz/claude/codex-credentials-az2o8i`），
解压后的根目录是 `notion-agent-trigger-claude-codex-credentials-az2o8i/`，所以函数入口和站点构建命令都带这个前缀。
推送新提交后，用同一个 URL 重新创建 deployment 即可。分支合并或改名后要同步改入口路径。

admin-api 用 `CLERK_JWT_KEY`（Clerk 实例的公钥，来自 JWKS）离线校验 token，不需要 Clerk secret key。

## 待做

- AI 执行（合规确认后）：凭证表、执行器（从 `queued` 的 runs 取任务）、结果写回、`session_url`
- 第一个按钮的具体操作内容
