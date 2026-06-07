import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR =
  process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN
    ? path.join('/tmp', 'price-monitor')
    : path.join(PROJECT_ROOT, 'data');
const EVIDENCE_DIR = path.join(DATA_DIR, 'evidence');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const DB_BLOB_PATH = 'price-monitor/db.json';
const MAX_PRICE_RECORDS = 2000;
const JUST_ONE_DEFAULT_BASE_URL = 'https://api.justoneapi.com';
const JUST_ONE_SEARCH_ENDPOINTS = {
  taobao: '/api/taobao/search-item-list/v1',
  jd: '/api/jd/search-item-list/v1',
  douyin: '/api/douyin-ec/search-item-list/v1'
};
const JUST_ONE_DETAIL_ENDPOINTS = {
  taobao: '/api/taobao/get-item-detail/v1',
  jd: '/api/jd/get-item-detail/v1',
  douyin: '/api/douyin-ec/get-item-detail/v2'
};

const DEFAULT_DB = {
  monitors: [
    {
      id: 'mon_slian_active_folate_30',
      brand: '斯利安',
      productName: '活性叶酸',
      spec: '30粒',
      platform: 'taobao',
      platforms: ['taobao', 'jd', 'pdd', 'douyin'],
      url: '',
      floorPrice: 79,
      enabled: true,
      notes: '未指定链接，按品牌、商品名、规格做全平台巡检',
      lastCheckedAt: '',
      lastStatus: 'new',
      lastPrice: null,
      lastError: '',
      lastPlatform: '',
      lastProductUrl: '',
      lastImageUrl: '',
      lastEvidenceUrl: '',
      lastScreenshotUrl: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    }
  ],
  events: [],
  priceRecords: [],
  runs: [],
  settings: {
    priceCollector: 'justone',
    justOneBaseUrl: JUST_ONE_DEFAULT_BASE_URL,
    justOneToken: '',
    screenshotEnabled: false,
    screenshotApiUrlTemplate: '',
    screenshotApiToken: '',
    notificationChannel: 'feishu',
    feishuWebhook: '',
    feishuSecret: '',
    feishuAtUserIds: '',
    feishuAtAll: false,
    dingtalkWebhook: '',
    dingtalkSecret: '',
    dingtalkAtMobiles: '',
    dingtalkAtAll: false,
    scanIntervalSeconds: 300,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
  }
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml; charset=utf-8'
};

let dbCache = null;
let scanTimer = null;
let scanInProgress = false;
let bootstrapped = false;

export async function handleRequest(req, res) {
  if (!bootstrapped) {
    await bootstrap();
    bootstrapped = true;
  }
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: '服务器处理失败', detail: error.message });
  }
}

const env = await loadEnv();
const port = Number(env.PORT || process.env.PORT || 5173);
const host = env.HOST || process.env.HOST || '127.0.0.1';
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`品牌价格监督台已启动：http://${host}:${port}`);
  });
  scheduleScanner();
}

async function bootstrap() {
  if (hasBlobStorage()) {
    await readDb();
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    const env = await loadEnv();
    const seed = {
      ...DEFAULT_DB,
      settings: settingsFromEnv(DEFAULT_DB.settings, env)
    };
    await fs.writeFile(DB_FILE, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  }
}

async function route(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname.startsWith('/api/')) {
    await apiRoute(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname.startsWith('/evidence/')) {
    await serveEvidence(req, res, requestUrl);
    return;
  }

  await serveStatic(req, res, requestUrl);
}

async function apiRoute(req, res, requestUrl) {
  if (req.method === 'GET' && requestUrl.pathname === '/api/state') {
    const db = await readDb();
    sendJson(res, 200, publicState(db));
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/evidence') {
    await serveBlobEvidence(res, requestUrl);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/monitors') {
    const input = await readBodyJson(req);
    const monitor = normalizeMonitor(input);
    const db = await readDb();
    db.monitors.unshift(monitor);
    await writeDb(db);
    sendJson(res, 201, { monitor });
    return;
  }

  const monitorMatch = requestUrl.pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (monitorMatch && req.method === 'PATCH') {
    const input = await readBodyJson(req);
    const db = await readDb();
    const monitor = db.monitors.find((item) => item.id === monitorMatch[1]);
    if (!monitor) return sendJson(res, 404, { error: '未找到监控任务' });
    Object.assign(monitor, pickMonitorUpdates(input), { updatedAt: nowIso() });
    await writeDb(db);
    sendJson(res, 200, { monitor });
    return;
  }

  if (monitorMatch && req.method === 'DELETE') {
    const db = await readDb();
    db.monitors = db.monitors.filter((item) => item.id !== monitorMatch[1]);
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if ((req.method === 'POST' || req.method === 'GET') && requestUrl.pathname === '/api/scan') {
    if (req.method === 'GET' && !isAuthorizedCron(req)) {
      sendJson(res, 401, { error: '未授权的巡检请求' });
      return;
    }
    const result = await scanAll({ manual: true });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'PATCH' && requestUrl.pathname === '/api/settings') {
    const input = await readBodyJson(req);
    const db = await readDb();
    db.settings = normalizeSettings({ ...db.settings, ...input });
    await writeDb(db);
    scheduleScanner();
    sendJson(res, 200, { settings: publicSettings(db.settings) });
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

async function serveStatic(_req, res, requestUrl) {
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = safeJoin(PUBLIC_DIR, decodeURIComponent(pathname));
  if (!safePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(safePath);
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function serveEvidence(_req, res, requestUrl) {
  const safePath = safeJoin(DATA_DIR, decodeURIComponent(requestUrl.pathname));
  if (!safePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const content = await fs.readFile(safePath);
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Evidence not found');
  }
}

function safeJoin(root, pathname) {
  const fullPath = path.resolve(root, `.${pathname}`);
  if (!fullPath.startsWith(path.resolve(root))) return null;
  return fullPath;
}

async function scanAll({ manual = false } = {}) {
  if (scanInProgress) return { ok: false, message: '已有巡检正在进行' };
  scanInProgress = true;
  const startedAt = nowIso();
  const db = await readDb();
  const activeMonitors = db.monitors.filter((item) => item.enabled);
  const run = {
    id: id('run'),
    startedAt,
    finishedAt: null,
    manual,
    checked: 0,
    alerts: 0,
    errors: 0
  };

  try {
    for (const monitor of activeMonitors) {
      const result = await scanMonitor(monitor, db.settings);
      run.checked += 1;
      monitor.lastCheckedAt = nowIso();
      monitor.lastStatus = result.status;
      monitor.lastPrice = result.price ?? null;
      monitor.lastError = result.error || '';
      if (result.record) {
        monitor.lastPlatform = result.record.platform;
        monitor.lastProductUrl = result.record.url;
        monitor.lastImageUrl = result.record.imageUrl;
        monitor.lastEvidenceUrl = result.record.evidenceUrl;
        monitor.lastScreenshotUrl = result.record.screenshotUrl;
        db.priceRecords.unshift(result.record);
        db.priceRecords = db.priceRecords.slice(0, MAX_PRICE_RECORDS);
      }
      monitor.updatedAt = nowIso();

      if (result.event) {
        db.events.unshift(result.event);
        db.events = db.events.slice(0, 500);
        run.alerts += 1;
        await sendAlert(result.event, db.settings);
      }
      if (result.status === 'error') run.errors += 1;
    }
  } finally {
    run.finishedAt = nowIso();
    db.runs.unshift(run);
    db.runs = db.runs.slice(0, 100);
    await writeDb(db);
    scanInProgress = false;
  }

  return { ok: true, run };
}

async function scanMonitor(monitor, settings) {
  const targets = buildScanTargets(monitor);
  const samples = [];
  const errors = [];

  for (const target of targets) {
    try {
      const targetSamples =
        settings.priceCollector === 'page'
          ? [await collectFromPage(monitor, settings, target)]
          : await collectFromJustOne(monitor, settings, target);

      for (const sample of targetSamples) {
        if (typeof sample.price !== 'number') continue;
        samples.push(sample);
      }
    } catch (error) {
      errors.push(`${platformName(target.platform)}：${error.message}`);
    }
  }

  if (samples.length) {
    const best = samples.sort((a, b) => a.price - b.price)[0];
    const record = await buildPriceRecord(monitor, best, settings);
    const event = best.price < monitor.floorPrice ? buildLowPriceEvent(monitor, record) : null;
    return {
      status: event ? 'alert' : 'ok',
      price: best.price,
      record,
      event,
      error: errors.join('；')
    };
  }
  if (errors.length === targets.length) return { status: 'error', price: null, error: errors.join('；') };
  return { status: 'no_price', price: null, error: errors.join('；') };
}

async function buildPriceRecord(monitor, sample, settings) {
  const screenshot = await captureExternalScreenshot(sample.url, settings, monitor, sample);
  return {
    id: id('rec'),
    monitorId: monitor.id,
    brand: monitor.brand,
    productName: monitor.productName,
    spec: monitor.spec,
    platform: sample.platform,
    platforms: [sample.platform],
    title: sample.title || '',
    url: sample.url || '',
    sourceType: sample.sourceType || 'search',
    collector: settings.priceCollector,
    pagePrice: sample.pagePrice ?? null,
    couponAmount: sample.couponAmount ?? null,
    redPacketAmount: sample.redPacketAmount ?? null,
    subsidyAmount: sample.subsidyAmount ?? null,
    estimatedDiscount: sample.estimatedDiscount ?? null,
    finalPrice: sample.finalPrice ?? sample.price,
    price: sample.price,
    priceText: sample.priceText || `¥${sample.price}`,
    priceSource: sample.priceSource || '',
    priceSourceKey: sample.priceSourceKey || '',
    floorPrice: monitor.floorPrice,
    gap: Number((monitor.floorPrice - sample.price).toFixed(2)),
    imageUrl: sample.imageUrl || '',
    evidenceUrl: sample.evidenceUrl || '',
    screenshotUrl: screenshot.url,
    screenshotStatus: screenshot.status,
    screenshotError: screenshot.error,
    htmlEvidenceUrl: sample.htmlEvidenceUrl || '',
    createdAt: nowIso()
  };
}

function buildLowPriceEvent(monitor, record) {
  return {
    id: id('evt'),
    monitorId: monitor.id,
    brand: monitor.brand,
    productName: monitor.productName,
    spec: monitor.spec,
    platform: record.platform,
    platforms: [record.platform],
    title: record.title,
    url: record.url,
    sourceType: record.sourceType,
    collector: record.collector,
    price: record.price,
    floorPrice: record.floorPrice,
    gap: record.gap,
    priceText: record.priceText,
    evidenceUrl: record.evidenceUrl,
    screenshotUrl: record.screenshotUrl,
    htmlEvidenceUrl: record.htmlEvidenceUrl,
    createdAt: record.createdAt,
    notified: false,
    notifyError: ''
  };
}

async function collectFromPage(monitor, settings, target) {
  const fetched = await fetchPage(target.url);
  const priceInfo = extractPrice(fetched.html, target.platform);
  const evidence = await saveEvidence(monitor, fetched.html, settings, target, 'html');
  return {
    platform: target.platform,
    title: '',
    url: target.url,
    sourceType: target.sourceType,
    price: priceInfo.price,
    finalPrice: priceInfo.price,
    pagePrice: null,
    couponAmount: null,
    redPacketAmount: null,
    subsidyAmount: null,
    estimatedDiscount: null,
    imageUrl: '',
    priceText: priceInfo.priceText,
    evidenceUrl: evidence.url,
    screenshotUrl: evidence.screenshotUrl,
    htmlEvidenceUrl: evidence.htmlUrl
  };
}

async function collectFromJustOne(monitor, settings, target) {
  if (!settings.justOneToken) {
    throw new Error('请先在设置中填写 Just One API Token');
  }
  if (target.platform === 'pdd') {
    throw new Error('Just One API 当前未配置拼多多接口，请补充拼多多 endpoint 后再启用该平台');
  }
  if (!JUST_ONE_SEARCH_ENDPOINTS[target.platform]) {
    throw new Error(`Just One API 暂不支持 ${platformName(target.platform)}`);
  }

  const isDirect = target.sourceType === 'direct';
  const payload = isDirect
    ? await fetchJustOneDetail(settings, target)
    : await fetchJustOneSearch(settings, target);
  const evidence = await saveEvidence(monitor, payload, settings, target, 'json');
  const samples = extractJustOnePriceSamples(payload, monitor, target);
  return samples.map((sample) => ({
    ...sample,
    platform: target.platform,
    sourceType: target.sourceType,
    evidenceUrl: evidence.url,
    screenshotUrl: '',
    htmlEvidenceUrl: evidence.htmlUrl
  }));
}

async function fetchJustOneSearch(settings, target) {
  const path = JUST_ONE_SEARCH_ENDPOINTS[target.platform];
  const params = {
    token: settings.justOneToken,
    keyword: target.query,
    page: '1',
    pageSize: '20'
  };
  return fetchJustOne(settings.justOneBaseUrl, path, params);
}

async function fetchJustOneDetail(settings, target) {
  const path = JUST_ONE_DETAIL_ENDPOINTS[target.platform];
  const itemId = extractPlatformItemId(target.platform, target.url);
  if (!path) throw new Error(`Just One API 暂未配置 ${platformName(target.platform)} 商品详情接口`);
  if (!itemId) throw new Error(`未能从指定链接识别 ${platformName(target.platform)} 商品 ID`);
  return fetchJustOne(settings.justOneBaseUrl, path, {
    token: settings.justOneToken,
    itemId,
    item_id: itemId
  });
}

async function fetchJustOne(baseUrl, endpoint, params) {
  const url = new URL(endpoint, baseUrl || JUST_ONE_DEFAULT_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Just One API 返回 ${response.status}`);
    }
    const apiCode = payload.code ?? payload.errorCode ?? payload.errcode;
    if (apiCode !== undefined && apiCode !== 0 && apiCode !== '0' && apiCode !== 200 && apiCode !== '200') {
      throw new Error(payload.msg || payload.message || payload.error || `Just One API 返回异常码 ${apiCode}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJustOnePriceSamples(payload, monitor, target) {
  const objects = flattenObjects(payload);
  const keyword = [monitor.brand, monitor.productName, monitor.spec].filter(Boolean).join(' ');
  const scored = objects
    .map((item) => buildPriceSample(item, keyword, target))
    .filter((sample) => sample && typeof sample.price === 'number')
    .sort((a, b) => b.score - a.score || a.price - b.price);

  if (target.sourceType === 'direct') {
    const best = scored[0];
    if (!best) throw new Error('Just One API 返回中未识别到商品价格');
    return [best];
  }

  const matched = scored.filter((sample) => sample.score > 0);
  const candidates = matched.length ? matched : scored;
  if (!candidates.length) throw new Error('Just One API 返回中未识别到商品价格');
  return candidates.slice(0, 10);
}

function flattenObjects(value, output = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value)) output.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') flattenObjects(child, output, seen);
  }
  return output;
}

function buildPriceSample(item, keyword, target) {
  const priceCandidate = pickPriceCandidate(item);
  const finalPrice = priceCandidate?.value ?? null;
  const pagePrice = pickPagePrice(item, finalPrice);
  const couponAmount = pickDiscountValue(item, COUPON_KEYS);
  const redPacketAmount = pickDiscountValue(item, RED_PACKET_KEYS);
  const subsidyAmount = pickDiscountValue(item, SUBSIDY_KEYS);
  const explicitDiscounts = [couponAmount, redPacketAmount, subsidyAmount].filter((value) => typeof value === 'number');
  const estimatedDiscount = explicitDiscounts.length
    ? Number(explicitDiscounts.reduce((sum, value) => sum + value, 0).toFixed(2))
    : estimateDiscount(pagePrice, finalPrice);
  const price = finalPrice;
  if (typeof price !== 'number') return null;
  const title = pickFirstString(item, [
    'title',
    'itemTitle',
    'item_title',
    'name',
    'productName',
    'product_name',
    'shortTitle',
    'goodsName',
    'goods_name',
    'skuName'
  ]);
  const url = pickFirstString(item, [
    'url',
    'link',
    'href',
    'itemUrl',
    'item_url',
    'itemLink',
    'item_link',
    'productUrl',
    'product_url',
    'goodsUrl',
    'goods_url',
    'goodsLink',
    'goods_link',
    'detailUrl',
    'detail_url',
    'jumpUrl',
    'jump_url',
    'pcUrl',
    'pc_url',
    'mobileUrl',
    'mobile_url'
  ]);
  const imageUrl = pickFirstString(item, [
    'image',
    'imageUrl',
    'image_url',
    'picUrl',
    'pic_url',
    'mainPic',
    'main_pic',
    'img',
    'imgUrl',
    'img_url',
    'thumbUrl',
    'thumb_url'
  ]);
  const score = scoreSample(title, keyword, target);
  const productUrl = normalizeProductUrl(url);
  return {
    title,
    url: productUrl,
    imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : '',
    pagePrice,
    couponAmount,
    redPacketAmount,
    subsidyAmount,
    estimatedDiscount,
    finalPrice,
    price,
    priceText: priceCandidate?.text || `¥${price}`,
    priceSource: priceCandidate?.source || '',
    priceSourceKey: priceCandidate?.key || '',
    score
  };
}

function normalizeProductUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;
    const isSearchPage =
      /(^|\.)s\.taobao\.com$/.test(host) ||
      /search\.jd\.com$/.test(host) ||
      /search_result/.test(path) ||
      /\/search\//.test(path) ||
      parsed.searchParams.has('keyword') ||
      parsed.searchParams.has('q');
    return isSearchPage ? '' : parsed.toString();
  } catch {
    return '';
  }
}

const FINAL_PRICE_KEYS = [
  'finalPrice',
  'final_price',
  'final_price_text',
  'handPrice',
  'hand_price',
  'handPriceText',
  'hand_price_text',
  'estimatedFinalPrice',
  'estimated_final_price',
  'estimateFinalPrice',
  'estimate_final_price',
  'afterCouponPrice',
  'after_coupon_price',
  'couponedPrice',
  'couponed_price',
  'plusFinalPrice',
  'plus_final_price',
  'plusPrice',
  'plus_price',
  '到手价',
  '实际到手价',
  '预估到手价',
  '券后价',
  'realPrice',
  'real_price',
  'actualPrice',
  'actual_price',
  'dealPrice',
  'deal_price',
  'couponPrice',
  'coupon_price',
  'promotionPrice',
  'promotion_price',
  'salePrice',
  'sale_price',
  'currentPrice',
  'current_price',
  'price',
  'minPrice',
  'min_price',
  'skuPrice',
  'sku_price',
  'jdPrice',
  'jd_price'
];

const PAGE_PRICE_KEYS = [
  'pagePrice',
  'page_price',
  'originalPrice',
  'original_price',
  'marketPrice',
  'market_price',
  'listPrice',
  'list_price',
  'tagPrice',
  'tag_price',
  'retailPrice',
  'retail_price',
  'shopPrice',
  'shop_price'
];

const COUPON_KEYS = ['coupon', 'couponAmount', 'coupon_amount', 'couponValue', 'coupon_value', 'platformCoupon'];
const RED_PACKET_KEYS = ['redPacket', 'red_packet', 'redPacketAmount', 'hongbao', 'bonus', 'allowance'];
const SUBSIDY_KEYS = ['subsidy', 'subsidyAmount', 'nationalSubsidy', 'stateSubsidy', 'govSubsidy'];
const DISCOUNT_VALUE_KEYS = ['amount', 'value', 'discount', 'money', 'price', 'couponAmount', 'subsidyAmount'];

function pickPrice(item) {
  return pickPriceCandidate(item)?.value ?? null;
}

function pickPriceCandidate(item) {
  const candidates = collectPriceCandidates(item)
    .filter((candidate) => typeof candidate.value === 'number' && !isLikelyNoise(candidate.value));
  if (!candidates.length) return null;

  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.value !== b.value) return a.value - b.value;
    return a.path.length - b.path.length;
  })[0];
}

function collectPriceCandidates(item) {
  const candidates = [];
  for (const key of FINAL_PRICE_KEYS) {
    if (!(key in item)) continue;
    candidates.push(...normalizePriceCandidates(item[key], key, key, classifyPriceKey(key)));
  }
  for (const [key, value] of Object.entries(item)) {
    const priority = classifyPriceKey(key);
    if (!priority) {
      if (typeof value === 'string') {
        candidates.push(...extractPriceTextCandidates(value, key, key, 5));
      }
      continue;
    }
    candidates.push(...normalizePriceCandidates(value, key, key, priority));
  }
  return candidates;
}

function normalizePriceCandidates(value, key, pathLabel, priority) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => normalizePriceCandidates(entry, key, `${pathLabel}[${index}]`, priority));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, childValue]) => {
      const childPriority = classifyPriceKey(childKey) || priority;
      return normalizePriceCandidates(childValue, childKey, `${pathLabel}.${childKey}`, childPriority);
    });
  }
  const text = String(value);
  const direct = normalizePriceValue(value, key);
  const candidates = [];
  if (typeof direct === 'number') {
    candidates.push({
      value: direct,
      key,
      path: pathLabel,
      source: pathLabel,
      text: text.includes('¥') || text.includes('￥') || /到手|券后|PLUS|活动|促销/.test(text) ? text : `¥${direct}`,
      priority
    });
  }
  candidates.push(...extractPriceTextCandidates(text, key, pathLabel, priority));
  return candidates;
}

function classifyPriceKey(key) {
  const text = String(key || '').toLowerCase();
  if (/after.?coupon|coupon.?price|couponed|券后/.test(text)) return 1;
  if (/coupon|red.?packet|hongbao|bonus|allowance|subsidy|discount|优惠|红包|补贴|津贴|券/.test(text)) return 0;
  if (/original|market|list|tag|retail|划线|原价|市场|吊牌/.test(text)) return 0;
  if (/final|hand|actual|real|deal|after.?coupon|couponed|estimate|estimated|到手|实际|券后|最终/.test(text)) return 1;
  if (/plus|promotion|promo|activity|sale|current|seckill|sec.?kill|活动|促销|秒杀/.test(text)) return 2;
  if (/price|amount|money|value|jdprice|skuprice|minprice|价格|售价|金额/.test(text)) return 4;
  return 0;
}

function extractPriceTextCandidates(text, key, pathLabel, priority) {
  if (!text || !/(到手|券后|plus|PLUS|活动|促销|秒杀|价格|价|￥|¥)/.test(text)) return [];
  const candidates = [];
  const strongPattern =
    /(?:预估|预计|实际|plus|PLUS)?\s*(?:到手价|到手|券后价|券后|活动价|促销价|秒杀价)[^0-9￥¥]{0,16}[￥¥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
  let match;
  while ((match = strongPattern.exec(text)) !== null) {
    const value = normalizePriceValue(match[1], key);
    if (typeof value === 'number') {
      candidates.push({
        value,
        key,
        path: pathLabel,
        source: `${pathLabel}:text`,
        text: match[0],
        priority: Math.min(priority || 5, 1)
      });
    }
  }
  if (!candidates.length && /到手|券后|plus|PLUS/.test(text)) {
    const loosePattern = /[￥¥]\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
    while ((match = loosePattern.exec(text)) !== null) {
      const value = normalizePriceValue(match[1], key);
      if (typeof value === 'number') {
        candidates.push({
          value,
          key,
          path: pathLabel,
          source: `${pathLabel}:text`,
          text: match[0],
          priority: Math.min(priority || 5, 2)
        });
      }
    }
  }
  return candidates;
}

function pickPagePrice(item, finalPrice) {
  const values = PAGE_PRICE_KEYS
    .map((key) => (key in item ? normalizePriceValue(item[key], key) : null))
    .filter((value) => typeof value === 'number' && !isLikelyNoise(value));
  const usable = typeof finalPrice === 'number' ? values.filter((value) => value >= finalPrice) : values;
  return (usable.length ? usable : values).sort((a, b) => b - a)[0] ?? null;
}

function pickDiscountValue(item, keys) {
  const values = keys
    .flatMap((key) => collectDiscountValues(item, key))
    .filter((value) => typeof value === 'number' && !isLikelyNoise(value));
  return values.sort((a, b) => b - a)[0] ?? null;
}

function collectDiscountValues(item, key) {
  if (!(key in item)) return [];
  const value = item[key];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectDiscountObjectValues(entry, key));
  }
  return collectDiscountObjectValues(value, key);
}

function collectDiscountObjectValues(value, key) {
  if (!value || typeof value !== 'object') {
    const normalized = normalizePriceValue(value, key);
    return typeof normalized === 'number' ? [normalized] : [];
  }
  return DISCOUNT_VALUE_KEYS
    .map((field) => (field in value ? normalizePriceValue(value[field], field) : null))
    .filter((entry) => typeof entry === 'number');
}

function estimateDiscount(pagePrice, finalPrice) {
  if (typeof pagePrice !== 'number' || typeof finalPrice !== 'number') return null;
  const diff = Number((pagePrice - finalPrice).toFixed(2));
  return diff > 0 ? diff : null;
}

function normalizePriceValue(value, key = '') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    return pickPrice(value);
  }
  const text = String(value).replace(/[,，￥¥元\s]/g, '');
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;
  const lowerKey = key.toLowerCase();
  const normalized = /(cent|cents|fen|分)$/.test(lowerKey) || (number > 10000 && !String(value).includes('.'))
    ? number / 100
    : number;
  if (normalized <= 0 || normalized > 1000000) return null;
  return Number(normalized.toFixed(2));
}

function pickFirstString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function scoreSample(title, keyword, target) {
  if (target.sourceType === 'direct') return 10;
  const titleText = normalizeMatchText(title);
  const words = normalizeMatchText(keyword).split(/\s+/).filter(Boolean);
  return words.reduce((score, word) => (titleText.includes(word) ? score + 1 : score), 0);
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function extractPlatformItemId(platform, url) {
  try {
    const parsed = new URL(url);
    if (platform === 'taobao') {
      return parsed.searchParams.get('id') || parsed.searchParams.get('itemId') || matchFirst(url, /(?:item|i)(\d{8,})\.htm/i);
    }
    if (platform === 'jd') {
      return parsed.searchParams.get('sku') || parsed.searchParams.get('skuId') || matchFirst(parsed.pathname, /(\d{6,})\.html/i);
    }
    if (platform === 'douyin') {
      return (
        parsed.searchParams.get('item_id') ||
        parsed.searchParams.get('commodity_id') ||
        parsed.searchParams.get('product_id') ||
        matchFirst(parsed.pathname, /(?:product|item|goods)\/(\d{6,})/i)
      );
    }
  } catch {
    return '';
  }
  return '';
}

function matchFirst(value, pattern) {
  const match = String(value || '').match(pattern);
  return match ? match[1] : '';
}

async function fetchPage(url) {
  const env = await loadEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
        'user-agent': env.USER_AGENT || DEFAULT_DB.settings.userAgent
      }
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`页面返回 ${response.status}`);
    return { html, finalUrl: response.url };
  } finally {
    clearTimeout(timeout);
  }
}

function buildScanTargets(monitor) {
  const query = [monitor.brand, monitor.productName, monitor.spec].filter(Boolean).join(' ');
  if (monitor.url) {
    const platform = detectPlatform(monitor.url);
    return [
      {
        platform: platform === 'custom' ? monitor.platform || 'custom' : platform,
        url: monitor.url,
        query,
        sourceType: 'direct'
      }
    ];
  }

  return normalizePlatforms(monitor.platforms || monitor.platform)
    .filter((platform) => platform !== 'custom')
    .map((platform) => ({
      platform,
      url: buildPlatformSearchUrl(platform, query),
      query,
      sourceType: 'search'
    }));
}

function buildPlatformSearchUrl(platform, query) {
  const encoded = encodeURIComponent(query);
  const gbkEncoded = encodeURIComponent(query);
  return {
    taobao: `https://s.taobao.com/search?q=${encoded}`,
    jd: `https://search.jd.com/Search?keyword=${encoded}&enc=utf-8`,
    pdd: `https://mobile.yangkeduo.com/search_result.html?search_key=${encoded}`,
    douyin: `https://www.douyin.com/search/${encoded}?type=general`
  }[platform] || `https://www.baidu.com/s?wd=${gbkEncoded}`;
}

function extractPrice(html, platform) {
  const text = html.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&yen;/g, '¥');
  const candidates = [];
  const patterns = [
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/gi,
    /"salePrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/gi,
    /"currentPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/gi,
    /"pddPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/gi,
    /"minPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/gi,
    /￥\s*([0-9]+(?:\.[0-9]{1,2})?)/g,
    /¥\s*([0-9]+(?:\.[0-9]{1,2})?)/g,
    /(?:价格|到手价|券后价|秒杀价|活动价|促销价)[^0-9￥¥]{0,12}[￥¥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 1000000) {
        candidates.push({ value, text: match[0].slice(0, 80) });
      }
    }
  }

  const cleanCandidates = candidates
    .filter((item) => !isLikelyNoise(item.value))
    .sort((a, b) => a.value - b.value);

  const best = cleanCandidates[0] || candidates.sort((a, b) => a.value - b.value)[0];
  return {
    platform,
    price: best ? Number(best.value.toFixed(2)) : null,
    priceText: best ? best.text : ''
  };
}

function isLikelyNoise(value) {
  return value === 0 || value === 1 || value === 100 || value === 999999;
}

async function saveEvidence(monitor, content, settings, target, type = 'html') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${target.platform}-${monitor.id}`;
  const isJson = type === 'json';
  const htmlName = `${baseName}.${isJson ? 'json' : 'html'}`;
  const body = isJson ? `${JSON.stringify(content, null, 2)}\n` : content;
  const contentType = isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
  if (hasBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`price-monitor/evidence/${htmlName}`, body, {
      access: 'private',
      allowOverwrite: true,
      contentType
    });
    const evidenceUrl = `/api/evidence?url=${encodeURIComponent(blob.url)}`;
    return {
      url: evidenceUrl,
      screenshotUrl: '',
      htmlUrl: evidenceUrl
    };
  }

  const htmlPath = path.join(EVIDENCE_DIR, htmlName);
  await fs.writeFile(htmlPath, body, 'utf8');

  return {
    url: `/evidence/${htmlName}`,
    screenshotUrl: '',
    htmlUrl: `/evidence/${htmlName}`
  };
}

async function captureExternalScreenshot(targetUrl, settings, monitor, sample) {
  if (!settings.screenshotEnabled) return { status: 'disabled', url: '', error: '' };
  if (!settings.screenshotApiUrlTemplate) return { status: 'failed', url: '', error: '未配置截图 API URL 模板' };
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return { status: 'failed', url: '', error: '未识别到商品详情链接，已避免截图搜索页或登录页' };
  }

  const requestUrl = settings.screenshotApiUrlTemplate
    .replaceAll('{url}', encodeURIComponent(targetUrl))
    .replaceAll('{token}', encodeURIComponent(settings.screenshotApiToken || ''));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(requestUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`截图 API 返回 ${response.status}`);
    const contentType = response.headers.get('content-type') || 'image/png';
    const image = /^image\//i.test(contentType)
      ? {
          buffer: Buffer.from(await response.arrayBuffer()),
          contentType
        }
      : await downloadScreenshotFromJson(response, controller.signal);

    if (!image.buffer.length) throw new Error('截图 API 返回空图片');
    const ext = screenshotExtension(image.contentType);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}-${sample.platform}-${monitor.id}-price${ext}`;
    const url = await saveBinaryEvidence(image.buffer, filename, image.contentType);
    return { status: 'ok', url, error: '' };
  } catch (error) {
    return { status: 'failed', url: '', error: error.message || '截图失败' };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadScreenshotFromJson(response, signal) {
  const contentType = response.headers.get('content-type') || '';
  if (!/json/i.test(contentType)) throw new Error(`截图 API 未返回图片或 JSON：${contentType}`);
  const payload = await response.json();
  const imageUrl = findScreenshotImageUrl(payload);
  if (!imageUrl) throw new Error('截图 API JSON 中未找到图片地址');

  const imageResponse = await fetch(imageUrl, { signal });
  if (!imageResponse.ok) throw new Error(`截图图片下载失败 ${imageResponse.status}`);
  const imageContentType = imageResponse.headers.get('content-type') || 'image/png';
  if (!/^image\//i.test(imageContentType)) throw new Error(`截图图片地址未返回图片：${imageContentType}`);
  return {
    buffer: Buffer.from(await imageResponse.arrayBuffer()),
    contentType: imageContentType
  };
}

function findScreenshotImageUrl(payload) {
  const keys = [
    'screenshotUrl',
    'screenshot_url',
    'screenshot',
    'imageUrl',
    'image_url',
    'image',
    'url'
  ];
  const stack = [payload];
  while (stack.length) {
    const value = stack.shift();
    if (!value || typeof value !== 'object') continue;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return '';
}

async function saveBinaryEvidence(buffer, filename, contentType) {
  if (hasBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`price-monitor/evidence/${filename}`, buffer, {
      access: 'private',
      allowOverwrite: true,
      contentType
    });
    return `/api/evidence?url=${encodeURIComponent(blob.url)}`;
  }
  const filePath = path.join(EVIDENCE_DIR, filename);
  await fs.writeFile(filePath, buffer);
  return `/evidence/${filename}`;
}

function screenshotExtension(contentType) {
  if (/jpe?g/i.test(contentType)) return '.jpg';
  if (/webp/i.test(contentType)) return '.webp';
  return '.png';
}

async function serveBlobEvidence(res, requestUrl) {
  const url = requestUrl.searchParams.get('url');
  if (!url || !/\.blob\.vercel-storage\.com\//.test(url)) {
    sendJson(res, 400, { error: '证据地址无效' });
    return;
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN || ''}`
    }
  });
  if (!response.ok) {
    sendJson(res, response.status, { error: '读取证据失败' });
    return;
  }
  res.writeHead(200, {
    'content-type': response.headers.get('content-type') || 'text/html; charset=utf-8',
    'cache-control': 'private, max-age=60'
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function sendAlert(event, settings) {
  if (settings.notificationChannel === 'dingtalk') {
    await sendDingtalkAlert(event, settings);
    return;
  }
  await sendFeishuAlert(event, settings);
}

function alertLines(event) {
  return [
    `**品牌低价预警**`,
    ``,
    `品牌：${event.brand || '未填写'}`,
    `商品：${event.productName}`,
    `规格：${event.spec || '未填写'}`,
    `平台：${platformName(event.platforms || event.platform)}`,
    event.title ? `命中标题：${event.title}` : '',
    `范围：${event.sourceType === 'direct' ? '指定链接' : '全平台搜索'}`,
    `采集源：${event.collector === 'page' ? '页面抓取' : 'Just One API'}`,
    `识别价格：¥${event.price}`,
    `品牌底价：¥${event.floorPrice}`,
    `低价差额：¥${event.gap}`,
    event.url ? `链接：${event.url}` : '',
    event.evidenceUrl ? `证据：${absoluteEvidenceUrl(event.evidenceUrl)}` : ''
  ].filter(Boolean);
}

async function sendFeishuAlert(event, settings) {
  if (!settings.feishuWebhook) return;

  const atUserIds = parseList(settings.feishuAtUserIds);
  const lines = alertLines(event);

  if (settings.feishuAtAll) {
    lines.push('<at user_id="all">所有人</at>');
  } else if (atUserIds.length) {
    lines.push(
      atUserIds.map((userId) => `<at user_id="${escapeFeishuAttr(userId)}">${userId}</at>`).join(' ')
    );
  }

  try {
    const payload = {
      msg_type: 'text',
      content: {
        text: lines.join('\n')
      }
    };
    const signed = signFeishuPayload(settings.feishuSecret);
    Object.assign(payload, signed);

    const response = await fetch(settings.feishuWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body.code && body.code !== 0) || (body.StatusCode && body.StatusCode !== 0)) {
      throw new Error(body.msg || body.StatusMessage || `飞书返回 ${response.status}`);
    }
    event.notified = true;
    event.notifyChannel = 'feishu';
  } catch (error) {
    event.notifyError = error.message;
  }
}

async function sendDingtalkAlert(event, settings) {
  if (!settings.dingtalkWebhook) return;

  const atMobiles = parseList(settings.dingtalkAtMobiles);
  const atText = settings.dingtalkAtAll
    ? '@所有人'
    : atMobiles.map((mobile) => `@${mobile}`).join(' ');
  const text = [alertLines(event).join('\n'), atText].filter(Boolean).join('\n');

  try {
    const response = await fetch(signedDingtalkWebhook(settings.dingtalkWebhook, settings.dingtalkSecret), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: text },
        at: {
          atMobiles,
          isAtAll: Boolean(settings.dingtalkAtAll)
        }
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body.errcode && body.errcode !== 0)) {
      throw new Error(body.errmsg || `钉钉返回 ${response.status}`);
    }
    event.notified = true;
    event.notifyChannel = 'dingtalk';
  } catch (error) {
    event.notifyError = error.message;
  }
}

function signFeishuPayload(secret) {
  if (!secret) return {};
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
  return { timestamp, sign };
}

function signedDingtalkWebhook(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const url = new URL(webhook);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  return url.toString();
}

function escapeFeishuAttr(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function absoluteEvidenceUrl(evidenceUrl) {
  if (!evidenceUrl) return '';
  if (/^https?:\/\//.test(evidenceUrl)) return evidenceUrl;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${evidenceUrl}`;
  return `http://${host}:${port}${evidenceUrl}`;
}

function normalizeMonitor(input) {
  const brand = String(input.brand || '').trim();
  const productName = String(input.productName || '').trim();
  const spec = String(input.spec || '').trim();
  const url = String(input.url || '').trim();
  const floorPrice = Number(input.floorPrice);
  if (!brand) throw new HttpError(400, '请填写品牌');
  if (!productName) throw new HttpError(400, '请填写商品名称');
  if (!spec) throw new HttpError(400, '请填写规格');
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, '请填写有效商品链接');
  if (!Number.isFinite(floorPrice) || floorPrice <= 0) throw new HttpError(400, '请填写有效最低允许价');
  const platforms = normalizePlatforms(input.platforms || input.platform || (url ? detectPlatform(url) : ['taobao']));

  return {
    id: id('mon'),
    productName,
    brand,
    spec,
    platform: platforms[0],
    platforms,
    url,
    floorPrice: Number(floorPrice.toFixed(2)),
    enabled: input.enabled !== false,
    notes: String(input.notes || '').trim(),
    lastCheckedAt: '',
    lastStatus: 'new',
    lastPrice: null,
    lastError: '',
    lastPlatform: '',
    lastProductUrl: '',
    lastImageUrl: '',
    lastEvidenceUrl: '',
    lastScreenshotUrl: '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function pickMonitorUpdates(input) {
  const updates = {};
  if ('productName' in input) updates.productName = String(input.productName || '').trim();
  if ('brand' in input) updates.brand = String(input.brand || '').trim();
  if ('spec' in input) updates.spec = String(input.spec || '').trim();
  if ('platform' in input || 'platforms' in input) {
    const platforms = normalizePlatforms(input.platforms || input.platform);
    updates.platform = platforms[0];
    updates.platforms = platforms;
  }
  if ('url' in input) {
    const url = String(input.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, '请填写有效商品链接');
    updates.url = url;
  }
  if ('floorPrice' in input) {
    const floorPrice = Number(input.floorPrice);
    if (!Number.isFinite(floorPrice) || floorPrice <= 0) throw new HttpError(400, '请填写有效最低允许价');
    updates.floorPrice = Number(floorPrice.toFixed(2));
  }
  if ('enabled' in input) updates.enabled = Boolean(input.enabled);
  if ('notes' in input) updates.notes = String(input.notes || '').trim();
  return updates;
}

function normalizeSettings(input) {
  const notificationChannel = ['feishu', 'dingtalk'].includes(input.notificationChannel)
    ? input.notificationChannel
    : 'feishu';
  const priceCollector = ['justone', 'page'].includes(input.priceCollector)
    ? input.priceCollector
    : 'justone';
  return {
    priceCollector,
    justOneBaseUrl: String(input.justOneBaseUrl || JUST_ONE_DEFAULT_BASE_URL).trim(),
    justOneToken: String(input.justOneToken || '').trim(),
    notificationChannel,
    feishuWebhook: String(input.feishuWebhook || '').trim(),
    feishuSecret: String(input.feishuSecret || '').trim(),
    feishuAtUserIds: String(input.feishuAtUserIds || '').trim(),
    feishuAtAll: Boolean(input.feishuAtAll),
    dingtalkWebhook: String(input.dingtalkWebhook || '').trim(),
    dingtalkSecret: String(input.dingtalkSecret || '').trim(),
    dingtalkAtMobiles: String(input.dingtalkAtMobiles || '').trim(),
    dingtalkAtAll: Boolean(input.dingtalkAtAll),
    scanIntervalSeconds: Math.max(60, Number(input.scanIntervalSeconds) || 300),
    screenshotEnabled: Boolean(input.screenshotEnabled),
    screenshotApiUrlTemplate: String(input.screenshotApiUrlTemplate || '').trim(),
    screenshotApiToken: String(input.screenshotApiToken || '').trim(),
    userAgent: String(input.userAgent || DEFAULT_DB.settings.userAgent).trim()
  };
}

function publicState(db) {
  return {
    monitors: db.monitors,
    events: db.events,
    priceRecords: db.priceRecords,
    runs: db.runs,
    settings: publicSettings(db.settings),
    scanner: { inProgress: scanInProgress }
  };
}

function publicSettings(settings) {
  return {
    ...settings,
    justOneToken: settings.justOneToken ? '********' : '',
    screenshotApiToken: settings.screenshotApiToken ? '********' : '',
    feishuSecret: settings.feishuSecret ? '********' : '',
    dingtalkSecret: settings.dingtalkSecret ? '********' : ''
  };
}

function settingsFromEnv(settings, env) {
  return normalizeSettings({
    ...settings,
    priceCollector: env.PRICE_COLLECTOR || settings.priceCollector,
    justOneBaseUrl: env.JUST_ONE_BASE_URL || settings.justOneBaseUrl,
    justOneToken: env.JUST_ONE_TOKEN || settings.justOneToken,
    screenshotEnabled: env.SCREENSHOT_ENABLED === 'true' || settings.screenshotEnabled,
    screenshotApiUrlTemplate: env.SCREENSHOT_API_URL_TEMPLATE || settings.screenshotApiUrlTemplate,
    screenshotApiToken: env.SCREENSHOT_API_TOKEN || settings.screenshotApiToken,
    notificationChannel: env.NOTIFICATION_CHANNEL || settings.notificationChannel,
    feishuWebhook: env.FEISHU_WEBHOOK || settings.feishuWebhook,
    feishuSecret: env.FEISHU_SECRET || settings.feishuSecret,
    feishuAtUserIds: env.FEISHU_AT_USER_IDS || settings.feishuAtUserIds,
    feishuAtAll: env.FEISHU_AT_ALL === 'true' || settings.feishuAtAll,
    dingtalkWebhook: env.DINGTALK_WEBHOOK || settings.dingtalkWebhook,
    dingtalkSecret: env.DINGTALK_SECRET || settings.dingtalkSecret,
    dingtalkAtMobiles: env.DINGTALK_AT_MOBILES || settings.dingtalkAtMobiles,
    dingtalkAtAll: env.DINGTALK_AT_ALL === 'true' || settings.dingtalkAtAll,
    scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS || settings.scanIntervalSeconds,
    userAgent: env.USER_AGENT || settings.userAgent
  });
}

function detectPlatform(url) {
  const host = new URL(url).hostname;
  if (/taobao|tmall/.test(host)) return 'taobao';
  if (/jd|jingdong/.test(host)) return 'jd';
  if (/pinduoduo|yangkeduo|pdd/.test(host)) return 'pdd';
  if (/douyin|iesdouyin/.test(host)) return 'douyin';
  return 'custom';
}

function normalizePlatform(platform) {
  const value = String(platform || 'custom').toLowerCase();
  return ['taobao', 'jd', 'pdd', 'douyin', 'custom'].includes(value) ? value : 'custom';
}

function platformName(platform) {
  if (Array.isArray(platform)) {
    return platform.map((item) => platformName(item)).join('、');
  }
  return {
    taobao: '淘宝/天猫',
    jd: '京东',
    pdd: '拼多多',
    douyin: '抖音电商',
    custom: '自定义平台'
  }[platform] || platform;
}

function normalizePlatforms(platforms) {
  const raw = Array.isArray(platforms) ? platforms : String(platforms || '').split(',');
  const normalized = raw
    .map((platform) => normalizePlatform(platform))
    .filter((platform, index, list) => platform && list.indexOf(platform) === index);
  return normalized.length ? normalized : ['custom'];
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAuthorizedCron(req) {
  if (!process.env.CRON_SECRET) return true;
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

async function readDb() {
  if (dbCache) return dbCache;
  if (hasBlobStorage()) {
    dbCache = await readBlobDb();
    return dbCache;
  }
  const raw = await fs.readFile(DB_FILE, 'utf8');
  dbCache = normalizeDb(JSON.parse(raw));
  return dbCache;
}

async function writeDb(db) {
  dbCache = db;
  if (hasBlobStorage()) {
    await writeBlobDb(db);
    return;
  }
  await fs.writeFile(DB_FILE, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
}

async function readBlobDb() {
  try {
    const { get } = await import('@vercel/blob');
    const blob = await get(DB_BLOB_PATH, { access: 'private' });
    const raw = await blob.text();
    return normalizeDb(JSON.parse(raw));
  } catch (error) {
    if (!/not found|404/i.test(error.message || '')) {
      console.warn(`读取 Blob 数据失败，使用初始数据：${error.message}`);
    }
    const seed = normalizeDb(DEFAULT_DB);
    await writeBlobDb(seed);
    return seed;
  }
}

async function writeBlobDb(db) {
  const { put } = await import('@vercel/blob');
  await put(DB_BLOB_PATH, `${JSON.stringify(db, null, 2)}\n`, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8'
  });
}

function normalizeDb(db) {
  const nextDb = {
    ...DEFAULT_DB,
    ...db,
    monitors: Array.isArray(db.monitors) ? db.monitors.map(normalizeStoredMonitor) : DEFAULT_DB.monitors,
    events: Array.isArray(db.events) ? db.events : [],
    priceRecords: Array.isArray(db.priceRecords) ? db.priceRecords : [],
    runs: Array.isArray(db.runs) ? db.runs : []
  };
  nextDb.settings = normalizeSettings({ ...DEFAULT_DB.settings, ...nextDb.settings });
  return nextDb;
}

function normalizeStoredMonitor(monitor) {
  const nextMonitor = {
    ...monitor,
    brand: String(monitor.brand || '').trim(),
    productName: String(monitor.productName || '').trim(),
    spec: String(monitor.spec || '').trim(),
    lastPlatform: monitor.lastPlatform || '',
    lastProductUrl: monitor.lastProductUrl || '',
    lastImageUrl: monitor.lastImageUrl || '',
    lastEvidenceUrl: monitor.lastEvidenceUrl || '',
    lastScreenshotUrl: monitor.lastScreenshotUrl || ''
  };
  if (nextMonitor.lastStatus === 'missing_url') nextMonitor.lastStatus = 'new';
  if (!Array.isArray(nextMonitor.platforms)) {
    nextMonitor.platforms = normalizePlatforms(nextMonitor.platform || (nextMonitor.url ? detectPlatform(nextMonitor.url) : 'taobao'));
  }
  nextMonitor.platform = nextMonitor.platform || nextMonitor.platforms[0];
  return nextMonitor;
}

function hasBlobStorage() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求数据不是有效 JSON');
  }
}

async function loadEnv() {
  const result = { ...process.env };
  try {
    const raw = await fs.readFile(ENV_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      result[key] = value;
    }
  } catch {
    // .env is optional for local demos.
  }
  return result;
}

function scheduleScanner() {
  if (scanTimer) clearInterval(scanTimer);
  readDb().then((db) => {
    const seconds = Math.max(60, Number(db.settings.scanIntervalSeconds) || 300);
    scanTimer = setInterval(() => {
      scanAll().catch((error) => console.error(error));
    }, seconds * 1000);
  });
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, payload) {
  const code = payload instanceof HttpError ? payload.statusCode : status;
  const body = payload instanceof HttpError ? { error: payload.message } : payload;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
