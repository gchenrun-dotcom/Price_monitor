const state = {
  monitors: [],
  events: [],
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
  no_price: '未识别价格',
  missing_url: '待补链接'
};

const monitorForm = document.querySelector('#monitorForm');
const settingsForm = document.querySelector('#settingsForm');
const scanNowBtn = document.querySelector('#scanNowBtn');
const platformAll = document.querySelector('#platformAll');
const platformCheckboxes = [...document.querySelectorAll('input[name="platforms"]')];

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
  data.enableRealScreenshot = form.has('enableRealScreenshot');
  if (data.feishuSecret === '********') delete data.feishuSecret;
  await api('/api/settings', { method: 'PATCH', body: data });
  toast('设置已保存');
  await refresh();
});

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
    if (!confirm(`删除“${monitor.productName}”？`)) return;
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
      ? '后台正在巡检商品链接'
      : `每 ${state.settings.scanIntervalSeconds || 300} 秒自动巡检一次`;
}

function renderSettings() {
  settingsForm.feishuWebhook.value = state.settings.feishuWebhook || '';
  settingsForm.feishuSecret.value = state.settings.feishuSecret || '';
  settingsForm.feishuAtUserIds.value = state.settings.feishuAtUserIds || '';
  settingsForm.scanIntervalSeconds.value = state.settings.scanIntervalSeconds || 300;
  settingsForm.feishuAtAll.checked = Boolean(state.settings.feishuAtAll);
  settingsForm.enableRealScreenshot.checked = Boolean(state.settings.enableRealScreenshot);
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
            ${monitor.url ? `<a href="${escapeAttr(monitor.url)}" target="_blank" rel="noreferrer">${escapeHtml(monitor.productName)}</a>` : `<strong>${escapeHtml(monitor.productName)}</strong>`}
            <small>${escapeHtml(monitor.brand || '未填写品牌')} · ${escapeHtml(monitor.notes || '无备注')}</small>
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
            <h3>${escapeHtml(event.productName)}</h3>
            <div class="event-meta">
              <span>${platformLabel(event.platforms || event.platform)}</span>
              <span>识别价 <b class="event-price">¥${money(event.price)}</b></span>
              <span>底价 ¥${money(event.floorPrice)}</span>
              <span>差额 ¥${money(event.gap)}</span>
              <span>${formatTime(event.createdAt)}</span>
              <span>${event.notified ? '已通知飞书' : event.notifyError ? `通知失败：${escapeHtml(event.notifyError)}` : '未配置通知'}</span>
            </div>
          </div>
          <div class="actions">
            <a class="ghost-btn" href="${escapeAttr(event.url)}" target="_blank" rel="noreferrer">商品</a>
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

function platformLabel(platforms) {
  const values = Array.isArray(platforms) ? platforms : [platforms];
  return values.map((platform) => platformNames[platform] || platform).join('、');
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
