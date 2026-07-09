# codex-register

用于自动注册 OpenAI 账号、读取邮箱验证码、生成 Codex OAuth 授权文件，也支持批量处理指定邮箱列表。

## 免责声明

本项目仅供学习、研究与接口行为测试使用。使用者应自行确保其用途符合目标平台的服务条款、当地法律法规以及所在网络环境的合规要求。

因使用本项目导致的账号风险、访问限制、数据丢失、封禁、法律责任或其他任何损失，均由使用者自行承担，项目作者与维护者不承担任何直接或间接责任。

## 环境要求

- Node.js 20.18+
- 可用代理，默认读取 `config.json.defaultProxyUrl`
- 一个可用邮箱 provider：`cloudflare`、`gmail`、`hotmail` 或 `mailnest`

## 快速开始

安装依赖：

```bash
npm install
```

复制并修改配置：

```bash
copy config.example.json config.json
```

最小配置示例：

```json
{
  "provider": "cloudflare",
  "defaultProxyUrl": "http://127.0.0.1:10808",
  "defaultPassword": "kuaileshifu88",
  "loopDelayMs": 30000,
  "cloudflareEmailDomain": "example.com",
  "cloudflareApiBaseUrl": "https://mail-api.example.workers.dev",
  "cloudflareApiKey": "your_api_key"
}
```

开发模式运行：

```bash
npm run dev
```

构建并运行：

```bash
npm run build
npm run start
```

## 运行命令

主程序：

```bash
npm run dev
npm run dev -- --n 1
npm run dev:sign
npm run dev:at
npm run dev:mode1
```

构建后运行：

```bash
npm run start
npm run start -- --n 1
npm run start:sign
npm run start:at
npm run start:mode1
```

参数说明：

- `--n <次数>`：自动模式最多跑多少轮。
- `--sign`：直接注册并授权。
- `--at`：只注册 ChatGPT 并保存 ChatGPT `accessToken` 到 `auth/at/`。
- `--mode 1`：注册流程在进入基础资料页前停止。
- `--st`：使用浏览器模式获取 Sentinel token，需要本机 Edge/Chrome 或设置 `SENTINEL_BROWSER_PATH`。

npm 11 会把 `npm run dev -- --sign`、`npm run dev -- --mode 1` 这类未知参数当作 npm config 并输出 warning。程序兼容这种传参，但推荐使用 `npm run dev:sign`、`npm run start:sign`、`npm run dev:at`、`npm run start:at`、`npm run dev:mode1`、`npm run start:mode1`。

## 批量注册

批量入口只处理你提供的邮箱列表：

```bash
npm run batch -- --emails a@example.com,b@example.com
npm run batch -- --file emails.txt
```

参数说明：

- `--emails <邮箱列表>`：逗号分隔的邮箱列表。
- `--file <文件>`：每行一个邮箱。
- `--delay-ms <毫秒>`：每个邮箱之间的等待时间，默认 `3000`。
- `--stop-on-error`：任一邮箱失败时停止。
- `--sign`：直接注册并授权。

## 配置项

通用配置：

- `provider`：邮箱 provider，只支持 `cloudflare`、`gmail`、`hotmail`。
- `defaultProxyUrl`：默认代理地址。
- `defaultPassword`：注册默认密码。
- `loopDelayMs`：自动模式每轮间隔时间，单位毫秒。

Gmail：

- `gmailAccessToken`：Gmail API access token。
- `gmailEmailAddress`：Gmail 主邮箱地址，程序会生成 plus alias。

Cloudflare：

- `cloudflareEmailDomain`：Cloudflare Email Routing 域名。
- `cloudflareApiBaseUrl`：邮件 Worker 地址。
- `cloudflareApiKey`：邮件 Worker 的 `x-api-key`。

MailNest：

- `mailNestApiKey`：Outlook 邮箱提供商迈巢的`api-key`，获取页面：https://mailnest.top/account。
- `mailNestProjectCode`：迈巢提供临时与独占两种 Outlook 邮箱。填写该值，即项目代码，则使用对应项目的临时邮箱，不填则使用独占邮箱。项目代码获取页面：https://mailnest.top/buy-email。Codex 的项目代码默认为`chatgpt001`，可直接使用。

CLIProxyAPI 自动上传：

- `cliproxyApiAutoUploadAuth`：授权成功后是否自动上传 auth 文件。
- `cliproxyApiBaseUrl`：CLIProxyAPI 管理地址。
- `cliproxyApiManagementKey`：CLIProxyAPI 的 `MANAGEMENT_KEY`。

## Provider

### Cloudflare

适合自有域名和长期自动注册。

```json
{
  "provider": "cloudflare",
  "cloudflareEmailDomain": "example.com",
  "cloudflareApiBaseUrl": "https://mail-api.example.workers.dev",
  "cloudflareApiKey": "your_api_key"
}
```

部署说明见 [MAIL_WORKER_DEPLOY.md](./MAIL_WORKER_DEPLOY.md)。

### Gmail

```json
{
  "provider": "gmail",
  "gmailAccessToken": "your_gmail_access_token",
  "gmailEmailAddress": "your_gmail@gmail.com"
}
```

临时 token 获取教程见 [GMAIL_OAUTH_PLAYGROUND.md](./GMAIL_OAUTH_PLAYGROUND.md)。

### Hotmail

```json
{
  "provider": "hotmail"
}
```

账号放在 `hotmail/tokens.txt`，格式：

```text
邮箱----密码----client_id----refresh_token
```

程序会随机取一个账号生成别名邮箱，刷新 token，并读取收件箱和垃圾箱里的验证码邮件。刷新后的 `refresh_token` 会回写到 `tokens.txt`。

### MailNest

Outlook 邮箱提供商迈巢，提供临时与独占两种 Outlook 邮箱，配置便捷，开箱即用。

```json
{
  "provider": "mailnest",
  "mailNestApiKey": "",
  "mailNestProjectCode": "chatgpt001"
}
```

字段含义已在**配置项**章节中阐述。

## 授权文件

Codex OAuth 授权文件会保存到 `auth/`，文件名格式为：

```text
日期-邮箱.json
```

生成的 auth JSON 包含：

```json
{
  "type": "codex",
  "priority": 10,
  "websockets": true
}
```

如果启用 CLIProxyAPI 自动上传，auth 文件仍会先保存到本地 `auth/`，上传失败只输出警告，不中断主流程。

## 相关文档

- [MAIL_WORKER_DEPLOY.md](./MAIL_WORKER_DEPLOY.md)：Cloudflare 邮件 Worker 部署。
- [GMAIL_OAUTH_PLAYGROUND.md](./GMAIL_OAUTH_PLAYGROUND.md)：Gmail 临时 access token 获取。
