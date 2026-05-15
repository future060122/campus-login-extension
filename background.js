// ============ 默认设置 ============
const DEFAULTS = {
  username: '',
  password: '',
  isp: '@cmcc',
  interval: 30,
  notificationType: 'none',
  detectionUrls: [
    'https://www.baidu.com',
    'https://www.bing.com',
    'https://www.qq.com'
  ],
  pauseThreshold: 15,
  paused: false,
  debugMode: false,
  fastReconnect: false,
  consecutiveFailures: 0,
  status: 'unknown',
  lastCheck: null
};

const GATEWAY_URL = 'http://10.31.0.10';

// ============ 初始化 ============
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  // 保留已有设置，只补充缺失的默认值
  await chrome.storage.local.set({ ...DEFAULTS, ...stored });
  updateIcon('running');
  await startChecking();
});

chrome.runtime.onStartup.addListener(async () => {
  await startChecking();
});

// ============ 防重入 ============
let checkInProgress = false;
let loginInProgress = false;
let debugMode = false; // 缓存，每次检测时刷新

function log() {
  if (debugMode) console.log.apply(console, arguments);
}

// ============ 网络请求工具 ============
async function fetchWithTimeout(url, timeout, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkExternalConnectivity(urls) {
  // 并行检测所有外部网址，任一响应即判定网络正常
  // 总超时 6 秒，避免断网时串行等 5s×3=15s
  return new Promise(function (resolve) {
    var done = false;
    var timeout = setTimeout(function () {
      if (!done) { done = true; resolve(false); }
    }, 5000);

    var pending = urls.length;
    function onDone(ok) {
      if (done) return;
      if (ok) { done = true; clearTimeout(timeout); resolve(true); return; }
      pending--;
      if (pending === 0) { done = true; clearTimeout(timeout); resolve(false); }
    }

    urls.forEach(function (url) {
      fetchWithTimeout(url, 5000, { mode: 'no-cors', cache: 'no-store' })
        .then(function (r) { onDone(r !== null); })
        .catch(function () { onDone(false); });
    });
  });
}

async function checkGatewayState() {
  // 校园网关在本地网络，响应极快（<1s），短超时即可
  const resp = await fetchWithTimeout(GATEWAY_URL, 3000, {
    cache: 'no-store'
  });
  if (!resp) return 'unreachable';

  try {
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buffer);
    if (text.includes('上网登录页')) return 'login_page';
    if (text.includes('登录成功页') || text.includes('注销页')) return 'success_page';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// ============ 检测逻辑 ============
async function runCheck() {
  if (checkInProgress) return;
  checkInProgress = true;

  try {
    const settings = await chrome.storage.local.get(DEFAULTS);
    debugMode = !!settings.debugMode;

    if (settings.paused) return;

    // 第一步：检测校园网关（本地网络，<1s 响应）
    log('[校园网BG] 检查网关...');
    const gatewayState = await checkGatewayState();

    if (gatewayState === 'login_page') {
      log('[校园网BG] 网关应答: 上网登录页');
      await onCampusLoggedOut(settings);
      return;
    }

    if (gatewayState === 'success_page') {
      log('[校园网BG] 网关应答: 登录成功页');
      await onNetworkOk();
      return;
    }

    // 网关 fetch 无响应，通过互联网检测判断
    const internetOk = await checkExternalConnectivity(settings.detectionUrls);

    if (internetOk) {
      log('[校园网BG] 校园网关无响应，互联网已连接');
      await onNetworkOk();
    } else {
      log('[校园网BG] 校园网关无响应，互联网未连接');
      await onCompletelyOffline(settings);
    }
  } finally {
    checkInProgress = false;
  }
}

async function onNetworkOk() {
  loginInProgress = false;
  await chrome.storage.local.set({ pausedNotified: false });
  const { paused } = await chrome.storage.local.get(['paused']);
  await chrome.storage.local.set({
    consecutiveFailures: 0,
    status: 'connected',
    lastCheck: Date.now()
  });
  updateIcon('running');
  updateBadge('', '');

  if (paused) {
    await resumePlugin(false);
  }

  const { interval } = await chrome.storage.local.get({ interval: DEFAULTS.interval });
  await scheduleNextCheck(interval);
}

async function onCampusLoggedOut(settings) {
  log('[校园网BG] 校园网已断线');
  await chrome.storage.local.set({
    consecutiveFailures: 0,
    status: 'logged_out',
    lastCheck: Date.now()
  });
  updateBadge('!', '#FF8C00');

  if (settings.username && settings.password) {
    await triggerAutoLogin();
  }

  if (!fastModeActive) {
    await scheduleNextCheck(settings.interval);
  }
}

async function onCompletelyOffline(settings) {
  const failures = (settings.consecutiveFailures || 0) + 1;
  await chrome.storage.local.set({
    consecutiveFailures: failures,
    status: 'disconnected',
    lastCheck: Date.now()
  });
  updateBadge('X', '#E81123');

  if (failures >= settings.pauseThreshold) {
    await pausePlugin(settings);
  } else {
    await scheduleNextCheck(settings.interval);
  }
}

// ============ 自动登录 ============
async function triggerAutoLogin() {
  if (loginInProgress) return;

  loginInProgress = true;
  log('[校园网BG] 触发自动登录...');

  const timeoutId = setTimeout(() => { loginInProgress = false; }, 30000);

  // 双重标记：storage + URL 参数，确保 content script 能收到
  const loginUrl = GATEWAY_URL + '?campus_auto=' + Date.now();
  await chrome.storage.local.set({ pendingLogin: true, loginTabId: null, loginTimeoutId: timeoutId });

  const existingTabs = await chrome.tabs.query({});
  // 查找已有的校园网关页面（不限于精确 URL，因为可能有 a79.htm 等后缀）
  const gatewayTab = existingTabs.find(t => t.url && t.url.startsWith(GATEWAY_URL));
  log('[校园网BG] 现有标签页:', existingTabs.length, '个, 网关标签页:', !!gatewayTab);

  if (gatewayTab) {
    log('[校园网BG] 刷新已有标签页:', gatewayTab.id);
    await chrome.tabs.update(gatewayTab.id, { active: true });
    await chrome.tabs.update(gatewayTab.id, { url: loginUrl });
    await chrome.storage.local.set({ loginTabId: gatewayTab.id });
  } else {
    log('[校园网BG] 创建新标签页:', loginUrl);
    const tab = await chrome.tabs.create({ url: loginUrl, active: true });
    await chrome.storage.local.set({ loginTabId: tab.id });
  }
}

// ============ 暂停 / 恢复 ============
async function pausePlugin(settings) {
  await chrome.storage.local.set({ paused: true, status: 'paused' });
  updateIcon('paused');
  updateBadge('OFF', '#888888');

  // 每个离线周期只通知一次
  const { pausedNotified } = await chrome.storage.local.get({ pausedNotified: false });
  if (!pausedNotified) {
    await chrome.storage.local.set({ pausedNotified: true });
    await notifyUser(
      '校园网自动登录已暂停',
      '多次检测均无法连接网络。恢复后将自动重试。'
    );
  }

  // 5 分钟后自动重试
  chrome.alarms.create('retry', { delayInMinutes: 5 });
}

async function resumePlugin(notify = true) {
  await chrome.storage.local.set({ paused: false, consecutiveFailures: 0, status: 'connected' });
  updateIcon('running');
  updateBadge('', '');

  if (notify) {
    await notifyUser(
      '校园网自动登录已恢复',
      '插件已恢复定时检测。'
    );
  }

  await chrome.alarms.clear('retry');
  const { interval } = await chrome.storage.local.get({ interval: DEFAULTS.interval });
  await scheduleNextCheck(interval);
}

// ============ 通知 ============
async function notifyUser(title, message) {
  const { notificationType } = await chrome.storage.local.get({ notificationType: DEFAULTS.notificationType });
  if (notificationType === 'system') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message,
      priority: 2
    });
  }
}

// ============ 图标与角标 ============
function updateIcon(state) {
  const suffix = state === 'paused' ? '-paused' : '';
  chrome.action.setIcon({
    path: {
      16: `icons/icon16${suffix}.png`,
      48: `icons/icon48${suffix}.png`,
      128: `icons/icon128${suffix}.png`
    }
  });
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

// ============ 定时器管理 ============
async function scheduleNextCheck(intervalSeconds) {
  await chrome.alarms.clear('check');
  // delayInMinutes 支持小数，实现秒级间隔
  chrome.alarms.create('check', { delayInMinutes: intervalSeconds / 60 });
}

async function startChecking() {
  const { paused } = await chrome.storage.local.get({ paused: DEFAULTS.paused });
  if (paused) return;

  // 检查是否已有定时器
  const existing = await chrome.alarms.get('check');
  if (!existing) {
    const { interval } = await chrome.storage.local.get({ interval: DEFAULTS.interval });
    await scheduleNextCheck(interval);
  }
}

// ============ 快速重连模式 ============
let fastModeActive = false;

async function startFastMode() {
  if (fastModeActive) return;
  fastModeActive = true;
  log('[校园网BG] 快速重连已开启');

  // 调试模式最多开 100 秒，自动关闭以防日志过多
  chrome.alarms.create('debug_off', { delayInMinutes: 100 / 60 });

  await chrome.alarms.clear('check');
  await runFastCheck();
}

async function stopFastMode() {
  if (!fastModeActive) return;
  fastModeActive = false;
  log('[校园网BG] 快速重连已关闭');
  await chrome.alarms.clear('fast_check');
  await chrome.alarms.clear('debug_off');
  await chrome.storage.local.set({ fastReconnect: false });
}

async function runFastCheck() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  debugMode = !!settings.debugMode;
  if (settings.paused) return;

  log('[校园网BG] 检查网关...');
  const gatewayState = await checkGatewayState();

  if (gatewayState === 'login_page') {
    log('[校园网BG] 网关应答: 上网登录页');
    await onCampusLoggedOut(settings);
  } else if (gatewayState === 'success_page') {
    log('[校园网BG] 网关应答: 登录成功页');
  } else {
    log('[校园网BG] 校园网关无响应');
  }

  chrome.alarms.create('fast_check', { delayInMinutes: 1 / 60 });
}

// ============ 事件监听 ============
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check') {
    await runCheck();
  } else if (alarm.name === 'retry') {
    await runCheck();
  } else if (alarm.name === 'fast_check') {
    await runFastCheck();
  } else if (alarm.name === 'debug_off') {
    await chrome.storage.local.set({ debugMode: false });
    log('[校园网BG] 调试模式已自动关闭');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // 异步响应
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'check_now':
      await chrome.storage.local.set({ consecutiveFailures: 0 });
      await runCheck();
      const status = await chrome.storage.local.get(['status', 'lastCheck', 'paused', 'consecutiveFailures']);
      return { success: true, ...status };

    case 'get_status':
      const s = await chrome.storage.local.get(['status', 'lastCheck', 'paused', 'consecutiveFailures', 'interval']);
      const retryAlarm = await chrome.alarms.get('retry');
      return { ...s, retryScheduled: !!retryAlarm };

    case 'pause':
      // 手动暂停：永久，不自动重试
      await chrome.storage.local.set({ paused: true, status: 'paused' });
      updateIcon('paused');
      updateBadge('OFF', '#888888');
      return { success: true };

    case 'resume':
      await resumePlugin(true);
      return { success: true };

    case 'settings_changed': {
      const s2 = await chrome.storage.local.get(DEFAULTS);
      if (s2.fastReconnect) {
        await startFastMode();
      } else {
        await stopFastMode();
        await scheduleNextCheck(s2.interval);
      }
      return { success: true };
    }

    case 'fill_and_call_ee':
      // 在页面 MAIN world 中原子操作：填表 + 调用 ee(1)
      // 填表和调用在同一个同步块中，不会被页面 JS 打断
      if (sender.tab && sender.tab.id) {
        try {
          var results = await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            args: [message.username, message.password, message.isp],
            func: function (username, password, isp) {
              if (!username || !password) return 'no_creds';

              var uf = document.querySelector('form[name="f1"] input[name="DDDDD"]');
              var pf = document.querySelector('form[name="f1"] input[name="upass"]');
              if (uf) { uf.value = username; }
              if (pf) { pf.value = password; }
              if (isp) {
                var radio = document.querySelector('input[name="network"][value="' + isp + '"]');
                if (radio) { radio.checked = true; }
              }

              if (typeof ee === 'function') {
                ee(1);
                return 'called';
              }
              return 'not_found';
            }
          });
          return { result: results[0].result };
        } catch (e) {
          console.error('[校园网BG] executeScript 失败:', e);
          return { error: e.message };
        }
      }
      return { error: 'no tab' };

    case 'login_result': {
      const { loginTabId, loginTimeoutId } = await chrome.storage.local.get({ loginTabId: null, loginTimeoutId: null });
      if (loginTimeoutId) clearTimeout(loginTimeoutId);
      loginInProgress = false;
      if (message.success) {
        log('[校园网BG] 登录成功，清理标签页');
        await chrome.storage.local.set({ status: 'connected', consecutiveFailures: 0 });
        updateBadge('', '');
        updateIcon('running');
        if (loginTabId) {
          try { await chrome.tabs.remove(loginTabId); } catch {}
          await chrome.storage.local.set({ loginTabId: null });
        }
        // 跳过网络恢复的过渡窗口
        await scheduleNextCheck(3);
      } else {
        log('[校园网BG] 登录未成功，等待下次检测周期重试');
        // 不立即重试，让正常检测周期处理（有 60s 冷却）
      }
      return { received: true };
    }

    default:
      return { error: 'unknown message type' };
  }
}
