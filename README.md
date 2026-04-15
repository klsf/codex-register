# <p align="center">codex-register</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.4-111827">
  <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/klsf/codex-register?style=social">
</p>

用于批量注册 OpenAI 账号、生成授权文件，并批量检查 `auth` 目录里的额度。

---

## 免责声明

本项目仅供学习、研究与接口行为测试使用。使用者应自行确保其用途符合目标平台的服务条款、当地法律法规以及所在网络环境的合规要求。

因使用本项目导致的账号风险、访问限制、数据丢失、封禁、法律责任或其他任何损失，均由使用者自行承担，项目作者与维护者不承担任何直接或间接责任。

## 环境要求

- Node.js 18+
- 先安装依赖：`npm install`
- 需要准备 `config.json`
- 需要可用代理，默认读取 `config.json.defaultProxyUrl`

## 先做这 3 步

### 1）安装依赖

```bash
npm install
```

### 2）准备配置文件

把 `config.example.json` 复制为 `config.json`，至少改这几项：

```json
{
  "provider": "proxiedmail",
  "defaultProxyUrl": "http://127.0.0.1:10808",
  "defaultPassword": "kuaileshifu88",
  "loopDelayMs": 120000
}
```

---

## 最常用命令

### 开发模式运行

直接跑源码：

```bash
npm run dev
```

只跑 1 轮：

```bash
npm run dev -- --n 1
```

### 构建

```bash
npm run build
```

### 运行构建后的主程序

```bash
npm run start
```

### 检查授权额度

```bash
npm run check
```

---

## 主程序：`npm run dev` / `npm run start`

这两个命令参数是一样的：

```bash
npm run dev -- [参数]
npm run start -- [参数]
```

### 常用参数

- `--n <次数>`
    - 自动模式最多跑多少轮
- `--email <邮箱>`
    - 指定单个邮箱执行, 配合 `--otp` 使用
- `--auth`
    - 只登录并生成授权文件，必须配合 `--email`
- `--otp`
    - 手动输入邮箱验证码
- `--sign`
    - 直接注册并授权
- `--st`
    - Sentinel 使用浏览器模式

### 常用示例

#### 自动模式只跑 1 次

```bash
npm run dev -- --n 1
```

#### 指定邮箱，注册并授权

```bash
npm run dev -- --email your_mail@example.com
```

#### 指定邮箱，只做登录授权

```bash
npm run dev -- --email your_mail@example.com --auth
```

#### 指定邮箱，手动输入验证码

```bash
npm run dev -- --email your_mail@example.com --otp
```

#### 直接注册并授权

```bash
npm run dev -- --email your_mail@example.com --sign
```

---

## 状态及剩余额度检查：`npm run check`

批量检查 `auth` 目录里的授权文件额度。

```bash
npm run check -- [参数]
```

### 参数

- `--dir <目录>`
    - 指定 auth 目录，默认 `./auth`
- `--limit <数量>`
    - 只检查前 N 个文件
- `--proxy <代理地址>`
    - 指定代理，不传就用 `config.json.defaultProxyUrl`
- `--refresh`
    - 检查前先尝试刷新 token
- `--verbose`
    - 输出原始状态码和原始响应体
- `--table`
    - 最后输出表格
- `--concurrency <数量>` 或 `-c <数量>`
    - 并发检查数量

### 示例

```bash
npm run check
npm run check -- --limit 20
npm run check -- --concurrency 8
npm run check -- --limit 50 -c 10
npm run check -- --refresh --table
npm run check -- --proxy http://127.0.0.1:7890 --table
```

### 输出说明

单个账号输出示例：

```text
[✅️][free][100.00%]someone@example.com-2026-04-21 15:33:10
[❌️]someone@example.com-Encountered invalidated oauth token for user, failing request
```

汇总输出示例：

```text
总数 10 | 可用 8 | 限额 1 | 移除 1 | 可用额度 6.42
```

含义：

- `总数`：检查的账号总数
- `可用`：请求成功的账号数
- `限额`：剩余额度为 `0%` 的账号数
- `移除`：被移动到 `auth/401/` 的账号数
- `可用额度`：所有可用账号剩余额度之和，按小数累计

---

## provider 配置说明

`config.json` 里的 `provider` 可选：

- `proxiedmail`
- `gmail`
- `2925`
- `cloudflare`

### 1）proxiedmail

~~最省事，适合自动化。~~[已不可用]

```json
{
  "provider": "proxiedmail"
}
```

### 2）gmail

需要配置 Gmail API token 和主邮箱：

```json
{
  "provider": "gmail",
  "gmailAccessToken": "your_gmail_access_token",
  "gmailEmailAddress": "your_gmail@gmail.com"
}
```

临时 token 获取教程见：[GMAIL_OAUTH_PLAYGROUND.md](./GMAIL_OAUTH_PLAYGROUND.md)

### 3）2925

```json
{
  "provider": "2925",
  "2925EmailAddress": "your_2925@2925.com",
  "2925Password": "your_2925_password"
}
```

### 4）cloudflare

```json
{
  "provider": "cloudflare",
  "cloudflareEmailDomain": "54782.xyz",
  "cloudflareApiBaseUrl": "https://mail-d1-api.xxx.workers.dev",
  "cloudflareApiKey": "your_api_key"
}
```

适合自有域名的邮箱注册。
Cloudflare Worker 部署说明见：[MAIL_WORKER_DEPLOY.md](./MAIL_WORKER_DEPLOY.md)

---

## 配置项说明

- `provider`
    - 验证码邮箱提供方
- `defaultProxyUrl`
    - 默认代理地址
- `defaultPassword`
    - 注册默认密码
- `loopDelayMs`
    - 自动模式每轮间隔时间，单位毫秒
- `gmailAccessToken`
    - Gmail API access token
- `gmailEmailAddress`
    - Gmail 主邮箱地址
- `2925EmailAddress`
    - 2925 邮箱账号
- `2925Password`
    - 2925 邮箱密码
- `cloudflareEmailDomain`
    - Cloudflare Email Routing 的域名
- `cloudflareApiBaseUrl`
    - Cloudflare 邮件 Worker 地址
- `cloudflareApiKey`
    - Cloudflare 邮件 Worker 的 `x-api-key`
