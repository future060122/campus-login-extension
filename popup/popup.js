// ============ 元素引用 ============
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const lastCheck = document.getElementById('lastCheck');
const nextCheck = document.getElementById('nextCheck');
const nextCheckRow = document.getElementById('nextCheckRow');

const elUsername = document.getElementById('username');
const elPassword = document.getElementById('password');
const elInterval = document.getElementById('interval');
const elNotification = document.getElementById('notificationType');
const elTogglePw = document.getElementById('togglePw');
const elDebug = document.getElementById('debugMode');
const elFast = document.getElementById('fastReconnect');

const btnCheck = document.getElementById('btnCheck');
const btnPause = document.getElementById('btnPause');

let nextCheckTime = null;
let pollTimer = null;
let saveTimer = null;

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 3000);
  // 自动保存：所有表单控件变更时触发
  document.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', autoSave);
    if (el.type === 'text' || el.type === 'password') {
      el.addEventListener('input', autoSave);
    }
  });
});

// ============ 加载设置到表单 ============
async function loadSettings() {
  const items = await chrome.storage.local.get({
    username: '',
    password: '',
    isp: '@cmcc',
    interval: 30,
    notificationType: 'none',
    paused: false,
    debugMode: false,
    fastReconnect: false
  });

  elUsername.value = items.username || '';
  elPassword.value = items.password || '';
  elInterval.value = String(items.interval);
  elNotification.value = items.notificationType;
  elDebug.checked = !!items.debugMode;
  elFast.checked = !!items.fastReconnect;
  updateFastUI(items.fastReconnect);

  const radio = document.querySelector(`input[name="isp"][value="${items.isp}"]`);
  if (radio) radio.checked = true;

  updatePauseButton(items.paused);
}

function updateFastUI(active) {
  elInterval.disabled = active;
  elNotification.disabled = active;
}

// ============ 自动保存 ============
async function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const isp = document.querySelector('input[name="isp"]:checked');
    await chrome.storage.local.set({
      username: elUsername.value.trim(),
      password: elPassword.value,
      isp: isp ? isp.value : '@cmcc',
      interval: parseInt(elInterval.value) || 30,
      notificationType: elNotification.value,
      debugMode: elDebug.checked,
      fastReconnect: elFast.checked
    });
    updateFastUI(elFast.checked);
    // 检测间隔变更后需要重置定时器
    chrome.runtime.sendMessage({ type: 'settings_changed' }).catch(() => {});
    showToast('已保存');
  }, 400);
}

// ============ 刷新状态显示 ============
async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (!resp) return;

    updateStatusUI(resp.status, resp.paused);
    updatePauseButton(resp.paused);

    if (resp.lastCheck) {
      lastCheck.textContent = formatTime(new Date(resp.lastCheck));
    }

    if (!resp.paused && resp.interval && resp.lastCheck) {
      nextCheckTime = new Date(resp.lastCheck + resp.interval * 1000);
      nextCheck.textContent = formatTime(nextCheckTime);
      nextCheckRow.style.display = '';
    } else if (resp.paused) {
      nextCheck.textContent = '已暂停';
      nextCheckRow.style.display = '';
    } else {
      nextCheckRow.style.display = 'none';
    }
  } catch {
    // 后台脚本未就绪，忽略
  }
}

function updateStatusUI(status, paused) {
  statusDot.className = 'status-dot';
  if (paused) {
    statusDot.classList.add('paused');
    statusText.textContent = '已暂停';
    statusText.className = 'status-value warn';
  } else {
    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        statusText.textContent = '网络正常';
        statusText.className = 'status-value ok';
        break;
      case 'logged_out':
        statusDot.classList.add('logged_out');
        statusText.textContent = '已断线，正在重连';
        statusText.className = 'status-value warn';
        break;
      case 'disconnected':
        statusDot.classList.add('disconnected');
        statusText.textContent = '网络已断开';
        statusText.className = 'status-value warn';
        break;
      case 'paused':
        statusDot.classList.add('paused');
        statusText.textContent = '已暂停';
        statusText.className = 'status-value warn';
        break;
      default:
        statusText.textContent = '检测中...';
        statusText.className = 'status-value';
    }
  }
}

function updatePauseButton(paused) {
  if (paused) {
    btnPause.textContent = '恢复插件';
    btnPause.className = 'btn btn-outline resume';
  } else {
    btnPause.textContent = '暂停插件';
    btnPause.className = 'btn btn-outline';
  }
}

// ============ 立即检测 ============
btnCheck.addEventListener('click', async () => {
  btnCheck.disabled = true;
  btnCheck.textContent = '检测中...';
  showToast('正在检测网络状态...');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'check_now' });
    if (resp && resp.success) {
      updateStatusUI(resp.status, resp.paused);
      updatePauseButton(resp.paused);
      if (resp.lastCheck) {
        lastCheck.textContent = formatTime(new Date(resp.lastCheck));
      }
    }
  } catch (e) {
    showToast('检测失败');
  }
  btnCheck.disabled = false;
  btnCheck.textContent = '立即检测';
});

// ============ 暂停 / 恢复 ============
btnPause.addEventListener('click', async () => {
  const { paused } = await chrome.storage.local.get({ paused: false });
  const action = paused ? 'resume' : 'pause';
  try {
    await chrome.runtime.sendMessage({ type: action });
    await refreshStatus();
  } catch (e) {
    showToast('操作失败');
  }
});

// ============ 密码显示切换 ============
elTogglePw.addEventListener('click', () => {
  const showing = elPassword.type === 'text';
  elPassword.type = showing ? 'password' : 'text';
  elTogglePw.querySelector('.eye-open').style.display = showing ? '' : 'none';
  elTogglePw.querySelector('.eye-closed').style.display = showing ? 'none' : '';
});

// ============ 工具函数 ============
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 1800);
}
