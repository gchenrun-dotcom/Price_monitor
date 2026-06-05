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

const DEFAULT_DB = {
  monitors: [
    {
      id: 'mon_slian_active_folate_30',
      productName: '斯利安活性叶酸30粒',
      brand: '斯利安',
      platform: 'taobao',
      platforms: ['taobao', 'jd', 'pdd', 'douyin'],
      url: '',
      floorPrice: 79,
      enabled: true,
      notes: '待补充商品链接后开始巡检',
      lastCheckedAt: '',
      lastStatus: 'missing_url',
      lastPrice: null,
      lastError: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    }
  ],
  events: [],
  runs: [],
  settings: {
    feishuWebhook: '',
    feishuSecret: '',
    feishuAtUserIds: '',
    feishuAtAll: false,
    scanIntervalSeconds: 300,
    enableRealScreenshot: false,
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
      monitor.updatedAt = nowIso();

      if (result.event) {
        db.events.unshift(result.event);
        db.events = db.events.slice(0, 500);
        run.alerts += 1;
        await sendFeishuAlert(result.event, db.settings);
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
  try {
    if (!monitor.url) {
      return { status: 'missing_url', price: null, error: '请补充商品链接后再巡检' };
    }
    const fetched = await fetchPage(monitor.url);
    const priceInfo = extractPrice(fetched.html, monitor.platform);
    const evidence = await saveEvidence(monitor, fetched.html, settings);
    const belowFloor = typeof priceInfo.price === 'number' && priceInfo.price < monitor.floorPrice;

    if (!belowFloor) {
      return { status: priceInfo.price == null ? 'no_price' : 'ok', price: priceInfo.price };
    }

    const event = {
      id: id('evt'),
      monitorId: monitor.id,
      productName: monitor.productName,
      platform: monitor.platform,
      platforms: monitor.platforms || [monitor.platform],
      url: monitor.url,
      price: priceInfo.price,
      floorPrice: monitor.floorPrice,
      gap: Number((monitor.floorPrice - priceInfo.price).toFixed(2)),
      priceText: priceInfo.priceText,
      evidenceUrl: evidence.url,
      screenshotUrl: evidence.screenshotUrl,
      htmlEvidenceUrl: evidence.htmlUrl,
      createdAt: nowIso(),
      notified: false,
      notifyError: ''
    };
    return { status: 'alert', price: priceInfo.price, event };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
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

async function saveEvidence(monitor, html, settings) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${monitor.id}`;
  const htmlName = `${baseName}.html`;
  if (hasBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`price-monitor/evidence/${htmlName}`, html, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'text/html; charset=utf-8'
    });
    const evidenceUrl = `/api/evidence?url=${encodeURIComponent(blob.url)}`;
    return {
      url: evidenceUrl,
      screenshotUrl: '',
      htmlUrl: evidenceUrl
    };
  }

  const htmlPath = path.join(EVIDENCE_DIR, htmlName);
  await fs.writeFile(htmlPath, html, 'utf8');

  const screenshotUrl = await tryRealScreenshot(monitor.url, `${baseName}.png`, settings);
  return {
    url: screenshotUrl || `/evidence/${htmlName}`,
    screenshotUrl,
    htmlUrl: `/evidence/${htmlName}`
  };
}

async function tryRealScreenshot(url, filename, settings) {
  if (!settings.enableRealScreenshot) return '';
  try {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const screenshotPath = path.join(EVIDENCE_DIR, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();
    return `/evidence/${filename}`;
  } catch (error) {
    console.warn(`截图失败，已保留 HTML 证据：${error.message}`);
    return '';
  }
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

async function sendFeishuAlert(event, settings) {
  if (!settings.feishuWebhook) return;

  const atUserIds = parseList(settings.feishuAtUserIds);
  const lines = [
    `**品牌低价预警**`,
    ``,
    `商品：${event.productName}`,
    `平台：${platformName(event.platforms || event.platform)}`,
    `识别价格：¥${event.price}`,
    `品牌底价：¥${event.floorPrice}`,
    `低价差额：¥${event.gap}`,
    event.url ? `链接：${event.url}` : '',
    event.evidenceUrl ? `证据：${absoluteEvidenceUrl(event.evidenceUrl)}` : ''
  ].filter(Boolean);

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
  return `http://${host}:${port}${evidenceUrl}`;
}

function normalizeMonitor(input) {
  const productName = String(input.productName || '').trim();
  const url = String(input.url || '').trim();
  const floorPrice = Number(input.floorPrice);
  if (!productName) throw new HttpError(400, '请填写商品名称');
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, '请填写有效商品链接');
  if (!Number.isFinite(floorPrice) || floorPrice <= 0) throw new HttpError(400, '请填写有效最低允许价');
  const platforms = normalizePlatforms(input.platforms || input.platform || (url ? detectPlatform(url) : ['taobao']));

  return {
    id: id('mon'),
    productName,
    brand: String(input.brand || '').trim(),
    platform: platforms[0],
    platforms,
    url,
    floorPrice: Number(floorPrice.toFixed(2)),
    enabled: input.enabled !== false,
    notes: String(input.notes || '').trim(),
    lastCheckedAt: '',
    lastStatus: url ? 'new' : 'missing_url',
    lastPrice: null,
    lastError: '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function pickMonitorUpdates(input) {
  const updates = {};
  if ('productName' in input) updates.productName = String(input.productName || '').trim();
  if ('brand' in input) updates.brand = String(input.brand || '').trim();
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
  return {
    feishuWebhook: String(input.feishuWebhook || '').trim(),
    feishuSecret: String(input.feishuSecret || '').trim(),
    feishuAtUserIds: String(input.feishuAtUserIds || '').trim(),
    feishuAtAll: Boolean(input.feishuAtAll),
    scanIntervalSeconds: Math.max(60, Number(input.scanIntervalSeconds) || 300),
    enableRealScreenshot: Boolean(input.enableRealScreenshot),
    userAgent: String(input.userAgent || DEFAULT_DB.settings.userAgent).trim()
  };
}

function publicState(db) {
  return {
    monitors: db.monitors,
    events: db.events,
    runs: db.runs,
    settings: publicSettings(db.settings),
    scanner: { inProgress: scanInProgress }
  };
}

function publicSettings(settings) {
  return {
    ...settings,
    feishuSecret: settings.feishuSecret ? '********' : ''
  };
}

function settingsFromEnv(settings, env) {
  return normalizeSettings({
    ...settings,
    feishuWebhook: env.FEISHU_WEBHOOK || settings.feishuWebhook,
    feishuSecret: env.FEISHU_SECRET || settings.feishuSecret,
    feishuAtUserIds: env.FEISHU_AT_USER_IDS || settings.feishuAtUserIds,
    feishuAtAll: env.FEISHU_AT_ALL === 'true' || settings.feishuAtAll,
    scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS || settings.scanIntervalSeconds,
    enableRealScreenshot: env.ENABLE_REAL_SCREENSHOT === 'true' || settings.enableRealScreenshot,
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
    monitors: Array.isArray(db.monitors) ? db.monitors : DEFAULT_DB.monitors,
    events: Array.isArray(db.events) ? db.events : [],
    runs: Array.isArray(db.runs) ? db.runs : []
  };
  nextDb.settings = normalizeSettings({ ...DEFAULT_DB.settings, ...nextDb.settings });
  return nextDb;
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
