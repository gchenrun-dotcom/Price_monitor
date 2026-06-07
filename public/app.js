const state = {
  monitors: [],
  events: [],
  priceRecords: [],
  runs: [],
  settings: {},
  scanner: {}
};

const platformNames = {
  taobao: '淘宝/天猫',
  jd: '京东',
  pdd: '拼多多',
  douyin: '抖音电商',
  custom: '自定义'
};

const statusNames = {
  new: '待巡检',
  ok: '正常',
  alert: '低价',
  error: '异常',
  no_price: '未识别价格'
};

const monitorForm = document.querySelector('#monitorForm');
const settingsForm = document.querySelector('#settingsForm');
const scanNowBtn = document.querySelector('#scanNowBtn');
const platformAll = document.querySelector('#platformAll');
const platformCheckboxes = [...document.querySelectorAll('input[name="platforms"]')];
const channelPanels = [...document.querySelectorAll('[data-channel-panel]')];

platformAll.addEventListener('change', () => {
  platformCheckboxes.forEach((checkbox) => {
    checkbox.checked = platformAll.checked;
  });
});

platformCheckboxes.forEach((checkbox) => {
  checkbox.addEventListener('change', syncPlatformAll);
});

monitorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(monitorForm);
  const data = Object.fromEntries(form);
  data.platforms = form.getAll('platforms');
  if (!data.platforms.length) {
    toast('请至少选择一个监控平台');
    return;
  }
  data.floorPrice = Number(data.floorPrice);
  await api('/api/monitors', { method: 'POST', body: data });
  monitorForm.reset();
  syncPlatformAll();
  toast('监控任务已添加');
  await refresh();
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(settingsForm);
  const data = Object.fromEntries(form);
  data.scanIntervalSeconds = Number(data.scanIntervalSeconds);
  data.feishuAtAll = form.has('feishuAtAll');
  data.dingtalkAtAll = form.has('dingtalkAtAll');
  data.screenshotEnabled = form.has('screenshotEnabled');
  if (data.justOneToken === '********') delete data.justOneToken;
  if (data.screenshotApiToken === '********') delete data.screenshotApiToken;
  if (data.feishuSecret === '********') delete data.feishuSecret;
  if (data.dingtalkSecret === '********') delete data.dingtalkSecret;
  await api('/api/settings', { method: 'PATCH', body: data });
  toast('设置已保存');
  await refresh();
});

settingsForm.notificationChannel.addEventListener('change', syncNotificationChannel);

scanNowBtn.addEventListener('click', async () => {
  scanNowBtn.disabled = true;
  scanNowBtn.textContent = '巡检中';
  try {
    const result = await api('/api/scan', { method: 'POST' });
    toast(result.message || '巡检完成');
    await refresh();
  } finally {
    scanNowBtn.disabled = false;
    scanNowBtn.innerHTML = '<span class="icon">↻</span>立即巡检';
  }
});

document.addEventListener('click', async (event) => {
  const toggleBtn = event.target.closest('[data-toggle]');
  if (toggleBtn) {
    const monitor = state.monitors.find((item) => item.id === toggleBtn.dataset.toggle);
    await api(`/api/monitors/${monitor.id}`, {
      method: 'PATCH',
      body: { enabled: !monitor.enabled }
    });
    toast(monitor.enabled ? '任务已暂停' : '任务已启用');
    await refresh();
  }

  const deleteBtn = event.target.closest('[data-delete]');
  if (deleteBtn) {
    const monitor = state.monitors.find((item) => item.id === deleteBtn.dataset.delete);
    if (!confirm(`删除“${monitorTitle(monitor)}”？`)) return;
    await api(`/api/monitors/${monitor.id}`, { method: 'DELETE' });
    toast('任务已删除');
    await refresh();
  }
});

await refresh();
setInterval(refresh, 30000);

async function refresh() {
  const nextState = await api('/api/state');
  Object.assign(state, nextState);
  render();
}

function render() {
  renderMetrics();
  renderSettings();
  renderMonitors();
  renderPriceRecords();
  renderEvents();
}

function renderMetrics() {
  const enabled = state.monitors.filter((item) => item.enabled).length;
  const latestRun = state.runs[0];
  document.querySelector('#metricMonitors').textContent = state.monitors.length;
  document.querySelector('#metricEnabled').textContent = enabled;
  document.querySelector('#metricAlerts').textContent = state.events.length;
  document.querySelector('#metricLastRun').textContent = latestRun ? formatTime(latestRun.finishedAt) : '-';
  document.querySelector('#summaryText').textContent =
    state.scanner.inProgress
      ? '后台正在巡检监控任务'
      : `每 ${state.settings.scanIntervalSeconds || 300} 秒自动巡检一次`;
}

function renderSettings() {
  settingsForm.priceCollector.value = state.settings.priceCollector || 'justone';
  settingsForm.justOneBaseUrl.value = state.settings.justOneBaseUrl || 'https://api.justoneapi.com';
  settingsForm.justOneToken.value = state.settings.justOneToken || '';
  settingsForm.screenshotApiUrlTemplate.value = state.settings.screenshotApiUrlTemplate || '';
  settingsForm.screenshotApiToken.value = state.settings.screenshotApiToken || '';
  settingsForm.notificationChannel.value = state.settings.notificationChannel || 'feishu';
  settingsForm.feishuWebhook.value = state.settings.feishuWebhook || '';
  settingsForm.feishuSecret.value = state.settings.feishuSecret || '';
  settingsForm.feishuAtUserIds.value = state.settings.feishuAtUserIds || '';
  settingsForm.dingtalkWebhook.value = state.settings.dingtalkWebhook || '';
  settingsForm.dingtalkSecret.value = state.settings.dingtalkSecret || '';
  settingsForm.dingtalkAtMobiles.value = state.settings.dingtalkAtMobiles || '';
  settingsForm.scanIntervalSeconds.value = state.settings.scanIntervalSeconds || 300;
  settingsForm.feishuAtAll.checked = Boolean(state.settings.feishuAtAll);
  settingsForm.dingtalkAtAll.checked = Boolean(state.settings.dingtalkAtAll);
  settingsForm.screenshotEnabled.checked = Boolean(state.settings.screenshotEnabled);
  syncNotificationChannel();
}

function renderMonitors() {
  document.querySelector('#monitorCount').textContent = `${state.monitors.length} 条`;
  const rows = document.querySelector('#monitorRows');
  if (!state.monitors.length) {
    rows.innerHTML = `<tr><td colspan="6"><div class="empty">还没有监控任务</div></td></tr>`;
    return;
  }

  rows.innerHTML = state.monitors
    .map((monitor) => {
      const statusClass =
        monitor.lastStatus === 'alert' ? 'alert' : monitor.lastStatus === 'error' ? 'error' : '';
      return `
        <tr>
          <td class="title-cell">
            ${monitor.url ? `<a href="${escapeAttr(monitor.url)}" target="_blank" rel="noreferrer">${escapeHtml(monitorTitle(monitor))}</a>` : `<strong>${escapeHtml(monitorTitle(monitor))}</strong>`}
            <small>${monitor.url ? '指定链接' : '全平台搜索'} · ${escapeHtml(monitor.notes || '无备注')}</small>
          </td>
          <td>${platformLabel(monitor.platforms || monitor.platform)}</td>
          <td>¥${money(monitor.floorPrice)}</td>
          <td>${monitor.lastPrice == null ? '-' : `¥${money(monitor.lastPrice)}`}</td>
          <td><span class="pill ${statusClass}">${statusNames[monitor.lastStatus] || monitor.lastStatus}</span></td>
          <td>
            <div class="actions">
              <button class="ghost-btn" type="button" data-toggle="${monitor.id}">${monitor.enabled ? '暂停' : '启用'}</button>
              <button class="danger-btn" type="button" data-delete="${monitor.id}">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderPriceRecords() {
  const records = state.priceRecords || [];
  document.querySelector('#priceRecordCount').textContent = `${records.length} 条`;
  renderCurrentPrices(records);
  renderPriceRecordRows(records);
}

function renderCurrentPrices(records) {
  const wrap = document.querySelector('#currentPriceCards');
  if (!state.monitors.length) {
    wrap.innerHTML = `<div class="empty">还没有监控商品</div>`;
    return;
  }

  wrap.innerHTML = state.monitors
    .map((monitor) => {
      const latest = records.find((record) => record.monitorId === monitor.id);
      if (!latest) {
        return `
          <article class="price-card">
            <h3>${escapeHtml(monitorTitle(monitor))}</h3>
            <div class="muted-line">暂未形成价格记录</div>
          </article>
        `;
      }
      return `
        <article class="price-card">
          <div>
            <h3>${escapeHtml(monitorTitle(latest))}</h3>
            <span>${platformLabel(latest.platforms || latest.platform)} · ${formatTime(latest.createdAt)}</span>
          </div>
          <strong>¥${money(latest.finalPrice ?? latest.price)}</strong>
          <p>${escapeHtml(latest.title || '未识别标题')}</p>
          <div class="actions">
            ${latest.url ? `<a class="ghost-btn" href="${escapeAttr(latest.url)}" target="_blank" rel="noreferrer">商品</a>` : ''}
            ${latest.screenshotUrl ? `<a class="primary-btn" href="${escapeAttr(latest.screenshotUrl)}" target="_blank" rel="noreferrer">截图</a>` : `<span class="pill error">${escapeHtml(screenshotLabel(latest))}</span>`}
            ${latest.evidenceUrl ? `<a class="ghost-btn" href="${escapeAttr(latest.evidenceUrl)}" target="_blank" rel="noreferrer">证据</a>` : ''}
          </div>
        </article>
      `;
    })
    .join('');
}

function renderPriceRecordRows(records) {
  const rows = document.querySelector('#priceRecordRows');
  if (!records.length) {
    rows.innerHTML = `<tr><td colspan="9"><div class="empty">暂未形成历史价格记录</div></td></tr>`;
    return;
  }

  rows.innerHTML = records
    .map(
      (record) => `
        <tr>
          <td>${formatTime(record.createdAt)}</td>
          <td class="title-cell">
            <strong>${escapeHtml(monitorTitle(record))}</strong>
            <small>${escapeHtml(record.title || '未识别标题')}</small>
          </td>
          <td>${platformLabel(record.platforms || record.platform)}</td>
          <td>${priceOrDash(record.pagePrice)}</td>
          <td>${discountText(record)}</td>
          <td><b class="event-price">${priceOrDash(record.finalPrice ?? record.price)}</b></td>
          <td>${escapeHtml(collectorText(record))}</td>
          <td>${record.screenshotUrl ? `<a class="ghost-btn" href="${escapeAttr(record.screenshotUrl)}" target="_blank" rel="noreferrer">截图</a>` : escapeHtml(screenshotLabel(record))}</td>
          <td>${record.evidenceUrl ? `<a class="ghost-btn" href="${escapeAttr(record.evidenceUrl)}" target="_blank" rel="noreferrer">证据</a>` : '-'}</td>
        </tr>
      `
    )
    .join('');
}

function renderEvents() {
  document.querySelector('#eventCount').textContent = `${state.events.length} 条`;
  const list = document.querySelector('#eventList');
  if (!state.events.length) {
    list.innerHTML = `<div class="empty">暂未发现低价事件</div>`;
    return;
  }

  list.innerHTML = state.events
    .map(
      (event) => `
        <article class="event-item">
          <div>
            <h3>${escapeHtml(monitorTitle(event))}</h3>
            <div class="event-meta">
              <span>${platformLabel(event.platforms || event.platform)}</span>
              <span>识别价 <b class="event-price">¥${money(event.price)}</b></span>
              <span>底价 ¥${money(event.floorPrice)}</span>
              <span>差额 ¥${money(event.gap)}</span>
              <span>${formatTime(event.createdAt)}</span>
              <span>${event.notified ? `已通知${channelLabel(event.notifyChannel)}` : event.notifyError ? `通知失败：${escapeHtml(event.notifyError)}` : '未配置通知'}</span>
            </div>
          </div>
          <div class="actions">
            ${event.url ? `<a class="ghost-btn" href="${escapeAttr(event.url)}" target="_blank" rel="noreferrer">页面</a>` : ''}
            <a class="primary-btn" href="${escapeAttr(event.evidenceUrl)}" target="_blank" rel="noreferrer">证据</a>
          </div>
        </article>
      `
    )
    .join('');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    toast(payload.error || '请求失败');
    throw new Error(payload.error || '请求失败');
  }
  return payload;
}

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function syncPlatformAll() {
  const checkedCount = platformCheckboxes.filter((checkbox) => checkbox.checked).length;
  platformAll.checked = checkedCount === platformCheckboxes.length;
  platformAll.indeterminate = checkedCount > 0 && checkedCount < platformCheckboxes.length;
}

function syncNotificationChannel() {
  const selected = settingsForm.notificationChannel.value || 'feishu';
  channelPanels.forEach((panel) => {
    panel.hidden = panel.dataset.channelPanel !== selected;
  });
}

function platformLabel(platforms) {
  const values = Array.isArray(platforms) ? platforms : [platforms];
  return values.map((platform) => platformNames[platform] || platform).join('、');
}

function monitorTitle(item) {
  return [item.brand, item.productName, item.spec].filter(Boolean).join(' ');
}

function channelLabel(channel) {
  return { feishu: '飞书', dingtalk: '钉钉' }[channel] || '提醒渠道';
}

function priceOrDash(value) {
  return value == null || value === '' ? '-' : `¥${money(value)}`;
}

function discountText(record) {
  const parts = [
    ['券', record.couponAmount],
    ['红包', record.redPacketAmount],
    ['国补', record.subsidyAmount],
    ['估算', record.estimatedDiscount]
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `${label} ¥${money(value)}`);
  return parts.length ? parts.join(' / ') : '未识别';
}

function screenshotLabel(record) {
  if (record.screenshotStatus === 'disabled') return '截图未启用';
  if (record.screenshotStatus === 'failed') return record.screenshotError || '截图失败';
  return '无截图';
}

function collectorText(record) {
  const source = record.collector === 'page' ? '页面抓取' : 'Just One';
  return record.priceSource ? `${source} · ${record.priceSource}` : source;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
