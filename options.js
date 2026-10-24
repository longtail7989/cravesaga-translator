'use strict';
(() => {
  const DEFAULTS = Object.freeze({provider:'openai',endpoint:'https://api.openai.com/v1',model:'',apiKey:'',target:'한국어',enabled:false,consent:false,cacheOnly:false,cacheEnabled:true,translateLatin:true,fontFamily:'Malgun Gothic',maxBatchChars:6000,dailyCharLimit:0,dailyRequestLimit:0,maxOutputTokens:4096,requestTimeoutSeconds:180,retryLimit:0});
  const PRESETS = Object.freeze({chatgpt:'https://api.openai.com/v1',openai:'https://api.openai.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta',anthropic:'https://api.anthropic.com/v1',custom:'http://127.0.0.1:1234/v1'});
  const FIELDS = Object.keys(DEFAULTS);
  const MAX_CACHE_BYTES = 32 * 1024 * 1024; // Small legacy whole-JSON fallback only.
  const IMPORT_BATCH_SIZE = 250;
  const IMPORT_BATCH_BYTES = 1024 * 1024;
  const MAX_LINE_CHARS = 4 * 1024 * 1024;
  const $ = id => document.getElementById(id);
  const form = $('settingsForm');
  let busy = false;
  let loaded = false;
  let activeImportToken = null;
  let activeExportToken = null;
  let unloadCleanupSent = false;
  function cleanupTransferSessions() {
    if (unloadCleanupSent || !globalThis.chrome?.runtime?.sendMessage) return;
    unloadCleanupSent = true;
    const sessions = [];
    if (activeImportToken) sessions.push({type:'IMPORT_ABORT',token:activeImportToken});
    if (activeExportToken) sessions.push({type:'EXPORT_END',token:activeExportToken});
    for (const message of sessions) {
      try { chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }); } catch (_) { /* Backend TTL is the final fallback. */ }
    }
  }
  window.addEventListener('beforeunload',cleanupTransferSessions);
  window.addEventListener('pagehide',cleanupTransferSessions);
  const numberFormat = new Intl.NumberFormat('ko-KR');

  function safeText(value, context) {
    let text = String(value ?? '');
    const secrets = [context?.apiKey,$('apiKey').value].filter(Boolean);
    for (const secret of secrets) text = text.split(secret).join('[인증값 숨김]');
    text = text.replace(/(?:Bearer\s+)[^\s"<>]+/gi,'[인증값 숨김]');
    text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[인증값 숨김]');
    return text;
  }
  function status(message, tone = 'info', context) {
    $('status').textContent = safeText(message, context);
    $('status').dataset.tone = tone;
  }
  function fail(error, context) {
    const detail = typeof error === 'string' ? error : error?.message;
    status(detail ? '요청 실패: ' + safeText(detail, context) : '요청에 실패했습니다. 서버 주소, 권한, 인증 및 모델 설정을 확인하세요.', 'error', context);
  }
  function send(type, payload = {}) {
    return new Promise((resolve,reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) { reject(new Error('확장 프로그램의 설정 페이지에서 열어 주세요.')); return; }
      try {
        chrome.runtime.sendMessage({type,...payload}, response => {
          if (chrome.runtime.lastError) { reject(new Error('확장 프로그램과 연결하지 못했습니다. 확장 프로그램을 다시 로드하고 설정을 다시 열어 주세요.')); return; }
          if (!response || response.ok !== true) { reject(new Error(typeof response?.error === 'string' ? response.error : '서버가 요청을 처리하지 못했습니다.')); return; }
          resolve(response);
        });
      } catch (_) { reject(new Error('확장 프로그램과 연결할 수 없습니다. 설정 페이지를 다시 열어 주세요.')); }
    });
  }
  let chatgptState = null;
  let authBusy = false;
  let nativePermissionPending = false;
  let authTimer = null;
  let popupClosed = false;
  function stopAuthPolling() { popupClosed = true; if (authTimer !== null) clearTimeout(authTimer); authTimer = null; }
  window.addEventListener('beforeunload',stopAuthPolling);
  window.addEventListener('pagehide',stopAuthPolling);
  function scheduleAuthPoll() {
    if (authTimer !== null) clearTimeout(authTimer);
    authTimer = null;
    if (!popupClosed && $('provider').value === 'chatgpt' && chatgptState?.loginPending) authTimer = setTimeout(() => { authTimer = null; void chatgptAuth('CHATGPT_AUTH_STATUS'); },2000);
  }
  function renderChatgpt() {
    const state = chatgptState;
    const pending = state?.loginPending === true;
    const profiles = Array.isArray(state?.profiles) ? state.profiles.filter(p => typeof p?.id === 'string') : [];
    let message = '상태 확인을 눌러 로컬 도우미와 계정 연결 상태를 확인하세요.';
    let tone = 'info';
    if (state) {
      if (!state.available && ['NATIVE_RELOAD_REQUIRED','NATIVE_RELOAD_BUSY'].includes(state.errorCode)) { message = state.errorCode === 'NATIVE_RELOAD_BUSY' ? '진행 중 번역이 끝나면 Continue with ChatGPT를 다시 누르세요. 연결 권한을 갱신하며 도우미 재설치는 필요하지 않습니다.' : '새로 허용한 권한을 적용해야 합니다. Continue with ChatGPT를 다시 누르면 연결을 갱신합니다. 도우미 재설치는 필요하지 않습니다.'; tone = 'info'; }
      else if (!state.available && state.errorCode === 'NATIVE_PERMISSION_REQUIRED') { message = '설치가 끝났다면 Continue with ChatGPT를 누르세요. 처음 한 번 로컬 도우미 연결 권한을 요청한 뒤 공식 로그인을 시작합니다.'; tone = 'info'; }
      else if (!state.available) { message = 'ChatGPT 로컬 도우미가 없거나 연결할 수 없습니다. 동봉된 설치 안내에 따라 도우미를 설치·연결한 뒤 상태 확인을 누르세요.'; tone = 'warning'; }
      else if (pending) message = '공식 ChatGPT 페이지에서 로그인·승인을 완료하세요. 대기 중이며 번역 요청은 보내지 않습니다. 팝업을 닫아도 로그인은 계속됩니다.';
      else if (!state.connected) { message = '연결된 ChatGPT 계정이 없습니다. Continue with ChatGPT로 공식 로그인·승인을 시작하세요.'; tone = 'warning'; }
      else if (!state.planEnabled) { message = '계정은 연결되었지만 번역에 필요한 플랜 사용 권한이 승인되지 않았습니다. 공식 로그인에서 권한을 확인하세요. 모델 이용 자격은 확인되지 않았습니다.'; tone = 'warning'; }
      else { message = '계정 연결 및 플랜 사용 권한 승인이 확인되었습니다. 모델을 조회하고 설정을 저장하세요. 특정 모델 이용 자격·사용량 잔여를 보장하지 않습니다.'; tone = 'success'; }
      if (state.errorCode && state.available && !pending && (!state.connected || !state.planEnabled)) message += ' 승인에 실패했다면 다시 로그인하거나 상태를 확인하세요.';
    }
    $('chatgptAuthStatus').textContent = message;
    $('chatgptAuthStatus').dataset.tone = tone;
    $('chatgptProfileField').hidden = profiles.length === 0;
    const options = profiles.map(profile => { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.label || profile.email || 'ChatGPT 계정'; return option; });
    $('chatgptProfile').replaceChildren(...options);
    if (typeof state?.activeProfileId === 'string') $('chatgptProfile').value = state.activeProfileId;
    $('chatgptLogin').disabled = busy || !loaded || authBusy || nativePermissionPending || pending;
    $('chatgptAddAccount').hidden = profiles.length === 0;
    $('chatgptAddAccount').disabled = busy || !loaded || authBusy || nativePermissionPending || pending;
    $('chatgptCancel').hidden = !pending;
    $('chatgptCancel').disabled = busy || !loaded || authBusy;
    $('chatgptRefresh').disabled = busy || !loaded || authBusy;
    $('chatgptLogout').hidden = !state?.connected;
    $('chatgptLogout').disabled = busy || !loaded || authBusy;
    $('chatgptProfile').disabled = busy || !loaded || authBusy || pending;
    if ($('provider').value === 'chatgpt') $('loadModels').disabled = busy || !loaded || authBusy || !state?.connected || !state?.planEnabled || pending;
  }
  async function chatgptAuth(type, payload = {}) {
    if (popupClosed || !loaded || $('provider').value !== 'chatgpt') return;
    if (authBusy || busy) { if (type === 'CHATGPT_AUTH_STATUS') scheduleAuthPoll(); return; }
    authBusy = true;
    renderChatgpt();
    try {
      const response = await send(type,payload);
      if (type === 'CHATGPT_AUTH_START' && response.state?.errorCode === 'NATIVE_RELOAD_REQUIRED') {
        const rebound = await send('CHATGPT_AUTH_REBIND',payload);
        if (rebound.reloading === true) { $('chatgptAuthStatus').textContent = '연결 권한을 갱신하고 공식 로그인을 이어갑니다. 게임 탭은 새로고침하지 않습니다.'; return; }
        response.state = rebound.state;
      }
      if (!response.state || typeof response.state.available !== 'boolean') throw new Error('invalid auth state');
      chatgptState = response.state;
      renderChatgpt();
    } catch (_) {
      $('chatgptAuthStatus').textContent = '연결 상태를 확인하지 못했습니다. 로컬 도우미 설치·연결을 확인하고 상태 확인을 다시 누르세요. 기존 설정은 변경하지 않았습니다.';
    } finally { authBusy = false; renderChatgptButtons(); scheduleAuthPoll(); }
  }
  function renderChatgptButtons() {
    // Keep a sanitized failure message in place while re-enabling the controls.
    const message = $('chatgptAuthStatus').textContent;
    renderChatgpt();
    $('chatgptAuthStatus').textContent = message;
  }
  function startChatgptLogin(newProfile = false) {
    if (popupClosed || busy || authBusy || nativePermissionPending || !loaded || $('provider').value !== 'chatgpt' || chatgptState?.loginPending) return;
    if (newProfile && !chatgptState?.profiles?.some(p => typeof p?.id === 'string')) return;
    const payload = newProfile ? {newProfile:true} : chatgptState?.activeProfileId ? {profileId:chatgptState.activeProfileId} : {};
    if (!globalThis.chrome?.permissions?.request) {
      $('chatgptAuthStatus').textContent = '로컬 도우미 연결 권한을 요청할 수 없습니다. 설치된 확장 프로그램에서 다시 시도하세요.';
      return;
    }
    nativePermissionPending = true;
    renderChatgptButtons();
    // Must stay directly in the explicit click event, before any awaited work.
    try {
      chrome.permissions.request({permissions:['nativeMessaging']},granted => {
        const permissionError = chrome.runtime.lastError;
        nativePermissionPending = false;
        renderChatgptButtons();
        if (permissionError || !granted) {
          $('chatgptAuthStatus').textContent = '로컬 도우미 연결 권한이 허용되지 않아 로그인을 시작하지 않았습니다. 기존 설정은 변경하지 않았습니다.';
          return;
        }
        void chatgptAuth('CHATGPT_AUTH_START',payload);
      });
    } catch (_) {
      nativePermissionPending = false;
      renderChatgptButtons();
      $('chatgptAuthStatus').textContent = '로컬 도우미 연결 권한을 요청하지 못했습니다. 로그인과 설정 변경은 하지 않았습니다.';
    }
  }
  $('chatgptLogin').addEventListener('click',() => startChatgptLogin(false));
  $('chatgptAddAccount').addEventListener('click',() => startChatgptLogin(true));
  $('chatgptCancel').addEventListener('click',() => { void chatgptAuth('CHATGPT_AUTH_CANCEL'); });
  $('chatgptRefresh').addEventListener('click',() => { void chatgptAuth('CHATGPT_AUTH_STATUS'); });
  $('chatgptLogout').addEventListener('click',() => { void chatgptAuth('CHATGPT_AUTH_LOGOUT',chatgptState?.activeProfileId ? {profileId:chatgptState.activeProfileId} : {}); });
  $('chatgptProfile').addEventListener('change',() => { const profileId = $('chatgptProfile').value; if (chatgptState?.profiles?.some(p => p.id === profileId)) void chatgptAuth('CHATGPT_AUTH_SELECT',{profileId}); });
  function syncProvider() {
    $('retryLimitHelp').textContent = '0은 일시적 연결·응답 지연 등의 재시도 횟수 제한 없음, 1~20은 최초 요청 이후 최대 재시도 횟수입니다. 점차 긴 대기 시간을 두며, 형식·검증·모델 출력 품질 오류는 최대 3회 실패 후 중단합니다. 인증·접근 권한 등 영구 오류는 재시도하지 않습니다.';
    const chatgpt = $('provider').value === 'chatgpt';
    const cacheOnly = $('cacheOnly').checked;
    $('endpointField').hidden = chatgpt;
    $('endpoint').disabled = chatgpt;
    $('endpoint').required = !chatgpt;
    $('chatgptAccount').hidden = !chatgpt;
    $('apiKeyField').hidden = chatgpt;
    $('apiKey').disabled = chatgpt;
    $('providerStatus').textContent = chatgpt ? 'ChatGPT 공식 로그인 · 로컬 도우미 사용. 로그인만으로 번역 제공자를 변경하지 않습니다.' : '공식 API 또는 호환 서버 연결 · 기존 설정은 저장 전까지 유지됩니다.';
    $('model').placeholder = chatgpt ? '로그인 후 모델 목록 조회' : '모델 ID 직접 입력';
    $('loadModels').textContent = chatgpt ? '모델 목록 조회' : '목록 조회';
    $('testConnection').textContent = chatgpt ? '구독 사용량 사용 · 연결 테스트' : '유료 요청 가능 · 연결 테스트';
    $('model').required = !cacheOnly && (!chatgpt || $('enabled').checked);
    $('apiKey').required = !cacheOnly && !chatgpt && $('provider').value !== 'custom';
    $('testConnection').disabled = busy || !loaded || cacheOnly;
    $('testWarning').textContent = cacheOnly ? '캐시 전용 모드에서는 연결 테스트를 하지 않습니다. AI 연결을 시험하려면 캐시 전용 모드를 먼저 끄고 인증 정보와 전송 동의를 확인하세요.' : '테스트는 실제 API를 호출하며 비용 또는 구독 사용량이 발생할 수 있습니다.';
    if(chatgpt&&!cacheOnly)$('testWarning').textContent='명시적으로 동의한 게임 텍스트로 실제 번역 요청을 보냅니다. 구독 사용량과 제공자 이용 조건이 적용됩니다.';
    $('keyRequirement').textContent = $('provider').value === 'custom' ? '서버에서 요구하는 경우에만 입력' : '공식 API 인증';
    renderChatgpt();
    $('modelHelp').textContent = chatgpt ? '로그인·권한 승인 후 직접 목록을 조회하세요. 사용 설정을 켜거나 테스트하려면 모델 ID가 필요합니다. 목록은 모델 이용 자격이나 잔여량을 보장하지 않습니다.' : '모델 ID를 직접 입력하거나 목록에서 선택하세요. 모델 목록을 지원하지 않는 서버에서는 직접 입력하면 됩니다.';
  }
  function setBusy(value) {
    busy = value;
    for (const fieldset of document.querySelectorAll('[data-lock]')) fieldset.disabled = value || !loaded;
    for (const button of document.querySelectorAll('[data-action]')) button.disabled = value || !loaded;
    form.setAttribute('aria-busy', String(value || !loaded));
    document.dispatchEvent(new CustomEvent('settingsbusy',{detail:{busy:value || !loaded}}));
    if (!value) syncProvider();
  }
  function applySettings(raw = {}) {
    const settings = {...DEFAULTS,...raw};
    if (!Object.hasOwn(PRESETS,settings.provider)) { settings.provider = DEFAULTS.provider; settings.enabled = false; settings.consent = false; settings.model = ''; settings.apiKey = ''; settings.endpoint = DEFAULTS.endpoint; }
    for (const name of FIELDS) {
      const field = $(name);
      if (field.type === 'checkbox') field.checked = typeof settings[name] === 'boolean' ? settings[name] : DEFAULTS[name];
      else field.value = typeof settings[name] === 'string' || typeof settings[name] === 'number' ? String(settings[name]) : String(DEFAULTS[name]);
      field.removeAttribute('aria-invalid');
    }
    $('savedState').textContent = settings.enabled === true ? '저장된 상태 · 켜짐' : '저장된 상태 · 꺼짐';
    $('savedState').classList.toggle('active', settings.enabled === true);
    $('savedState').classList.remove('dirty');
    if ($('saveHint')) $('saveHint').textContent = '변경 사항은 저장해야 적용됩니다. 닫으면 저장하지 않은 입력은 사라집니다.';
    syncProvider();
  }
  function displayUsage(usage, count) {
    const chars = Number(usage?.chars);
    $('usageChars').textContent = Number.isFinite(chars) && chars >= 0 ? numberFormat.format(chars) + ' 자' : '확인 불가';
    $('cacheCount').textContent = Number.isSafeInteger(count) && count >= 0 ? numberFormat.format(count) + ' 개' : '확인 불가';
    const requests = Number(usage?.requests);
    const date = typeof usage?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(usage.date) ? usage.date + ' · ' : '';
    $('usageDetail').textContent = date + (Number.isFinite(requests) && requests >= 0 ? numberFormat.format(requests) + '회 요청. ' : '') + '실패한 전송 시도와 재시도도 포함합니다. 자동 재시도 한도 0은 일시적 연결 오류 등의 횟수 제한 없음이며, 응답 형식·번역 검증·모델 출력 품질 오류는 최대 3회 실패 후 중단합니다. 하루 글자·요청 한도는 각각 0이면 제한하지 않습니다. 기기 현지 날짜에 초기화되는 로컬 측정값으로 금액 상한이 아니며, 제공자 측 한도·과금은 그대로 적용됩니다.';
  }
  function invalid(id, message) {
    const field = $(id);
    field.setAttribute('aria-invalid','true');
    status(message,'error');
    document.dispatchEvent(new CustomEvent('settingsinvalid',{detail:{field:id}}));
    field.focus();
    return null;
  }
  function collect(action) {
    for (const name of FIELDS) $(name).removeAttribute('aria-invalid');
    const settings = {};
    for (const name of FIELDS) settings[name] = $(name).type === 'checkbox' ? $(name).checked : $(name).value.trim();
    if (action === 'TEST' && settings.cacheOnly) return invalid('cacheOnly','연결 테스트를 하려면 캐시 전용 모드를 먼저 끄세요. API 인증 정보와 전송 동의도 필요합니다.');
    const chatgpt = settings.provider === 'chatgpt';
    if (chatgpt) { settings.endpoint = PRESETS.chatgpt; settings.apiKey = ''; }
    const cacheOnlySave = action === 'SAVE_SETTINGS' && settings.cacheOnly;
    if (!Object.hasOwn(PRESETS,settings.provider)) return invalid('provider','지원하는 제공자를 선택하세요.');
    let url;
    try { url = new URL(settings.endpoint); } catch (_) { return invalid('endpoint','서버의 올바른 전체 주소를 입력하세요.'); }
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return invalid('endpoint','HTTPS 주소를 사용하세요. HTTP는 127.0.0.1, localhost, [::1]에서만 허용됩니다.');
    if (url.username || url.password || url.search || url.hash) return invalid('endpoint','서버 주소에 인증값, 쿼리 또는 # 조각을 넣지 마세요. 인증값은 전용 입력란을 사용하세요.');
    settings.endpoint = url.href.replace(/\/+$/,'');
    if (!cacheOnlySave && !settings.model && action !== 'LIST_MODELS' && (!chatgpt || settings.enabled || action === 'TEST')) return invalid('model','이 제공자에서는 모델 ID가 필요합니다. 목록을 조회하거나 직접 입력하세요.');
    if (!cacheOnlySave && settings.provider !== 'custom' && !chatgpt && !settings.apiKey) return invalid('apiKey','선택한 제공자의 공식 API 키를 입력하세요. 구독 계정의 비밀번호는 사용할 수 없습니다.');
    if (settings.model.length > 200) return invalid('model','모델 ID는 200자 이내로 입력하세요.');
    if (!settings.target || settings.target.length > 64) return invalid('target','번역 대상 언어를 64자 이내로 입력하세요.');
    if (!settings.fontFamily || settings.fontFamily.length > 100) return invalid('fontFamily','기기에 설치된 글꼴 이름을 100자 이내로 입력하세요.');
    for (const name of ['maxBatchChars','dailyCharLimit','dailyRequestLimit','maxOutputTokens','requestTimeoutSeconds','retryLimit']) {
      const value = Number(settings[name]);
      const max = Number($(name).max);
      const min = Number($(name).min);
      if (settings[name] === '' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(name, '설정값은 ' + numberFormat.format(min) + '부터 ' + numberFormat.format(max) + ' 사이의 정수로 입력하세요.');
      settings[name] = value;
    }
    if (!cacheOnlySave && (settings.enabled || action === 'TEST') && !settings.consent) return invalid('consent','자동 번역 또는 연결 테스트를 사용하려면 텍스트 전송과 비용·사용량 안내에 동의해야 합니다.');
    return settings;
  }

  // Called synchronously from the user's click/submit event: no awaited work
  // or runtime messages may precede the optional host permission request.
  function requestHostAndRun(settings, action) {
    setBusy(true);
    if (settings.provider === 'chatgpt') { Promise.resolve().then(action).catch(error => fail(error,settings)).finally(() => setBusy(false)); return; }
    status('서버 접근 권한을 확인하고 있습니다.');
    const origin = new URL(settings.endpoint).origin + '/*';
    if (!globalThis.chrome?.permissions?.request) { setBusy(false); fail('서버 권한을 요청할 수 없습니다. 설치된 확장 프로그램에서 다시 시도하세요.'); return; }
    try {
      chrome.permissions.request({origins:[origin]}, granted => {
        const permissionError = chrome.runtime.lastError;
        if (permissionError || !granted) {
          setBusy(false);
          status('서버 접근 권한이 허용되지 않았습니다. 설정은 저장되지 않았고 API 요청도 보내지 않았습니다.','warning');
          return;
        }
        Promise.resolve().then(action).catch(error => fail(error,settings)).finally(() => setBusy(false));
      });
    } catch (_) { setBusy(false); fail('서버 접근 권한 요청에 실패했습니다. 확장 프로그램을 다시 로드하거나 주소를 확인하세요.'); }
  }
  async function refreshUsage() {
    const response = await send('GET_SETTINGS');
    displayUsage(response.usage,response.cacheCount);
  }
  function save(event) {
    event.preventDefault();
    if ($('panel-editor') && !$('panel-editor').hidden) return;
    if (busy || !loaded) return;
    const settings = collect('SAVE_SETTINGS');
    if (!settings) return;
    const saveSettings = async () => {
      status('설정을 저장하고 있습니다.');
      const response = await send('SAVE_SETTINGS',{settings});
      applySettings(response.settings ?? settings);
      document.dispatchEvent(new Event('settingssaved'));
      status(($('cacheOnly').checked ? '캐시 전용 설정을 저장했습니다. AI 요청 없이 저장된 번역만 사용합니다. ' : '설정을 저장했습니다. ') + '자동 번역이 ' + ($('enabled').checked ? '켜졌습니다.' : '꺼져 있습니다.'),'success',settings);
    };
    if (settings.cacheOnly) {
      setBusy(true);
      Promise.resolve().then(saveSettings).catch(error => fail(error,settings)).finally(() => setBusy(false));
    } else requestHostAndRun(settings,saveSettings);
  }
  form.addEventListener('submit',save);
  $('cacheOnly').addEventListener('change', () => {
    syncProvider();
    $('testResult').hidden = true;
    $('testText').textContent = '';
    status($('cacheOnly').checked ? '캐시 전용 모드를 선택했습니다. 저장하면 API 인증·전송 동의 없이 캐시만 사용하고, 없는 문구는 원문으로 남습니다.' : 'AI 모드를 선택했습니다. 모델·인증 정보와 전송 동의를 확인하고 저장하세요. 아직 저장하지 않았습니다.');
  });
  $('provider').addEventListener('change', () => {
    if ($('provider').value === 'chatgpt') $('consent').checked = false;
    $('endpoint').value = PRESETS[$('provider').value] || PRESETS.openai;
    $('model').value = '';
    $('apiKey').value = '';
    $('modelSuggestions').replaceChildren();
    $('testResult').hidden = true;
    $('testText').textContent = '';
    syncProvider();
    if ($('provider').value === 'chatgpt') void chatgptAuth('CHATGPT_AUTH_STATUS');
    else if (authTimer !== null) { clearTimeout(authTimer); authTimer = null; }
    status('제공자 선택만 바뀌었습니다. 연결과 모델을 확인한 뒤 저장해야 적용됩니다.');
  });
  function markDirty(event) {
    if (!loaded || !FIELDS.includes(event.target?.id)) return;
    event.target.removeAttribute('aria-invalid');
    if (event.target.id === 'enabled' && $('provider').value === 'chatgpt') syncProvider();
    $('savedState').textContent = '저장 전 변경';
    $('savedState').classList.remove('active');
    $('savedState').classList.add('dirty');
    if ($('saveHint')) $('saveHint').textContent = '아직 적용되지 않았습니다. 닫으면 저장하지 않은 입력은 사라집니다.';
  }
  form.addEventListener('input',markDirty);
  form.addEventListener('change',markDirty);
  $('loadModels').addEventListener('click', () => {
    if (busy || !loaded) return;
    if ($('provider').value === 'chatgpt') {
      if (authBusy || !chatgptState?.connected || !chatgptState?.planEnabled || chatgptState?.loginPending) { status('먼저 ChatGPT 로그인과 권한 승인을 완료하세요.','warning'); return; }
      setBusy(true);
      send('CHATGPT_MODEL_LIST').then(response => {
        const ids = new Set();
        const options = [];
        for (const model of Array.isArray(response.models) ? response.models : []) {
          if (typeof model?.id !== 'string' || !model.id || ids.has(model.id)) continue;
          ids.add(model.id);
          const option = document.createElement('option'); option.value = model.id; option.label = typeof model.name === 'string' ? model.name : model.id; options.push(option);
        }
        $('modelSuggestions').replaceChildren(...options);
        status(options.length ? '모델 목록을 불러왔습니다. 모델을 선택하고 설정을 저장하세요. 특정 모델 이용 자격·사용량 잔여를 보장하지 않습니다.' : '로컬 도우미가 모델 목록을 반환하지 않았습니다. 승인 상태와 도우미 설정을 확인하세요.');
      }).catch(() => status('모델 목록을 확인하지 못했습니다. 로컬 도우미와 계정 연결을 확인하세요.','warning')).finally(() => setBusy(false));
      return;
    }
    const settings = collect('LIST_MODELS');
    if (!settings) return;
    requestHostAndRun(settings, async () => {
      status('모델 목록을 조회하고 있습니다. 현재 설정은 저장하지 않습니다.');
      const response = await send('LIST_MODELS',{settings});
      const models = Array.isArray(response.models) ? response.models : [];
      const options = [];
      const ids = new Set();
      for (const model of models) {
        if (typeof model?.id !== 'string' || !model.id || ids.has(model.id)) continue;
        ids.add(model.id);
        const option = document.createElement('option');
        option.value = safeText(model.id,settings);
        if (typeof model.name === 'string') option.label = safeText(model.name,settings);
        options.push(option);
      }
      $('modelSuggestions').replaceChildren(...options);
      status(options.length ? numberFormat.format(options.length) + '개 모델을 불러왔습니다. 모델 입력란에서 선택하거나 직접 입력한 후 저장하세요.' : '서버가 모델 목록을 반환하지 않았습니다. 제공자의 모델 ID를 직접 입력하고 저장하세요.', options.length ? 'success' : 'info',settings);
      $('model').focus();
    });
  });
  $('testConnection').addEventListener('click', () => {
    if (busy || !loaded) return;
    const settings = collect('TEST');
    if (!settings) return;
    if (!window.confirm('짧은 텍스트로 실제 번역 요청을 보냅니다. API 비용 또는 구독 사용량이 발생할 수 있습니다. 테스트할까요?')) return;
    requestHostAndRun(settings, async () => {
      $('testResult').hidden = true;
      $('testText').textContent = '';
      status('실제 번역 요청을 보내고 있습니다. 비용 또는 구독 사용량이 발생할 수 있습니다.','warning');
      const response = await send('TEST',{settings});
      $('testText').textContent = safeText(typeof response.text === 'string' ? response.text : '텍스트 응답이 없습니다.',settings);
      $('testResult').hidden = false;
      status('연결 테스트에 성공했습니다. 입력한 설정은 아직 저장되지 않았습니다.','success',settings);
      try { await refreshUsage(); } catch (_) { /* Keep the successful test result. */ }
    });
  });
  function transferProgress(message) {
    if ($('cacheTransferProgress')) $('cacheTransferProgress').textContent = message;
  }
  function cacheHeader(data) {
    if (data?.format !== 'crave-ai-translation-cache' || ![1,2,3].includes(data.version)) throw new Error('지원하는 캐시 파일 형식(v1/v2/v3)이 아닙니다.');
    // Whole JSON v1/v2/v3 is validated/migrated by the backend; streaming
    // requires the current identity separately before starting a session.
  }
  function portableEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('캐시 항목 형식이 올바르지 않습니다.');
    // No credentials, endpoint, provider or model can be serialized here.
    const result = {};
    for (const key of ['id','source','context','target','text','createdAt','updatedAt']) if (Object.hasOwn(entry,key)) result[key] = entry[key];
    if (entry.manual === true) result.manual = true;
    return result;
  }
  async function finishExport(token) {
    if (token) {
      await send('EXPORT_END',{token});
      if (activeExportToken === token) activeExportToken = null;
    }
  }
  async function exportSmallLegacy() {
    if (!window.confirm('이 브라우저에서는 파일에 순차 저장할 수 없습니다. 32 MiB 이하의 작은 기존 JSON만 대신 내려받을까요? 큰 캐시는 지원하지 않습니다. 작업 중 팝업을 열어 두세요.')) return;
    // First measure pages without keeping the cache in popup memory. This also
    // stops large caches before requesting the whole-JSON compatibility API.
    let token;
    try {
      const start = await send('EXPORT_START');
      token = start.token;
      activeExportToken = token;
      cacheHeader(start.header);
      let bytes = new TextEncoder().encode(JSON.stringify({...start.header,entries:[]})).byteLength;
      let cursor = null;
      while (true) {
        const result = await send('EXPORT_PAGE',{token,cursor});
        if (!Array.isArray(result.entries)) throw new Error('캐시 페이지 응답이 올바르지 않습니다.');
        for (const entry of result.entries) {
          bytes += new TextEncoder().encode(JSON.stringify(portableEntry(entry))).byteLength + 1;
          if (bytes > MAX_CACHE_BYTES - 65536) throw new Error('작은 JSON 내보내기는 32 MiB 이하만 가능합니다. 순차 파일 저장을 지원하는 브라우저에서 NDJSON을 사용하세요.');
        }
        if (result.done) break;
        if (typeof result.cursor !== 'string' || result.cursor === cursor) throw new Error('캐시 페이지 순서가 올바르지 않습니다.');
        cursor = result.cursor;
      }
    } finally { await finishExport(token); }
    const response = await send('EXPORT_CACHE',{maxBytes:MAX_CACHE_BYTES});
    const data = response.data;
    cacheHeader(data);
    if (!Array.isArray(data.entries)) throw new Error('내보내기 항목을 확인할 수 없습니다.');
    // Build only a bounded small fallback, never a large cache-sized string.
    const parts = [JSON.stringify({format:data.format,version:data.version,exportedAtISO:data.exportedAtISO || data.exportedAt,appVersion:data.appVersion,...(data.identity ? {identity:data.identity} : {})}).replace(/}$/,',"entries":[')];
    let bytes = new TextEncoder().encode(parts[0]).byteLength + 2;
    for (const entry of data.entries) {
      const line = (parts.length > 1 ? ',' : '') + JSON.stringify(portableEntry(entry));
      bytes += new TextEncoder().encode(line).byteLength;
      if (bytes > MAX_CACHE_BYTES) throw new Error('파일이 32 MiB를 초과합니다. NDJSON 순차 저장을 사용하세요.');
      parts.push(line);
    }
    parts.push(']}');
    const blob = new Blob(parts,{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = 'crave-ai-cache-' + new Date().toISOString().replace(/[:.]/g,'-') + '.json';
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
    } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),60000); }
    status(numberFormat.format(data.entries.length) + '개 번역의 작은 JSON 다운로드를 시작했습니다. 파일은 비공개로 보관하세요.','success');
  }
  $('exportCache').addEventListener('click', async () => {
    if (busy || !loaded) return;
    // Invoke the picker in the original user gesture, before any await/message.
    let picker;
    try {
      if (typeof window.showSaveFilePicker === 'function') picker = window.showSaveFilePicker({suggestedName:'crave-ai-cache-' + new Date().toISOString().replace(/[:.]/g,'-') + '.ndjson',types:[{description:'번역 캐시 NDJSON',accept:{'application/x-ndjson':['.ndjson']}}]});
    } catch (error) { fail(error); return; }
    setBusy(true);
    let token;
    let writer;
    try {
      status('캐시 내보내기 준비 중. 원문·번역문이 포함됩니다. 작업 중 팝업을 닫지 마세요.');
      transferProgress('파일 저장 준비 중');
      if (!picker) { await exportSmallLegacy(); return; }
      const handle = await picker;
      writer = await handle.createWritable();
      const start = await send('EXPORT_START');
      token = start.token;
      activeExportToken = token;
      cacheHeader(start.header);
      const header = {format:start.header.format,version:start.header.version,exportedAtISO:start.header.exportedAtISO || start.header.exportedAt,appVersion:start.header.appVersion,identity:start.header.identity};
      await writer.write(JSON.stringify(header) + '\n');
      let cursor = null;
      let count = 0;
      while (true) {
        const result = await send('EXPORT_PAGE',{token,cursor});
        if (!Array.isArray(result.entries)) throw new Error('캐시 페이지 응답이 올바르지 않습니다.');
        let chunk = '';
        for (const entry of result.entries) {
          const line = JSON.stringify(portableEntry(entry)) + '\n';
          // 256K UTF-16 chars is at most about 1 MiB UTF-8.
          if (chunk.length && chunk.length + line.length > 256 * 1024) { await writer.write(chunk); chunk = ''; }
          if (line.length > 256 * 1024) {
            let offset = 0;
            while (offset < line.length) {
              let end = Math.min(offset + 256 * 1024,line.length);
              const last = line.charCodeAt(end - 1);
              if (end < line.length && last >= 0xD800 && last <= 0xDBFF) end--;
              await writer.write(line.substring(offset,end));
              offset = end;
            }
          } else chunk += line;
          count++;
        }
        if (chunk) await writer.write(chunk);
        transferProgress('내보내기 ' + numberFormat.format(count) + '개 / 시작 시 저장 개수 참고 ' + numberFormat.format(start.count) + '개 · 팝업을 열어 두세요');
        if (result.done) break;
        if (typeof result.cursor !== 'string' || result.cursor === cursor) throw new Error('캐시 페이지 순서가 올바르지 않습니다.');
        cursor = result.cursor;
      }
      if (start.countIsExact === true && Number.isSafeInteger(start.count) && count !== start.count) throw new Error('내보내기 개수가 일치하지 않습니다. 다시 시도하세요.');
      await writer.write(JSON.stringify({end:true,count}) + '\n');
      await writer.close();
      writer = null;
      status(numberFormat.format(count) + '개 번역을 NDJSON으로 저장했습니다. 인증값·서버 주소는 포함하지 않습니다. 파일은 비공개로 보관하세요.','success');
      transferProgress('내보내기 완료 · ' + numberFormat.format(count) + '개');
    } catch (error) {
      if (writer) { try { await writer.abort(); } catch (_) { /* Closed popup or failed disk. */ } }
      if (error?.name === 'AbortError') status('파일 저장을 취소했습니다. 팝업이 닫히면 작업이 중단될 수 있습니다.');
      else fail(error?.name === 'SecurityError' || error?.name === 'NotAllowedError' ? '이 팝업에서 순차 파일 저장이 허용되지 않았습니다. 팝업을 열어 둔 채 다시 시도하세요. 큰 파일을 메모리 다운로드로 대신 만들지 않습니다.' : error);
      transferProgress('내보내기 중단 · 완료된 백업으로 사용하지 마세요');
    } finally { try { await finishExport(token); } catch (_) { /* Backend session expires independently. */ } setBusy(false); }
  });
  async function importSmallLegacy(file,mode,conflictPolicy) {
    if (file.size > MAX_CACHE_BYTES) throw new Error('기존 전체 JSON은 32 MiB 이하만 지원합니다. 큰 파일은 NDJSON 형식이어야 합니다.');
    if (!window.confirm('기존 전체 JSON 파일을 작은 파일 호환 방식으로 읽습니다(32 MiB 이하). 계속할까요?')) return null;
    let data;
    try { data = JSON.parse(await file.text()); } catch (_) { throw new Error('올바른 JSON 파일이 아닙니다. 기존 캐시는 변경하지 않았습니다.'); }
    cacheHeader(data);
    if (!Array.isArray(data.entries)) throw new Error('캐시 항목 배열이 없습니다.');
    return await send('IMPORT_CACHE',{data,mode,...(mode === 'merge' && conflictPolicy !== undefined ? {conflictPolicy} : {})});
  }
  async function importStream(file,mode,conflictPolicy) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let buffer = '';
    let header;
    let token;
    let footer = false;
    let expectedCount = null;
    let count = 0;
    let bytes = 0;
    let batch = [];
    const batchEncoder = new TextEncoder();
    const emptyBatchBytes = () => batchEncoder.encode(JSON.stringify({type:'IMPORT_BATCH',token,entries:[]})).byteLength;
    let batchBytes = emptyBatchBytes();
    let first = true;
    let legacy = false;
    async function flush() {
      if (!batch.length) return;
      await send('IMPORT_BATCH',{token,entries:batch});
      batch = [];
      batchBytes = emptyBatchBytes();
      transferProgress('검증·임시 저장 ' + numberFormat.format(count) + '개 · ' + Math.floor(bytes / Math.max(1,file.size) * 100) + '% · 아직 기존 캐시에 반영하지 않음');
    }
    async function line(text) {
      if (!text.trim()) return;
      let value;
      try { value = JSON.parse(text); } catch (_) { if (first) { legacy = true; return; } throw new Error('NDJSON 항목의 JSON 문법이 올바르지 않습니다.'); }
      if (first) {
        first = false;
        if (Array.isArray(value?.entries)) { legacy = true; return; }
        cacheHeader(value);
        if (![2,3].includes(value.version) || value.identity !== 'source-v3') throw new Error('순차 파일은 version 2/3 · source-v3 NDJSON 형식이어야 합니다.');
        header = value;
        const started = await send('IMPORT_START',{mode,...(mode === 'merge' && conflictPolicy !== undefined ? {conflictPolicy} : {})});
        token = started.token;
        activeImportToken = token;
        batchBytes = emptyBatchBytes();
        return;
      }
      if (footer) throw new Error('종료 표시 뒤에 추가 데이터가 있습니다.');
      if (value?.end === true) {
        if (!Number.isSafeInteger(value.count) || value.count !== count) throw new Error('NDJSON 종료 개수가 일치하지 않습니다.');
        expectedCount = value.count;
        footer = true;
        return;
      }
      const entry = portableEntry(value);
      const entryBytes = batchEncoder.encode(JSON.stringify(entry)).byteLength;
      if (entryBytes + emptyBatchBytes() > IMPORT_BATCH_BYTES) throw new Error('캐시 항목 하나가 순차 가져오기 전송 한도(1 MiB)를 초과합니다.');
      if (batch.length && batchBytes + entryBytes + 1 > IMPORT_BATCH_BYTES) await flush();
      batchBytes += entryBytes + (batch.length ? 1 : 0);
      batch.push(entry);
      count++;
      if (batch.length >= IMPORT_BATCH_SIZE) await flush();
    }
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) { buffer += decoder.decode(); break; }
        bytes += result.value.byteLength;
        buffer += decoder.decode(result.value,{stream:true});
        // A pretty printed/whole JSON file is detected without retaining it.
        if (first && buffer.length > 65536 && !buffer.includes('\n')) { legacy = true; break; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const text = buffer.substring(0,newline).replace(/\r$/,'');
          buffer = buffer.substring(newline + 1);
          if (text.length > MAX_LINE_CHARS) throw new Error('NDJSON 한 줄이 너무 큽니다(최대 4 Mi 문자).');
          await line(text);
          if (legacy) break;
        }
        if (legacy) break;
        if (buffer.length > MAX_LINE_CHARS) throw new Error('NDJSON 한 줄이 너무 큽니다(최대 4 Mi 문자).');
      }
      if (!legacy && buffer.trim()) await line(buffer.replace(/\r$/,''));
      if (legacy) { await reader.cancel(); return await importSmallLegacy(file,mode,conflictPolicy); }
      if (!header || !footer) throw new Error('NDJSON 형식 정보 또는 종료 표시가 없습니다. 잘리거나 미완료된 파일입니다.');
      await flush();
      transferProgress('파일 검증 완료 · ' + numberFormat.format(count) + '개를 한 번에 반영 중');
      const response = await send('IMPORT_COMMIT',{token,header,expectedCount});
      activeImportToken = null;
      token = null;
      return response;
    } catch (error) {
      if (token) { try { await send('IMPORT_ABORT',{token}); if (activeImportToken === token) activeImportToken = null; } catch (_) { /* Unload cleanup and backend TTL back up failed abort. */ } }
      throw error;
    } finally { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
  }
  function syncImportMode() {
    const merging = $('importMode').value === 'merge';
    $('importConflictField').hidden = !merging;
    $('importConflictPolicy').disabled = !merging;
  }
  $('importMode').addEventListener('change',syncImportMode);
  syncImportMode();
  $('importCache').addEventListener('click', async () => {
    if (busy || !loaded) return;
    const file = $('cacheFile').files?.[0];
    if (!file) { status('먼저 가져올 NDJSON 또는 작은 JSON 파일을 선택하세요.','error'); $('cacheFile').focus(); return; }
    const mode = $('importMode').value;
    if (mode !== 'merge' && mode !== 'replace') { status('가져오기 방식을 선택하세요.','error'); return; }
    if (mode === 'replace' && !window.confirm('전체 교체: 파일 전체 검증이 끝나면 기존 번역 캐시 전체를 삭제하고 파일 내용으로 한 번에 바꿉니다. 되돌릴 수 없습니다. 먼저 백업했는지 확인하세요. 계속할까요?')) return;
    const conflictPolicy = mode === 'merge' ? $('importConflictPolicy').value : undefined;
    if (mode === 'merge' && !['keep-local','use-incoming'].includes(conflictPolicy)) { status('중복 번역 처리 방식을 선택하세요.','error'); return; }
    if (conflictPolicy === 'use-incoming' && !window.confirm('파일의 번역 사용: 같은 원문·대상 언어의 로컬 번역을 가져오는 파일의 번역으로 덮어씁니다. 기존 수동 수정도 바뀔 수 있으며 되돌릴 수 없습니다. 먼저 캐시를 내보내 백업하세요. 파일에 없는 로컬 번역은 유지합니다. 계속할까요?')) return;
    const policyLabel = mode === 'replace' ? '전체 교체' : conflictPolicy === 'use-incoming' ? '파일 번역 우선' : '로컬 번역 유지';
    setBusy(true);
    try {
      status('캐시 파일을 순차 검증하고 있습니다. 작업 중 팝업을 닫지 마세요.');
      transferProgress('파일 확인 중 · 기존 캐시는 유지됩니다');
      const response = await importStream(file,mode,conflictPolicy);
      if (!response) { status('가져오기를 취소했습니다. 기존 캐시는 변경하지 않았습니다.'); transferProgress('가져오기 취소'); return; }
      $('cacheCount').textContent = numberFormat.format(response.cacheCount) + ' 개';
      transferProgress('가져오기 완료 · ' + policyLabel);
      status('가져오기 완료 (' + policyLabel + '): ' + numberFormat.format(response.imported) + '개 반영, ' + numberFormat.format(response.skipped) + '개 건너뜀. 현재 캐시 ' + numberFormat.format(response.cacheCount) + '개. 캐시 전용 모드에서도 사용할 수 있습니다.','success');
    } catch (error) { fail(error); transferProgress('가져오기 중단 · 완료 전에는 기존 캐시를 교체하지 않습니다'); }
    finally { $('cacheFile').value = ''; setBusy(false); }
  });
  if ($('deleteOldest')) $('deleteOldest').addEventListener('click', async () => {
    if (busy || !loaded) return;
    const raw = $('deleteOldestCount').value.trim();
    const count = Number(raw);
    if (!raw || !Number.isSafeInteger(count) || count < 1) { invalid('deleteOldestCount','삭제 개수는 1부터 9,007,199,254,740,991 사이의 정수로 입력하세요.'); return; }
    setBusy(true);
    try {
      const before = await send('GET_SETTINGS');
      if (!Number.isSafeInteger(before.cacheCount) || before.cacheCount < 0) throw new Error('삭제 전 캐시 개수를 확인하지 못했습니다.');
      const expected = Math.min(count,before.cacheCount);
      if (!window.confirm('삭제 주의 · 되돌릴 수 없음\n마지막 번역 저장 시각이 오래된 순서로 최대 ' + numberFormat.format(count) + '개를 삭제합니다.\n삭제 전: ' + numberFormat.format(before.cacheCount) + '개 / 예상 삭제: ' + numberFormat.format(expected) + '개 / 예상 남음: ' + numberFormat.format(before.cacheCount - expected) + '개\n다시 번역하면 비용·사용량이 발생할 수 있습니다. 삭제할까요?')) { status('오래된 번역 삭제를 취소했습니다.'); return; }
      const response = await send('DELETE_OLDEST',{count});
      $('cacheCount').textContent = numberFormat.format(response.cacheCount) + ' 개';
      status('오래된 번역 삭제 완료: 삭제 전 ' + numberFormat.format(before.cacheCount) + '개 → ' + numberFormat.format(response.deleted) + '개 삭제 / ' + numberFormat.format(response.cacheCount) + '개 남음. 마지막 번역 저장 시각이 오래된 순서로 삭제했습니다.','success');
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  });
  $('clearCache').addEventListener('click', async () => {
    if (busy || !loaded) return;
    if (!window.confirm('저장된 번역 캐시를 비울까요? 같은 문구를 다시 번역하면 비용 또는 사용량이 발생할 수 있습니다.')) return;
    setBusy(true);
    try {
      await send('CLEAR_CACHE');
      $('cacheCount').textContent = '0 개';
      status('번역 캐시를 비웠습니다. 연결 설정은 변경하지 않았습니다.','success');
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  });
  $('resetUsage').addEventListener('click', async () => {
    if (busy || !loaded) return;
    if (!window.confirm('이 확장의 사용량 기록을 초기화할까요? 하루 전송 한도를 다시 사용할 수 있지만 제공자의 요금과 사용량은 초기화되지 않습니다.')) return;
    setBusy(true);
    try {
      await send('RESET_USAGE');
      status('사용량 기록을 초기화했습니다. 제공자의 요금·사용량은 그대로입니다.','success');
      try { await refreshUsage(); } catch (_) { $('usageChars').textContent = '0 자'; $('usageDetail').textContent = '기록을 초기화했습니다. 제공자의 요금과 사용량은 취소되지 않습니다.'; }
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  });
  async function init() {
    applySettings(DEFAULTS);
    setBusy(true);
    try {
      const response = await send('GET_SETTINGS');
      applySettings(response.settings);
      displayUsage(response.usage,response.cacheCount);
      loaded = true;
      document.dispatchEvent(new Event('settingsloaded'));
      status(response.settings?.migrationRequired ? '제거된 이전 연결 방식입니다. 제공자를 직접 선택하고 저장하세요. 자동 번역은 꺼진 상태입니다.' : '설정을 불러왔습니다. 변경한 내용은 설정 저장을 눌러야 적용됩니다.');
    } catch (error) { $('savedState').textContent = '연결 필요'; fail(error); }
    finally { setBusy(false); if (loaded && $('provider').value === 'chatgpt') void chatgptAuth('CHATGPT_AUTH_STATUS'); }
  }
  init();
})();
