# CFNode

用 Cloudflare Workers + R2 存放脚本和文档的极简仓库：浏览器里在线编辑，条目有公开下载链接，保存时自动留历史版本。

## 功能

- **单 Worker 同时提供 API 和页面**：Workers Static Assets 托管前端，同源 `/api` 提供读写接口。
- **R2 单存储**：一切按对象存，`docs/<slug>` 正文，`revs/<slug>/<时间戳>-<随机>` 历史快照。
- **多级分组**：条目的 `group` 支持 `ops/deploy/prod` 这样的路径（最多 4 级），侧栏按分支折叠展示，可一键重命名整棵子树。
- **多标签 + 组合筛选**：每个条目最多 8 个标签；侧栏标签条可多选，多个标签按「同时满足」交集过滤，标签或分组都参与搜索。
- **公开下载链接**：`GET /d/<slug>` 直接返回文件（`attachment`，带正确扩展名与 MIME），不需要令牌；加 `?inline=1` 改为内联预览；响应头 `X-Cfnode-Group` / `X-Cfnode-Tags` 暴露分组与标签。
- **自定义分享链接**：每个条目可额外生成多条 `/s/<自定义路径>` 别名，可自定义另存文件名，可选设置密码（密码拼在链接里，如 `/s/team-deploy?p=密码`），可随时删除；不影响原有的 `/d/<slug>`。
- **在线编辑**：CodeMirror 6，支持 Markdown / JavaScript / TypeScript / JSON / YAML / Shell / Python / PowerShell 高亮；Markdown 提供编辑 / 分栏 / 预览三种视图。
- **历史版本**：每次保存自动快照上一版，可在抽屉里查看、下载单个版本、一键恢复；恢复前会先把当前内容也存成快照，最多保留 20 个版本。
- **乐观并发控制**：基于 R2 etag，多标签页同时改同一条目不会被静默覆盖。
- **Bearer 令牌保护**：所有 `/api/*` 需要 `Authorization: Bearer <ADMIN_TOKEN>`，比较使用常量时间实现。

## 本地开发

```bash
npm install
```

把 `.dev.vars.example` 复制成 `.dev.vars`（已在 `.gitignore` 中），写入自己的令牌：

```
ADMIN_TOKEN=dev-token-change-me
```

开两个终端：

```bash
npx wrangler dev --port 8787   # Worker + 本地 R2 模拟
npm run dev                    # Vite，:5173，代理 /api /d /v 到 8787
```

打开 http://localhost:5173/ ，输入令牌解锁。本地 R2 数据落在 `.wrangler/`。

类型检查和构建：

```bash
npm run typecheck
npm run build
```

## 部署

```bash
# 1) 创建 R2 桶（名字要和 wrangler.jsonc 里一致，或自行改配置）
npx wrangler r2 bucket create cfnode-store

# 2) 写入生产令牌（不要提交到仓库）
npx wrangler secret put ADMIN_TOKEN

# 3) 构建前端并部署
npm run deploy
```

部署后 `https://<worker>.<account>.workers.dev/` 是编辑器，`https://<worker>.<account>.workers.dev/d/<slug>` 是可以直接分享的下载链接。

可选：在 Cloudflare 仪表盘给 Worker 绑定自定义域名，下载链接会跟着换成自己的域名。

## 数据布局

| Key | 内容 |
|---|---|
| `docs/<slug>` | 正文；`customMetadata` 存 `title`、`kind`(doc/script)、`lang`、`group`、`tags`(JSON 数组字符串)、`createdAt`、`updatedAt` |
| `revs/<slug>/<ts>-<rand>` | 历史快照；`customMetadata` 存 `savedAt`、`title`、`lang`、`size` |
| `shares/<path>` | 分享链接记录（JSON）：`slug`、`filename`、`passwordHash`、`passwordSalt`、`createdAt` |

`lang` 决定下载时的扩展名（`markdown → .md`、`shell → .sh`、`python → .py` …）；slug 自带扩展名时以 slug 为准。

slug 允许中英文、数字和 `._-`，但拒绝路径分隔符、控制字符与 `..`，因此不会越出 `docs/` 前缀。

分组路径允许中英文、数字和 `._-`，用 `/` 分隔且最多 4 级；`a//b/` 会自动收敛成 `a/b`。分组只是元数据，所以重命名分组是一次子树批量重写：正文、`etag`、`updatedAt` 都不变，只改 `group`。

分享链接独立存放在 `shares/` 前缀下，路径只有单段，因此不可能遮蔽文档、历史版本或 API 路由；`api`、`d`、`v`、`s`、`assets` 等保留字会被拒绝。密码只存 `SHA-256(salt:password)`，明文只在创建时返回给创建者，并由该浏览器记在 `localStorage` 里用于重建完整链接。

## API

所有 `/api/*` 都需要 `Authorization: Bearer <ADMIN_TOKEN>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 校验令牌 |
| GET | `/api/items` | 列表，按更新时间倒序，最多 5000 条，超出时返回 `truncated: true` |
| GET | `/api/items/:slug` | 读取正文与元信息 |
| PUT | `/api/items/:slug` | 保存；覆盖已存在条目必须带 `etag`，冲突返回 409 |
| DELETE | `/api/items/:slug` | 删除条目及其全部历史版本 |
| GET | `/api/items/:slug/revisions` | 历史版本列表 |
| GET | `/api/items/:slug/revisions/:key` | 读取某个版本正文 |
| POST | `/api/items/:slug/revisions/:key/restore` | 恢复到某个版本 |
| POST | `/api/groups/rename` | 重命名分组，`{ "from": "ops/deploy", "to": "infra/deploy" }`，`to` 为空表示移到未分组 |
| GET | `/api/shares[?slug=]` | 列出分享链接（可选按条目过滤），不返回密码 |
| POST | `/api/shares` | 创建分享链接，`{ "slug", "path", "filename", "password" }`；返回一次明文 `password` |
| DELETE | `/api/shares/:path` | 删除分享链接 |
| GET | `/d/:slug` | 公开下载（无需令牌） |
| GET | `/v/:slug/:key` | 下载指定历史版本（无需令牌） |
| GET | `/s/:path[?p=密码]` | 通过分享链接下载（无需令牌；有密码时需 `?p=` 或 `X-Cfnode-Password` 头） |

保存请求体（`group` / `tags` 省略时保留原值，传空值表示清空）：

```json
{
  "content": "# 标题\n正文",
  "title": "标题",
  "kind": "doc",
  "lang": "markdown",
  "group": "ops/deploy",
  "tags": ["生产", "bash"],
  "etag": "可选，覆盖已有条目时必填"
}
```

## 限制

- 单条正文上限 2 MiB（`MAX_BODY`）。
- 每条最多保留 20 个历史版本（`MAX_REVISIONS`）。
- 每个条目最多 8 个标签、单个标签最多 24 个字符；分组最多 4 级、每级最多 32 个字符。
- 分享路径单段最长 64 字符，只能含文字、数字和 `._-`；密码 4–64 字符。
- 分享链接的密码是「知道链接即可用」的弱保护：链接里自带 `?p=`，转发即等于转发密码。需要真正的访问控制请改用 Cloudflare Access。
- 一次分组重命名最多处理 500 个条目，超出会提示拆分操作。
- 令牌是单一共享口令，没有多用户与权限分级；需要多人协作时请在前面加 Cloudflare Access。
