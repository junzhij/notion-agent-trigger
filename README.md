# notion-agent-trigger

点击 Notion 数据库里的按钮 → 后台校验、去重、渲染提示词 → 记录为一次运行（run）。
设计见 [HANDOFF.md](HANDOFF.md)。

被接受的点击会先以 `queued` 写入 `runs`（行 ID = event_id，Notion 重试不会重复触发），
然后用按钮所有者的 Claude 凭证调用定时任务的 **API 触发器**：成功 → `dispatched` 并记录 `session_url`；
失败（含 429 限流）→ `failed` 并记录 `error`。没有可用凭证或未设置 `TOKEN_ENC_KEY` 时保持 `queued`。

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
5. **未绑定 = 配置测试**：绑定 `automation_id`、保存 payload 作为按钮的参数样本、白名单为空时加入发送者、
   按钮没有操作时按参数生成默认提示词（page_id + 各参数 + 处理 @claude 评论），记为 `test`，**不触发 Claude**。
   已绑定但不一致 → 拒绝；一致时若属性列表有变化则更新样本
6. 点击者 `source.user_id` 不在白名单 → 拒绝（白名单为空 = 所有人都被拒绝）
7. 加载操作，用页面属性渲染提示词，并在前面加上固定的页面信息头（标题、page_id、page_url）
8. 以 `event_id` 为行 ID 创建 run（`queued` 或 `rejected`），冲突视为重试
9. 选凭证（操作指定的 `credential_id`，否则所有者最新的已启用凭证）→ 解密 token → `POST /fire`
   → 更新 run 为 `dispatched`（带 `session_url`）或 `failed`（带 `error`）

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
| POST | `/preview` | 渲染模板：传 `button_id` 用该按钮测试时收到的 payload，否则用示例 payload（或传入的 `payload`） |
| GET/POST | `/buttons` | 列出 / 新建按钮（新建时返回一次性 `secret`） |
| GET | `/buttons/:id` | 单个按钮，含 `setup_state`（`waiting_for_test` / `ready`）和 `parameters`（名称、类型、测试时的值） |
| PATCH/DELETE | `/buttons/:id` | 改名称、操作、白名单、启停 / 删除 |
| POST | `/buttons/:id/rotate-secret` | 重新生成密钥（返回一次性 `secret`） |
| POST | `/buttons/:id/unbind` | 解除绑定（「重新测试」：下一次请求重新视为配置测试） |
| GET/POST | `/credentials` | 列出 / 新建 Claude 凭证（`name`、`routine_fire_url`、`token`；token 只写不读） |
| PATCH/DELETE | `/credentials/:id` | 修改（`token` 可选，填了就替换）/ 删除（有操作在用时返回 409） |
| POST | `/credentials/:id/test` | 真实触发一次定时任务做连通性测试，返回 `session_url` |
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
| 两个都要 | `TOKEN_ENC_KEY` | 32 字节随机密钥（base64 或 hex），用于 AES-256-GCM 加密 token。两个函数必须一致；更换后已存的 token 需要重新填写。生成：`openssl rand -base64 32` |
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

### 4. Claude 定时任务（API 触发）

1. claude.ai → Scheduled → New task，Trigger 选 **API**，Repository 选 None，云环境要开启 Notion 连接器
2. Instructions 写成通用提示词：按收到的 text 执行；text 开头的 page_id / page_url 是目标页面；结果用 Notion 连接器写回该页
3. 保存后复制触发地址和 token（只显示一次），到后台「Claude 凭证」添加，点「测试」确认
4. 调用格式（`functions/src/lib/routine.js`）：`Authorization: Bearer <token>`、`anthropic-version: 2023-06-01`、
   `anthropic-beta: experimental-cc-routine-2026-04-01`，body `{"text": "..."}`。两个版本头可用环境变量
   `ROUTINE_ANTHROPIC_VERSION` / `ROUTINE_ANTHROPIC_BETA` 覆盖

### 5. Notion

1. 后台「我的按钮」→ 新建按钮，复制 URL、请求头名称和值（值只显示一次）
2. Notion 数据库按钮 → 添加动作「Send webhook」→ 填入 URL 和请求头
3. 在 Notion 里点一次按钮作为测试：自动绑定、读取参数、把你加入白名单、生成默认提示词（不触发 Claude）
4. 后台会自动刷新出参数表和提示词编辑器，改好后保存；之后的点击就会发给 Claude

## 当前线上部署（Appwrite 项目 6a4c8b530018b2bc88be，新加坡）

| 组件 | 地址 |
|---|---|
| notion-relay | https://notion-relay-6a4c8b53.sgp.appwrite.run/ |
| admin-api | https://admin-api-6a4c8b53.sgp.appwrite.run/ |
| 后台站点 | https://notion-admin-6a4c8b53.appwrite.network/ |
| Clerk 应用 | notion-agent-trigger（development 实例） |

代码直接从 GitHub 分支 tarball 部署（`https://codeload.github.com/junzhij/notion-agent-trigger/tar.gz/claude/dazzling-edison-p5wxbl`），
解压后的根目录是 `notion-agent-trigger-claude-dazzling-edison-p5wxbl/`，所以函数入口和站点构建命令都带这个前缀。
推送新提交后，用同一个 URL 重新创建 deployment 即可。分支合并或改名后要同步改入口路径。

两个函数都设置了 `TOKEN_ENC_KEY`（secret 变量）；`credentials` 表里的 token 用它加密，更换后需要重新填写 token。

admin-api 用 `CLERK_JWT_KEY`（Clerk 实例的公钥，来自 JWKS）离线校验 token，不需要 Clerk secret key。

## 待做

- 失败 / 排队中的 run 手动重试
- 第一个按钮的具体操作内容
