// ============ 校园网登录页自动填表 ============

(function () {
  if (!document.title.includes('上网登录页')) return;

  chrome.storage.local.get(
    ['pendingLogin', 'username', 'password', 'isp', 'debugMode'],
    async function (items) {

    var log = items.debugMode ? console.log.bind(console) : function () {};

    if (!items.username || !items.password) {
      if (items.pendingLogin) chrome.storage.local.set({ pendingLogin: false });
      return;
    }

    // 手动访问：仅预填
    var isAuto = location.search.indexOf('campus_auto=') !== -1;
    if (!isAuto && !items.pendingLogin) {
      prefillForm(items.username, items.password, items.isp);
      log('[校园网] 手动访问，仅预填');
      return;
    }

    if (window.__campusLoginDone) return;
    window.__campusLoginDone = true;

    log('[校园网] 自动登录启动');
    chrome.storage.local.set({ pendingLogin: false });

    // 轮询：让背景脚本在 MAIN world 中填表+调用 ee(1)（原子操作）
    var start = Date.now();
    var called = false;
    while (Date.now() - start < 20000) {
      try {
        var resp = await chrome.runtime.sendMessage({
          type: 'fill_and_call_ee',
          username: items.username,
          password: items.password,
          isp: items.isp
        });
        if (resp && resp.result === 'called') {
          log('[校园网] ee(1) 已调用（耗时 ' + (Date.now() - start) + 'ms）');
          called = true;
          break;
        }
        if (resp && resp.result === 'no_creds') break;
      } catch (e) { /* 重试 */ }
      await sleep(500);
    }

    if (!called) {
      log('[校园网] 登录未执行');
      chrome.runtime.sendMessage({ type: 'login_result', success: false, error: 'ee() 未就绪' }).catch(function () {});
      return;
    }

    // 等结果
    var result = await watchResult(8000);
    log('[校园网] 登录' + (result ? '成功' : '未确认'));
    chrome.runtime.sendMessage({ type: 'login_result', success: result, error: result ? '' : '未确认' }).catch(function () {});
  });
})();

// ============ 手动预填（仅填 DOM，不调用 ee） ============

function prefillForm(username, password, isp) {
  var uf = document.querySelector('form[name="f1"] input[name="DDDDD"]');
  var pf = document.querySelector('form[name="f1"] input[name="upass"]');
  if (uf) uf.value = username;
  if (pf) pf.value = password;
  if (isp) {
    var radio = document.querySelector('input[name="network"][value="' + isp + '"]');
    if (radio) radio.checked = true;
  }
  log('[校园网] 表单已预填');
}

// ============ 工具 ============

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function watchResult(timeout) {
  return new Promise(function (resolve) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (document.title.includes('登录成功页')) {
        clearInterval(timer); resolve(true);
      } else if (document.title.includes('登录失败页')) {
        clearInterval(timer); resolve(false);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        resolve(!document.title.includes('上网登录页'));
      }
    }, 500);
  });
}
