# 账号登录与后台

本次增加真实的服务端账号体系。原根目录 HTML 仍是原来的 GitHub Pages 公开路书；`npm run build` 会另外生成 `.worker-assets/`，由 Worker 检查登录状态后提供页面。只运行 GitHub Pages 不会启用这些后端功能。

## 已实现

- 账号密码登录、退出、修改自己的密码；管理员创建、停用和启用成员。
- 不开放公开注册；新成员可阅读攻略、修改自己的密码和保存自己的准备清单。
- 出发准备包含 16 个日期分组、86 项事项，来自“制定新疆自驾准备清单”的时间顺序版本；按账号保存完成状态、版本和更新时间。刷新或同一账号重新登录会读取数据库记录。
- 页面只在服务端确认后改变勾选；断网或保存结果不确定时暂停该项并重新同步。多页面同时修改同一项时返回冲突和最新状态，不覆盖另一页刚保存的记录。
- 密码存储为带随机盐的 scrypt 哈希；会话用随机令牌，数据库只存令牌摘要。
- 会话最长七天，Cookie 使用 HttpOnly / Secure / SameSite=Strict；改密码会撤销该账号的全部会话，停用成员立即撤销其会话。
- 所有写操作检查 Origin、JSON 格式和同源请求标识；账号/IP 限流、参数校验、预编译 SQL。
- `GUIDE_ACCESS=private` 时，包括 `.html`、`.md`、账户页和其他下载在内的资源均经过后端认证。`GUIDE_ACCESS=public` 可让攻略公开，后台与用户接口仍受保护。

用户指定的初始管理员已在本机开发数据库中创建。**线上数据库需要单独初始化**，初始密码不在源码、示例配置或迁移 SQL 中。

## 本地运行

需要 Node.js 22.13 或更新版本。

```sh
npm ci
npm run db:local
npm run seed:local -- --username Sunrry
npm run dev
```

初始化命令通过终端隐藏输入密码；同名账号已存在时会失败，不重置原密码。已有开发库升级本版时先运行 `npm run db:local`，再运行 `npm run dev`，不需要重新创建账号。

打开 `http://127.0.0.1:8787/login`。本地数据库保存在已被 Git 忽略的 `.wrangler/` 目录；只有 development 环境的 HTTP 回环地址允许非 Secure 开发 Cookie。

## Cloudflare 部署

源码和发布记录继续放在现有 Git 仓库。Cloudflare 托管登录版网页、Worker 和 D1，浏览器同源访问，避免跨站 Cookie 问题。

1. 在本机执行 `npx wrangler login`，登录你自己的 Cloudflare 账号。
2. 执行 `npx wrangler d1 create xinjiang-roadtrip-auth`，把返回的 `database_id` 写到 `wrangler.jsonc` 中，替换全零占位 ID。
3. 确定攻略访问范围：`GUIDE_ACCESS=private` 或 `public`；线上保持 `ENVIRONMENT=production`。
4. 执行 `npm run db:remote`，然后执行 `npm run seed:remote -- --username Sunrry`，隐藏输入初始密码。
5. 执行 `npm test`、`npm run deploy`。没有配置真实数据库 ID 时，部署脚本会主动停止。
6. 在返回的 HTTPS 地址验证：未登录无法读取私密页面；登录后可以看路书、进入账户；退出后再次读取被拒绝。
7. 新站验证通过后，再将原 GitHub Pages 入口替换为新站跳转，或者关闭旧 Pages。未确定新地址前不要撤掉可用的旧站。

密码哈希是有意设置的较重计算。Cloudflare Workers 免费版每次请求 CPU 上限为 10ms，本实现不能承诺在免费额度内稳定登录；应使用足够 CPU 额度的方案，或根据已有服务器调整部署。代码不会自动购买或升级套餐。[Cloudflare CPU 限制](https://developers.cloudflare.com/workers/platform/limits/)

**公开历史的范围：**现有 GitHub Pages 与公开 Git 历史已经包含原攻略、酒店名称和入住日期。新站增加登录不会撤回这些已公开内容。若需要全站私密，还需在新站上线后处理旧 Pages 和仓库可见性；任何新密码、会话、数据库都不会进入该公开仓库。

## 后续更新攻略

继续按原有流程更新根目录三个 HTML 和文字攻略，再运行 `npm run build` / `npm run deploy`；构建会注入“我的账户”入口，并移除旧 Pages 跳转和 canonical，保留原路线、地图、预算和图片。账户源文件位于 `account-ui/`，后端位于 `backend/`。

## 验证与数据

`npm test` 使用 Node 内置 SQLite 执行真实 SQL，验证认证、权限、会话撤销、请求限制、保护路径，以及清单保存、账号隔离、并发冲突和失效会话拒绝写入。测试仅使用独立临时数据库和测试凭据；不读取或修改你的账号。`.worker-assets/` 使用资源白名单，数据库、环境变量、后端源码与测试数据不会作为 Worker 静态资源发布。

准备事项正文保存在 `data/preparation-checklist.json`，每个事项的稳定 ID 用于关联进度；修订文字时保留原 ID，新增或实质改变任务时分配新 ID。构建会将当前目录内容嵌入登录版页面。实际勾选保存在 `checklist_items` 表，主键为 `(user_id, item_id)`，不上传 Git。API 为 `GET /api/checklist` 和 `PATCH /api/checklist/:id`；更新提交 `{completed, version}`，冲突返回 HTTP 409 和服务端当前状态。未登录或无后端的静态版只展示清单，不能保存；不使用旧浏览器本地勾选推断真实完成情况。

Cloudflare 中每日清理到期会话和限流记录，不清理准备清单。D1 备份与恢复使用平台功能；不要把真实数据库导出提交 Git。当前版本支持账号与准备清单，尚未接入相册、照片上传或攻略在线编辑。

技术依据：[Worker 优先处理静态资源](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) · [D1 数据库命令](https://developers.cloudflare.com/d1/wrangler-commands/) · [Workers 原生密码学支持](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
