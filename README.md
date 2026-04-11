# <p align="center">codex-register</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.3-111827">
  <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/klsf/codex-register?style=social">
</p>
用于批量注册 OpenAI 账号、授权Codex登录生成授权文件，可直接导入cliproxyapi使用，以及批量检查凭证剩余可用额度。

## 免责声明

本项目仅供学习、研究与接口行为测试使用。使用者应自行确保其用途符合目标平台的服务条款、当地法律法规以及所在网络环境的合规要求。

因使用本项目导致的账号风险、访问限制、数据丢失、封禁、法律责任或其他任何损失，均由使用者自行承担，项目作者与维护者不承担任何直接或间接责任。

## 开发说明

本项目95%以上代码都是由Codex编写，如果有BUG也可以直接让Codex修复就行了。

## 环境要求

- Node.js 18+
- 已安装项目依赖：`npm install`
- 本地可用代理，默认使用 `config.json` 里的 `defaultProxyUrl`

## 快速开始

安装依赖：

```bash
npm install
```

先复制 config.example.json 为 config.json。

使用前别忘了把 `config.json` 里的 `defaultProxyUrl` 改成你自己的代理地址。

当前版本已移除“邮箱邀请”和“团队清理”相关能力，`config.json` / `config.example.json` 中不再需要这类配置项。

```json
{
  "provider": "proxiedmail",
  "defaultProxyUrl": "http://127.0.0.1:10808",
  "defaultPassword": "kuaileshifu88",
  "loopDelayMs": 120000,
  "gmailAccessToken": "",
  "gmailEmailAddress": "",
  "2925EmailAddress": "",
  "2925Password": "",
  "cloudflareEmailDomain": "",
  "cloudflareApiBaseUrl": "",
  "cloudflareApiKey": ""
}
```

配置项说明：

- `provider`
    - 当前验证码邮箱提供方，可选：`proxiedmail`、`gmail`、`2925`、`cloudflare`
- `defaultProxyUrl`
    - 默认代理地址，主注册流程和额度检查都会使用
- `defaultPassword`
    - OpenAI 注册默认密码
- `loopDelayMs`
    - 自动循环模式下，每轮成功后的等待毫秒数
- `gmailAccessToken`
    - Gmail API access token
- `gmailEmailAddress`
    - Gmail 主邮箱地址，用于生成别名邮箱
- `2925EmailAddress`
    - 2925 邮箱登录账号
- `2925Password`
    - 2925 邮箱登录密码
- `cloudflareEmailDomain`
    - Cloudflare Email Routing 使用的邮箱域名，例如 `54782.xyz`
- `cloudflareApiBaseUrl`
    - Cloudflare 邮件 Worker 地址，例如 `https://mail-d1-api.xxx.workers.dev`
- `cloudflareApiKey`
    - Cloudflare 邮件 Worker 的 `x-api-key`

说明：

- `config.example.json` 会提交到仓库，作为配置示例
- 本地实际使用的是 `config.json`
- `config.json` 已加入 `.gitignore`，不会提交到仓库

### Provider 说明

项目支持 4 种验证码邮箱提供方：

- `proxiedmail`
    - 通过 ProxiedMail 动态创建代理邮箱收验证码
    - 适合自动化批量注册，无需任何其他配置

- `gmail`
    - 通过 Gmail API 读取验证码邮件
    - 需要在 `config.json` 中配置 `gmailAccessToken` 和 `gmailEmailAddress`
    - 会基于主 Gmail 地址自动生成别名邮箱

- `2925`
    - 通过 2925 邮箱账号登录后读取验证码邮件
    - 需要在 `config.json` 中配置 `2925EmailAddress` 和 `2925Password`
    - 每个2925账号好像最多创建20个子账号，超过20个后就收不到验证码了。

- `cloudflare`
    - 通过 Cloudflare Email Routing + Worker + D1 读取验证码邮件
    - 需要在 `config.json` 中配置 `cloudflareEmailDomain`、`cloudflareApiBaseUrl`、`cloudflareApiKey`
    - 程序会自动生成 `随机名@你的域名`，再调用 Cloudflare Worker 的 `/latest` 和 `/emails` 接口轮询验证码
    - Worker 部署教程见 [`MAIL_WORKER_DEPLOY.md`](/H:/go/codex-register/MAIL_WORKER_DEPLOY.md)

开发模式运行：

```bash
npm run dev
```

构建：

```bash
npm run build
```

构建后运行：

```bash
npm run start
```

## 命令说明

### 1. `npm run dev`

主入口，默认进入自动循环注册模式。

```bash
npm run dev -- [参数]
```

支持参数：

- `--email <邮箱>`
    - 指定邮箱后，只执行单轮。
    - 不带 `--auth` 时：执行注册 + 登录获取授权。
    - 带 `--auth` 时：只执行登录获取授权。
- `--otp`
    - 手动输入邮箱验证码；不带时会优先使用当前 provider 自动读取验证码。
- `--auth`
    - 仅登录模式，必须和 `--email` 一起使用。
- `--sign`
    - 直接走 `screen_hint=sign` 的注册并授权模式，不再拆成“先注册再登录授权”两段。
- `--st`
    - Sentinel 使用浏览器模式获取 token；不加时走本地计算逻辑。
- `--n <轮数>`
    - 仅自动模式有效，限制最多执行多少轮。

使用示例：

```bash
# 自动循环注册
npm run dev

# 自动模式只跑 1 轮
npm run dev -- --n 1

# 指定邮箱，自动读取验证码
npm run dev -- --email zxkl12345_test@2925.com

# 指定邮箱，手动输入验证码
npm run dev -- --email zxkl12345_test@2925.com --otp

# 指定邮箱，只做登录授权并自动读取验证码
npm run dev -- --email zxkl12345_test@2925.com --auth

# 指定邮箱，只做登录授权并手动输入验证码
npm run dev -- --email zxkl12345_test@2925.com --auth --otp

# 直接注册并授权（screen_hint=sign）
npm run dev -- --email zxkl12345_test@2925.com --sign

# 指定邮箱，并启用浏览器 Sentinel
npm run dev -- --email zxkl12345_test@2925.com --st
```

说明：

- 默认密码来自 `config.json` 的 `defaultPassword`
- 指定 `--email` 只表示使用这个邮箱，不再强制进入手动验证码模式
- 只有显式传 `--otp` 才会手动输入验证码
- `--sign` 只影响“注册 + 授权”流程，对 `--auth` 纯授权模式无效
- 自动模式下，成功后会等待 `config.json.loopDelayMs` 再进入下一轮

### 2. `npm run register:batch`

批量对一组邮箱执行“注册 + 登录获取 token”流程。

```bash
npm run register:batch -- [参数]
```

支持参数：

- `--emails <邮箱1,邮箱2,...>`
    - 直接传逗号分隔邮箱列表。
- `--file <文件路径>`
    - 从文本文件读取邮箱列表，每行一个。
- `--delay-ms <毫秒>`
    - 每个邮箱之间的等待时间，默认 `3000`。
- `--sign`
    - 批量模式也改为走 `screen_hint=sign` 的直接注册并授权流程。
- `--stop-on-error`
    - 遇到第一个失败邮箱后立即停止。

说明：

- `--emails` 优先级高于 `--file`
- 两者都不传时，会使用代码内置的一组默认邮箱
- 注册默认密码来自 `config.json` 的 `defaultPassword`

使用示例：

```bash
# 直接传邮箱列表
npm run register:batch -- --emails "a@2925.com,b@2925.com"

# 从文件读取
npm run register:batch -- --file .\emails.txt

# 设置间隔 5 秒
npm run register:batch -- --file .\emails.txt --delay-ms 5000

# 碰到错误立即停止
npm run register:batch -- --emails "a@2925.com,b@2925.com" --stop-on-error
```

### 3. `npm run check:quota`

批量检查 `auth` 根目录下授权 JSON 的套餐剩余额度。

```bash
npm run check:quota -- [参数]
```

支持参数：

- `--dir <目录>`
    - 指定授权文件目录，默认 `./auth`
    - 只检查该目录根下的 `.json` 文件，不递归子目录
- `--limit <数量>`
    - 只检查前 N 个文件
- `--proxy <代理地址>`
    - 指定请求代理；不传时默认使用 `config.json.defaultProxyUrl`
- `--verbose`
    - 额外输出每个请求的原始状态码和原始响应体
- `--table`
    - 最后额外输出表格汇总

当前检查逻辑：

- 请求接口：`https://chatgpt.com/backend-api/wham/usage`
- 使用返回中的 `used_percent` 计算剩余可用百分比
- 如果返回 `401`，会先尝试使用 `refresh_token` 刷新并回写原 auth 文件
- 只有错误信息里包含 `deactivated` 时，才会把对应 JSON 移动到 `auth/401/`
- 其他失败情况不会移动文件，只输出错误原因

输出格式：

```text
[✅️][free][100.00%]zxkl12345_theo_chill@2925.com-2026-04-16 04:01:02
[❌️]someone@2925.com-Encountered invalidated oauth token for user, failing request
剩余可用：56/124
```

使用示例：

```bash
# 检查 auth 目录
npm run check:quota

# 只检查前 20 个
npm run check:quota -- --limit 20

# 指定目录并输出原始响应
npm run check:quota -- --dir .\auth --verbose

# 指定代理并输出表格
npm run check:quota -- --proxy http://127.0.0.1:7890 --table
```

### 4. `npm run start`

运行构建后的主程序，相当于执行 `dist/index.js`。

```bash
npm run start -- [参数]
```

参数与 `npm run dev -- [参数]` 保持一致，支持：

- `--email <邮箱>`
- `--otp`
- `--auth`
- `--st`

示例：

```bash
npm run build
npm run start -- --email zxkl12345_test@2925.com --auth --otp
```

## 常见场景

切换验证码邮箱 provider：

```json
{
  "provider": "proxiedmail"
}
```

使用 Gmail 收验证码：

```json
{
  "provider": "gmail",
  "gmailAccessToken": "your_gmail_access_token",
  "gmailEmailAddress": "your_gmail@gmail.com"
}
```

使用 2925 收验证码：

```json
{
  "provider": "2925",
  "2925EmailAddress": "your_2925@2925.com",
  "2925Password": "your_2925_password"
}
```

使用 Cloudflare 邮箱收验证码：

```json
{
  "provider": "cloudflare",
  "cloudflareEmailDomain": "54782.xyz",
  "cloudflareApiBaseUrl": "https://mail-d1-api.xxx.workers.dev",
  "cloudflareApiKey": "your_api_key"
}
```

批量注册一批邮箱：

```bash
npm run register:batch -- --file .\emails.txt --delay-ms 3000
```

只给单个邮箱补授权文件（适用于已经注册成功，只是获取token）：

```bash
npm run dev -- --email your_mail@example.com --auth
```

给单个邮箱手动输入验证码：

```bash
npm run dev -- --email your_mail@example.com --otp
```

批量检查当前 `auth` 目录剩余额度：

```bash
npm run check:quota
```
