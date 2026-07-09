# 外部发信 API

新增 `POST /api/public/sendEmail`，用于让外部系统通过内部密钥调用 Cloud Mail 发信。

## 鉴权

请求头 `Authorization` 支持两种值：

- `jwt_secret`：部署环境中的稳定内部密钥，推荐给服务端系统长期使用。
- public token：管理员通过 `POST /api/public/genToken` 生成的现有 public token。

## 请求

```bash
curl -X POST https://your-domain.com/api/public/sendEmail \
  -H "Authorization: <jwt_secret 或 public token>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@example.com",
    "fromName": "Cloud Mail",
    "to": ["user@example.net"],
    "subject": "Hello",
    "html": "<p>Hello from Cloud Mail</p>",
    "text": "Hello from Cloud Mail"
  }'
```

字段说明：

- `from`：必填，域名必须在环境变量 `domain` 中配置。
- `fromName`：可选，默认取 `from` 的邮箱名前缀。
- `to`：必填，支持字符串数组或逗号分隔字符串。
- `subject`：必填。
- `text` / `html`：至少填写一个。
- `attachments`：可选，最多 10 个，格式为 `{ "filename": "a.txt", "content": "base64...", "type": "text/plain" }`，需要 R2 配置可用。

## 发送与落库

- 收件人全部为站内邮箱时，直接复用站内投递逻辑写入收件箱。
- 存在站外收件人时，优先使用 Cloudflare `send_email` binding；未配置时使用发件域名对应的 Resend token。
- 发送记录写入 `email` 表，`type=SEND`，可在系统已发送/全部邮件中查看。
- 如果 `from` 已存在账号，记录归属该账号；否则归属管理员用户，`accountId` 为 `0`。

## 注意事项

- `from` 只允许使用系统已配置域名下的地址，真实投递仍受 Cloudflare/Resend 域名验证约束。
- Cloudflare `send_email` 对目标地址可能有平台限制；需要向任意外部地址投递时建议配置 Resend。
- 该接口复用现有发送开关，系统关闭发信后会返回 403。
