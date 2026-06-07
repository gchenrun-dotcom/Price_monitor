# 品牌电商平台价格监督

这是一个品牌方低价监控 MVP，用于录入品牌、商品名、规格和最低允许价，并通过 Just One API 巡检淘宝/天猫、京东、抖音等平台价格。一旦识别到低价，会保存证据并通过飞书或钉钉机器人预警。

## 本地运行

1. 复制配置：

   ```bash
   cp .env.example .env
   ```

2. 按需填写 `.env` 里的 Just One API Token、提醒渠道、机器人 webhook、签名 secret 和 @ 对象。

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
   PRICE_COLLECTOR=justone
   JUST_ONE_BASE_URL=https://api.justoneapi.com
   JUST_ONE_TOKEN=从 Just One 后台获取
   SCREENSHOT_ENABLED=true
   SCREENSHOT_API_URL_TEMPLATE=https://api.screenshotone.com/take?access_key={token}&url={url}&format=png&full_page=true&viewport_width=1440&viewport_height=1200&delay=5
   SCREENSHOT_API_TOKEN=ScreenshotOne access key
   SCREENSHOT_COOKIE_MODE=screenshotone
   SCREENSHOT_COOKIES_TAOBAO=淘宝登录 Cookie
   SCREENSHOT_COOKIES_JD=京东登录 Cookie
   SCREENSHOT_COOKIES_PDD=拼多多登录 Cookie
   SCREENSHOT_COOKIES_DOUYIN=抖音登录 Cookie
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
- 平台：淘宝/天猫、京东、抖音电商；拼多多需补充可用接口后启用
- 状态：不指定链接，按全平台搜索巡检

## 当前能力

- 添加、启停、删除商品监控任务。
- 商品监控以「品牌 + 商品名 + 规格」为核心信息。
- 支持淘宝、京东、拼多多、抖音多选和全选平台。
- 商品链接为可选项；不填链接时按所选平台搜索巡检，填写链接时只巡检该单一商品页。
- 默认通过 Just One API 调用淘宝/天猫、京东、抖音商品搜索接口，并尝试从指定链接解析商品 ID 后调用详情接口。
- 拼多多在 Just One 官方接口未配置前会返回明确错误，不使用页面抓取冒充真实数据。
- 页面抓取保留为手动兜底采集方式，适合作为辅助证据，不建议作为生产价格源。
- 每次巡检会保存本次最低价命中商品的历史价格记录。
- 价格记录包含页面价、平台券、红包、国家补贴、估算总优惠、实际到手价、商品链接、JSON 证据和网页价格截图。
- 网页价格截图通过外部截图 API 生成，模板支持 `{url}`、`{token}` 和 `{cookie}` 占位符；支持直接返回图片，也支持 JsonLink 这类返回 JSON 图片地址的接口；截图失败时价格记录仍会保存。
- 如果使用 ScreenshotOne，可设置 `SCREENSHOT_COOKIE_MODE=screenshotone`，并通过 `SCREENSHOT_COOKIES_TAOBAO`、`SCREENSHOT_COOKIES_JD` 等环境变量给对应平台截图请求注入登录 Cookie。
- 如果第三方价格接口没有返回明确商品详情链接，系统不会截图平台搜索页，避免把淘宝/京东登录弹窗、骨架屏误当作价格证据。
- 按“识别价格 < 最低允许价”生成低价事件。
- 本地保存 Just One 原始 JSON 或页面 HTML 证据；Vercel 部署后保存到 Private Blob。
- 支持用户自行选择飞书或钉钉提醒。
- 飞书支持 webhook、签名、@ 指定用户或 @ 所有人。
- 钉钉支持 webhook、加签、@ 指定手机号或 @ 所有人。

## 重要说明

Just One API 返回的是第三方数据服务识别或聚合出的平台价格，是否等同于“实际成交价”取决于接口字段和平台活动规则。优惠券、红包、国家补贴等字段会尽量从接口返回中识别；无法明确拆分时，系统会用页面价减到手价估算总优惠。淘宝/京东等平台的公开网页可能触发登录、风控或地区价差，通用截图 API 无法代替登录态浏览器。若需要严格的成交价、券后到手价或订单成交价，仍建议接入品牌授权数据、店铺后台或平台开放能力。
