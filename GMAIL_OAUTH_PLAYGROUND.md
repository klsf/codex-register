# Gmail 通过 OAuth 2.0 Playground 获取临时 Token 教程

这份教程用于给本项目的 `gmail` provider 获取可用的 Gmail API `access token`。

适用场景：

- 你想让程序自动从 Gmail 里读取验证码
- 你暂时只想快速拿一个可用 token
- 你不想自己写 OAuth 回调代码

---

## 一、先说明一下

本项目里 Gmail 读取邮件用的是：

- `gmailAccessToken`
- `gmailEmailAddress`

其中：

- `gmailEmailAddress`：你的 Gmail 主邮箱
- `gmailAccessToken`：访问 Gmail API 的 token

你把拿到的 token 填进 `config.json` 即可。

---

## 二、官方页面

- OAuth Playground: [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
- Gmail API scopes: [https://developers.google.com/workspace/gmail/api/auth/scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

官方文档里说明了：

- OAuth Playground 可以交互式走 OAuth 流程
- Playground 默认可以拿到短期 access token
- 如果不用你自己的 OAuth 凭据，Playground 自动签发的 refresh token 通常会在 **24 小时内被自动撤销**

---

## 三、最简单获取临时 token 的方法

### 第 1 步：打开 OAuth Playground

打开：

[https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)

---

### 第 2 步：在左侧选择 Gmail API scope

在 Step 1 里选择 Gmail API 权限。

```text
Gmail API v1 > https://mail.google.com/
```
---

### 第 3 步：点击 `Authorize APIs`

点击：

```text
Authorize APIs
```

然后：

- 选择你的 Google 账号
- 同意授权

---

### 第 4 步：交换 token

授权完成后，页面会进入 Step 2。

点击：

```text
Exchange authorization code for tokens
```

然后你会看到：

- `Access token`
- `Refresh token`

---

## 四、把 token 填进项目

把 `config.json` 改成这样：

```json
{
  "provider": "gmail",
  "gmailAccessToken": "这里填 Access token",
  "gmailEmailAddress": "你的 Gmail 邮箱"
}
```

示例：

```json
{
  "provider": "gmail",
  "defaultProxyUrl": "http://127.0.0.1:10808",
  "defaultPassword": "kuaileshifu88",
  "loopDelayMs": 120000,
  "gmailAccessToken": "ya29.a0AfH6SMA......",
  "gmailEmailAddress": "yourname@gmail.com"
}
```

---

## 五、这个 token 是“临时”的是什么意思

OAuth Playground 官方页面说明：

- 默认拿到的是短期 `access token`
- Playground 的 `refresh token` 通常会在 **24 小时内自动撤销**

所以这种方式适合：

- 临时测试
- 快速调试
- 先跑通 Gmail provider

不太适合：

- 长期稳定挂机
- 服务器长期运行

---

## 参考来源

- Google OAuth 2.0 Playground: [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
- Google Gmail API scopes: [https://developers.google.com/workspace/gmail/api/auth/scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
