# TextLibrary

用 Cloudflare Workers + R2 存放脚本和文档的极简仓库：浏览器里在线编辑，条目有公开下载链接，保存时自动留历史版本。

## 功能

- **单 Worker 同时提供 API 和页面**：Workers Static Assets 托管前端，同源 `/api` 提供读写接口。
- **R2 单存储**：一切按对象存，`docs/<slug>` 正文，`revs/<slug>/<时间戳>-<随机>` 历史快照。
- **多级分组**：条目的 `group` 支持 `ops/deploy/prod` 这样的路径（最多 4 级），侧栏按分支折叠展示，可一键重命名整棵子树。
- **多标签 + 组合筛选**：每个条目最多 8 个标签；侧栏标签条可多选，多个标签按「同时满足」交集过滤，标签或分组都参与搜索。
- **公开下载链接**：`GET /d/<slug>` 直接返回文件（`attachment`，带正确扩展名与 MIME），不需要令牌；加 `?inline=1` 改为内联预览；响应头 `X-Textlibrary-Group` / `X-Textlibrary-Tags` 暴露分组与标签。
- **自定义分享链接**：每个条目可额外生成多条 `/s/<自定义路径>` 别名，可自定义另存文件名，可选设置密码（密码拼在链接里，如 `/s/team-deploy?p=密码`），可随时删除；不影响原有的 `/d/<slug>`。
- **在线编辑**：CodeMirror 6，支持 Markdown / JavaScript / TypeScript / JSON / YAML / Shell / Python / PowerShell 高亮，带缩进参考线（含当前块高亮）；Markdown 提供编辑 / 分栏 / 预览三种视图。
- **历史版本**：每次保存自动快照上一版，可在抽屉里查看、下载单个版本、一键恢复；恢复前会先把当前内容也存成快照，默认保留最近 20 个版本（`MAX_REVISIONS` 可调）。
- **乐观并发控制**：基于 R2 etag，多标签页同时改同一条目不会被静默覆盖。
- **Bearer 令牌保护**：所有 `/api/*` 需要 `Authorization: Bearer <ADMIN_TOKEN>`，比较使用常量时间实现。

## 本地开发

```bash
npm install
```

把 `.dev.vars.example` 复制成 `.dev.vars`（已在 `.gitignore` 中），写入自己的令牌：

```
ADMIN_TOKEN=password
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
npx wrangler r2 bucket create textlibrary-store

# 2) 写入生产令牌（不要提交到仓库）
npx wrangler secret put ADMIN_TOKEN

# 3) 构建前端并部署
npm run deploy
```

四个限额变量都是可选的，不设置就用默认值（正文 10 MiB、20 个历史版本、列表 5000 条、分组重命名 500 条）。需要调整时在部署前设置，例如：

```bash
npx wrangler secret put MAX_BODY        # 例如填 20MiB
npx wrangler secret put MAX_REVISIONS   # 例如填 50
```

部署后 `https://<worker>.<account>.workers.dev/` 是编辑器，`https://<worker>.<account>.workers.dev/d/<slug>` 是可以直接分享的下载链接。

可选：在 Cloudflare 仪表盘给 Worker 绑定自定义域名，下载链接会跟着换成自己的域名。

## 配置项

部署前需要确认的配置分五类：Worker 绑定与运行时变量、`wrangler.jsonc` 配置、代码内规则、本地开发参数、浏览器端存储键。`ADMIN_TOKEN` 和四个限额变量都可以通过命令行或仪表盘覆盖；代码内规则改完需要重新构建部署。

### 1. Worker 绑定与运行时变量

代码在 `src/worker.ts` 的 `Env` 类型里声明了三个绑定，其中 `ADMIN_TOKEN` 必填，四个限额都是可选覆盖项：

```ts
type Env = {
  BUCKET: R2Bucket;             // R2 存储
  ASSETS: Fetcher;              // 静态资源
  ADMIN_TOKEN: string;          // 管理令牌
  MAX_BODY?: string;            // 单条正文上限，默认 10MiB
  MAX_REVISIONS?: string;       // 历史版本保留数，默认 20
  LIST_PAGE_LIMIT?: string;     // 列表最多返回条数，默认 5000
  GROUP_MOVE_LIMIT?: string;    // 单次分组重命名上限，默认 500
};
```

| 名称 | 配置位置 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `ADMIN_TOKEN` | 生产：`npx wrangler secret put ADMIN_TOKEN`<br>本地：`.dev.vars` | 是 | — | 所有 `/api/*` 的 `Authorization: Bearer <token>`。未配置时接口返回 500；建议 32 位以上随机串，不要提交进仓库 |
| `MAX_BODY` | `vars` / secret / `.dev.vars` | 否 | `10MiB` | 单条正文上限。支持纯字节数（`10485760`）或带单位（`10MiB`、`512KB`），单位大小写不敏感；`KB/MB/GB` 按 1000 进制，`KiB/MiB/GiB` 按 1024 进制 |
| `MAX_REVISIONS` | `vars` / secret / `.dev.vars` | 否 | `20` | 每个条目保留的历史版本数，超出后删除最旧的 |
| `LIST_PAGE_LIMIT` | `vars` / secret / `.dev.vars` | 否 | `5000` | `/api/items` 最多返回的条目数，超出时返回 `truncated: true` 与当前 `limit` |
| `GROUP_MOVE_LIMIT` | `vars` / secret / `.dev.vars` | 否 | `500` | 单次分组重命名最多处理的条目数 |
| `BUCKET` | `wrangler.jsonc` → `r2_buckets[0].binding` | 是 | `BUCKET` | R2 绑定名，代码里固定引用 `env.BUCKET`，改名必须同步改 `Env` |
| `bucket_name` | `wrangler.jsonc` → `r2_buckets[0].bucket_name` | 是 | `textlibrary-store` | 实际 R2 桶名，必须和 `wrangler r2 bucket create` 创建的一致；换桶等于换一套数据 |
| `ASSETS` | `wrangler.jsonc` → `assets.binding` | 是 | `ASSETS` | 静态资源绑定名，代码里固定引用 `env.ASSETS` |

四个限额变量全部可选：不配置、留空、或填入无法解析的值（例如 `MAX_BODY=garbage`、`MAX_REVISIONS=0`）时都会静默回退到上表默认值，因此已有部署不新增配置也能正常升级。

设置方式任选其一：

```bash
# 方式一：wrangler.jsonc 里写 vars（明文，适合非敏感值）
# "vars": { "MAX_BODY": "20MiB", "MAX_REVISIONS": "30" }

# 方式二：命令行设置 secret（值不出现在仓库里）
npx wrangler secret put MAX_BODY

# 方式三：Cloudflare 仪表盘 → Worker → Settings → Variables
```

改动后需要重新部署才能生效：`npm run deploy`。本地开发写在 `.dev.vars` 里，修改后要重启 `wrangler dev`（不会热加载）。

### 2. `wrangler.jsonc` 其他可调字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `name` | `textlibrary` | Worker 名称，直接决定 `https://<name>.<account>.workers.dev` 地址 |
| `main` | `src/worker.ts` | Worker 入口，改了要同步 `tsconfig.worker.json` |
| `compatibility_date` | `2026-11-01` | Workers 运行时兼容日期；升级前先在预览环境验证 R2/静态资源行为 |
| `assets.directory` | `./dist/client` | 前端产物目录，必须与 `vite.config.ts` 的 `build.outDir` 保持一致 |
| `assets.not_found_handling` | `single-page-application` | 未命中静态文件时回落 SPA，保证前端路由可用 |
| `assets.run_worker_first` | `/api/*`、`/d/*`、`/v/*`、`/s/*` | 这些前缀先交给 Worker；新增公开路由前缀时务必加到这里，否则会被静态资源拦截 |
| `observability.enabled` | `true` | 开启 Workers Logs，排查线上 401/409 时很有用 |

### 3. 代码内规则

这些是写死在源码里的校验规则，不是环境变量，调整后需要重新 `npm run build && wrangler deploy`。带共用的校验规则放在 `src/shared/`，前端和 Worker 会同时生效。

| 规则 | 位置 | 默认值 | 作用 |
|---|---|---|---|
| slug 长度 / 字符规则 | `isValidSlug`（`src/worker.ts`） | ≤64 字符 | 允许中英文、数字和 `._-`，拒绝路径分隔符、控制字符和 `..` |
| `REV_KEY_RE` | `src/worker.ts` | ≤96 字符 | 历史版本 key 的格式校验 |
| `CONTENT_TYPES` / `LANG_EXT` | `src/worker.ts` | markdown/js/ts/json/sh/py/ps1/yaml/txt | 下载时的 MIME 与扩展名映射；新增语言要两边都加 |
| 下载缓存 | `downloadResponse`（`src/worker.ts`） | `max-age=60` | `/d`、`/v`、`/s` 响应的 `cache-control` |
| 保留分享路径 | `POST /api/shares`（`src/worker.ts`） | `api`、`d`、`v`、`s`、`assets`、`index`、`favicon` | 不能用作分享路径，新增顶层路由时要补进这个集合 |
| `MAX_GROUP_LENGTH` | `src/shared/taxonomy.ts` | 96 | 分组路径总长度 |
| `MAX_GROUP_DEPTH` | `src/shared/taxonomy.ts` | 4 | 分组最大层级 |
| `MAX_GROUP_SEGMENT` | `src/shared/taxonomy.ts` | 32 | 每级分组名长度 |
| `MAX_TAGS` / `MAX_TAG_LENGTH` | `src/shared/taxonomy.ts` | 8 / 24 | 每条的标签数量与单标签长度 |
| `MAX_SHARE_PATH` | `src/shared/share.ts` | 64 | 分享路径长度（单段，不能含 `/`） |
| `MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH` | `src/shared/share.ts` | 4 / 64 | 分享链接密码长度 |
| `MAX_FILENAME` | `src/shared/share.ts` | 120 | 分享链接「另存为」文件名长度 |
| `DOC_LANGS` / `SCRIPT_LANGS` | `src/client/main.ts` | markdown/text/json/yaml；javascript/typescript/shell/python/powershell/text | 编辑器语言下拉选项，需与 `CONTENT_TYPES` 对应 |

### 4. 本地开发参数

只在开发时生效，不参与部署：

| 参数 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| Worker 端口 | `npx wrangler dev --port` | `8787` | 本地 R2 模拟所在端口 |
| 前端端口 | `vite.config.ts` → `server.port` | `5173` | 开发页面地址 |
| 代理目标 | `vite.config.ts` → `server.proxy` | `http://127.0.0.1:8787` | `/api`、`/d`、`/v`、`/s` 转发到 Worker；改了 Worker 端口要同步这里 |
| 代理前缀 | `vite.config.ts` → `server.proxy` | `^/api(/|$)`、`^/d/`、`^/v/`、`^/s/` | 新增公开路由时同步补一条 |

### 5. 浏览器端存储键

前端只用 `localStorage` 保存本机状态，部署时无需配置，用户换浏览器即可重置：

| 键 | 内容 | 写入位置 |
|---|---|---|
| `textlibrary.token` | 管理令牌，随请求头发送 | `src/client/api.ts` |
| `textlibrary.theme` | 主题偏好（`light` / `dark` / `system`） | `src/client/theme.ts` |
| `textlibrary.mdViewMode` | Markdown 视图（`edit` / `preview` / `split`） | `src/client/main.ts` |
| `textlibrary.sharepw.<path>` | 本机创建过的分享链接密码，用于重建完整链接 | `src/client/share-dialog.ts` |

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
| GET | `/api/items` | 列表，按更新时间倒序，最多 `LIST_PAGE_LIMIT` 条（默认 5000），超出时返回 `truncated: true` 和当前 `limit` |
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
| GET | `/s/:path[?p=密码]` | 通过分享链接下载（无需令牌；有密码时需 `?p=` 或 `X-Textlibrary-Password` 头） |

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

- 单条正文上限默认 10 MiB，可用 `MAX_BODY` 覆盖。
- 每条默认保留 20 个历史版本，可用 `MAX_REVISIONS` 覆盖。
- 每个条目最多 8 个标签、单个标签最多 24 个字符；分组最多 4 级、每级最多 32 个字符。
- 分享路径单段最长 64 字符，只能含文字、数字和 `._-`；密码 4–64 字符。
- 分享链接的密码是「知道链接即可用」的弱保护：链接里自带 `?p=`，转发即等于转发密码。需要真正的访问控制请改用 Cloudflare Access。
- 一次分组重命名默认最多处理 500 个条目，可用 `GROUP_MOVE_LIMIT` 覆盖，超出会提示拆分操作。
- 令牌是单一共享口令，没有多用户与权限分级；需要多人协作时请在前面加 Cloudflare Access。
