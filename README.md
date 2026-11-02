# B站评论区大肥鱼反代

近期，B 站赛博鱼灾盛行，对此，本项目通过 B 站视频评论收发消息，提供聊天界面和兼容 Chat Completions 的本地 API

## 功能

- UID 名单管理，支持备注、启用暂停和批量导入
- 按 UID 查询 Aicu 公开视频评论，支持手动添加入口
- 单轮与多轮对话，记录查询评论、目标回复和任务状态
- `GET /v1/models` 与 `POST /v1/chat/completions`
- 请求去重、发送间隔、每日上限、超时和重启恢复
- 手动或延迟清理已收到回复的查询评论，保留本地对话

## 启动

需要 Node.js 24 或更新版本，进入项目目录后执行

```sh
npm ci
npm run build
npm start
```

打开 [本地页面](http://127.0.0.1:4173)，Windows 也可双击 `启动鱼塘.cmd`

开发模式使用 `npm run dev`，页面地址为 `http://127.0.0.1:5173`

## 使用

1. 在「设置」粘贴已登录 B 站账号的 Cookie，需包含 `SESSDATA` 和 `bili_jct`
2. 点击「验证并连接」，开启「允许发送评论」并保存
3. 在「UID 名单」添加目标账号，查询公开索引或手动添加视频评论入口
4. 在「对话」选择账号和评论入口，发送消息并等待该 UID 回复
5. 在「评论记录」查看回执和原文回复，按需清理查询评论

消息会公开发布到所选评论区，适合自己的账号或愿意参与的评论线程

浏览器登录与后端连接相互独立，当前版本使用已有 Cookie，不提供短信登录

## API 接入

| 配置 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:4173/v1` |
| API Key | 从「API 接入」页面复制 |
| Model | `fish-auto` 或 `fish-UID` |
| 请求超时 | 建议 300 秒 |
| SDK 自动重试 | 关闭，重试时沿用同一 `Idempotency-Key` |

```sh
curl http://127.0.0.1:4173/v1/chat/completions \
  -H "Authorization: Bearer YOUR_FISH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  -d '{"model":"fish-auto","messages":[{"role":"user","content":"test"}],"stream":false}'
```

`fish-auto` 使用名单中的可用账号，`fish-UID` 指定账号，也可通过 `fish_uid` 和 `anchor_id` 指定目标和入口

`stream: true` 保持 SSE 连接，收到评论回复后整段返回，响应中的 `usage` 为 `null`

仅支持文本，`temperature` 与 `max_tokens` 无法控制对方模型，不支持图片、工具调用或结构化输出

## 数据与行为

- 首次运行自动创建 `data/` 和本机 API Key，不预置账号、评论或聊天记录
- Cookie 和 API Key 保存在 `data/credentials.json`，其余记录保存在 `data/fish.sqlite`
- 导出记录不包含 Cookie 和 API Key，`data/` 已加入 Git 忽略
- 默认发送间隔 60 秒，每日上限 20 条，按北京时间计数
- 同一 UID 同时只处理一条消息，对话上下文超过 900 字会拒绝发送
- 回复需匹配目标 UID、查询评论 ID、发送时间和可见状态
- 已发布的评论不会自动重发，回执不确定或发送中断时保留记录供核对
- 清理仅针对本工具发出且已收到匹配回复的查询评论，清理前核对发送账号
- 服务仅监听 `127.0.0.1`，默认关闭评论发送

## 当前范围

仅支持 B 站视频评论，公开索引可能延迟或缺失，可使用手动入口

对方是否启用自动回复、评论是否通过审核和最终可见性由平台及目标账号决定

本项目提供评论消息中转，为娱乐项目，请与互动方协商后使用

## 检查

```sh
npm run check
npm run build
npm test
```

自动测试覆盖回复匹配、长整数 ID、请求去重、发送限额、清理、重启恢复、数据迁移和 HTTP 接口

## 目录

```text
server/       本地接口、数据存储、任务队列与平台适配
shared/       前后端共享类型
src/          React 界面
public/       前端静态文件
tests/        自动测试
```
