# 自建邮箱 Worker 手动部署教程

## 前置条件

你需要准备好：

- 一个 Cloudflare 账号
- 一个已接入 Cloudflare 的域名
- 一个 D1 数据库

## 第一步：创建 D1 数据库

进 Cloudflare 后台：

1. 打开 `Storage & Databases`
2. 找到 `D1`
3. 新建一个数据库

名字随便起，建议：

```text
mail-db
```

## 第二步：初始化表结构

进入这个 D1 数据库，打开控制台或查询页面，执行下面这段 SQL：

```sql
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox_received_at
ON emails (mailbox, received_at DESC, id DESC);
```

这里的设计就是：

- 一封邮件 = 一行
- `raw_text` 优先存解析后的正文文本
- 如果正文解析失败，就退回存原始 MIME 文本
- 按 `mailbox + received_at` 查最新邮件

## 第三步：创建 Worker

进入 Cloudflare 后台：

1. 打开 `Workers & Pages`
2. 点 `Create`
3. 点 `从 Hello World! 开始`
4. Worker 名字建议填：

```text
mail-d1-api
```

## 第四步：粘贴单文件代码

创建完成后，进入 Worker 的代码编辑页。

把默认 Hello World 代码全部删掉，再把 [`MAIL_WORKER_UPLOAD.js`](MAIL_WORKER_UPLOAD.js) 的全部内容粘进去。

这份文件是纯 JS 单文件，不需要构建。

## 第五步：绑定 D1

在 Worker 设置里添加 D1 binding：

- Variable name: `DB`
- Database: 选择你刚创建的 D1 数据库

变量名必须是 `DB`，因为脚本里就是按这个名字读的。

## 第六步：配置 API_KEY

在 Worker 设置里添加一个 Secret：

- Name: `API_KEY`
- Value: 你自己定义的一串 key

这个 key 用于接口鉴权。

## 第七步：保存并部署

在 Cloudflare 编辑器里点保存并部署。

部署成功后会得到一个 Worker 地址，例如：

```text
https://mail-d1-api.xxx.workers.dev
```

## 第八步：绑定 Email Routing

去 Cloudflare 控制台配置 Email Routing，把你的域名邮件转到这个 Worker。

建议：

- 直接用 catch-all

这样程序生成任意随机前缀邮箱时，都能收到邮件。

## 第九步：测试接口

假设：

- Worker 地址：`https://mail-d1-api.xxx.workers.dev`
- API key：`your_api_key`
- 测试邮箱：`admin@example.com`

查询某个邮箱的最新邮件：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/latest?to=admin@example.com"
```

查询某个邮箱的邮件列表：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails?to=admin@example.com"
```

查询某一封邮件：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails/1"
```

删除某一封邮件：

```bash
curl -X DELETE -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails/1"
```

## 返回格式

`GET /latest?to=xxx@example.com` 返回类似：

```json
{
  "id": 1,
  "mailbox": "xxx@example.com",
  "from_email": "noreply@example.com",
  "subject": "Your verification code",
  "message_id": "<abc@example.com>",
  "raw_text": "Your verification code is 123456",
  "received_at": 1770000000000
}
```

`GET /emails?to=xxx@example.com` 返回类似：

```json
{
  "mailbox": "xxx@example.com",
  "emails": [
    {
      "id": 1,
      "mailbox": "xxx@example.com",
      "from_email": "noreply@example.com",
      "subject": "Your verification code",
      "message_id": "<abc@example.com>",
      "raw_text": "Your verification code is 123456",
      "received_at": 1770000000000
    }
  ],
  "limit": 20,
  "offset": 0
}
```

## 接入当前项目

项目侧仍然在 [`config.json`](/H:/go/codex-register/config.json) 保持：

```json
{
  "provider": "cloudflare",
  "cloudflareEmailDomain": "your-domain.com",
  "cloudflareApiBaseUrl": "https://mail-d1-api.xxx.workers.dev",
  "cloudflareApiKey": "your_api_key"
}
```

程序会生成：

```text
随机前缀@your-domain.com
```

然后去你这个 Worker 的接口里轮询该邮箱的最新邮件。

## 常见问题

### 1. 一封邮件真的只写一行吗

是。

当前表结构就是每封邮件插入 `emails` 表中的 1 行，没有拆附件表、头信息表、索引表。

### 2. 邮件原文会不会太大

验证码邮件一般都很小，通常没问题。

如果后面你想再省空间，可以把 `raw_text` 改成只保留正文摘要，或者只提取验证码后存结构化字段。

### 3. 现在验证码只在正文里也能存吗

可以。

当前脚本会先尝试从原始 MIME 邮件里解析 `text/plain` 或 `text/html` 正文，再写入 `raw_text`。

如果解析失败，至少也会把原始 MIME 文本写进去，不会像之前那样直接是空字符串。
