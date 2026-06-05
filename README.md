# 品牌电商平台价格监督

这是一个品牌方低价监控 MVP，用于录入品牌、商品名、规格和最低允许价，并持续巡检淘宝、京东、拼多多、抖音等平台页面。一旦识别到低价，会保存证据并通过飞书或钉钉机器人预警。

## 本地运行

1. 复制配置：

   ```bash
   cp .env.example .env
   ```

2. 按需填写 `.env` 里的提醒渠道、机器人 webhook、签名 secret 和 @ 对象。

3. 启动：

   ```bash
   npm start
   ```

4. 打开 `http://127.0.0.1:5173`。

## Vercel 部署

1. 将本仓库导入 Vercel。
2. 在 Vercel Storage 创建一个 **Private Blob**，并连接到项目。
3. 在 Vercel Project Settings 添加环境变量：

   ```text
   FEISHU_WEBHOOK=
   FEISHU_SECRET=
   FEISHU_AT_USER_IDS=
   FEISHU_AT_ALL=false
   DINGTALK_WEBHOOK=
   DINGTALK_SECRET=
   DINGTALK_AT_MOBILES=
   DINGTALK_AT_ALL=false
   CRON_SECRET=请填写一段随机字符串
   BLOB_READ_WRITE_TOKEN=由 Vercel Blob 自动注入或手动复制
   ```

4. Vercel Cron 已配置在 `vercel.json`，路径是 `/api/scan`，Hobby 版本为每天一次。

注意：Vercel Hobby 的 Cron 只能每天一次；要每分钟巡检，需要 Vercel Pro，并将 `vercel.json` 里的 `schedule` 改回 `* * * * *`。

未配置 Vercel Blob 时，线上数据会暂存在 Serverless 的临时目录中，冷启动或重新部署后可能丢失。要持久保存任务、事件和证据，请连接 Private Blob 并配置 `BLOB_READ_WRITE_TOKEN`。

## 当前初始商品

- 品牌：斯利安
- 商品名：活性叶酸
- 规格：30 粒
- 最低允许价格：79 元
- 平台：淘宝/天猫、京东、拼多多、抖音电商
- 状态：不指定链接，按全平台搜索巡检

## 当前能力

- 添加、启停、删除商品监控任务。
- 商品监控以「品牌 + 商品名 + 规格」为核心信息。
- 支持淘宝、京东、拼多多、抖音多选和全选平台。
- 商品链接为可选项；不填链接时按所选平台搜索巡检，填写链接时只巡检该单一商品页。
- 定时巡检平台搜索页或指定商品链接，识别常见 HTML / JSON-LD / meta 中的价格。
- 按“识别价格 < 最低允许价”生成低价事件。
- 本地保存 HTML 证据；Vercel 部署后保存到 Private Blob。
- 支持用户自行选择飞书或钉钉提醒。
- 飞书支持 webhook、签名、@ 指定用户或 @ 所有人。
- 钉钉支持 webhook、加签、@ 指定手机号或 @ 所有人。

## 重要说明

电商平台页面常有登录、风控、动态渲染和反爬限制。生产环境建议优先接入品牌授权数据源、店铺后台导出、平台开放接口或合规第三方数据服务；页面巡检适合作为辅助证据采集链路。
