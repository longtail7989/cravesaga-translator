'use strict';
(() => {
  const $ = id => document.getElementById(id);
  try { const label = $('popupVersion'); if (label) label.textContent = chrome.runtime.getManifest().version; } catch (_) {}
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const content = $('popupContent');
  const gameStatus = $('gameStatus');
  const retryFailed = $('retryFailed');
  const ERROR_NAMES = Object.freeze({TIMEOUT:'응답 지연',NETWORK:'연결 오류',HTTP_429:'제공자 요청 제한',HTTP_401:'인증·접근 권한 오류',HTTP_403:'인증·접근 권한 오류',INVALID_RESPONSE:'응답 형식 오류',VALIDATION:'번역 검증 실패',UNTRANSLATED:'미번역 응답',OUTPUT_LIMIT:'응답 길이 한도',RETRY_LIMIT:'재시도 한도',QUOTA:'설정한 일일 한도',CANCELLED:'일시정지'});
  let retryPending = false;
  let settingsBusy = true;
  let gameReady = false;
  const card = gameStatus.closest('.game-card');
  const numberFormat = new Intl.NumberFormat('ko-KR');
  let statusPending = false;
  let closed = false;
  const scrollPositions = new Map();
  function activate(tab, focus = false) {
    const previous = tabs.find(item => item.getAttribute('aria-selected') === 'true');
    if (previous === tab) { if (focus) tab.focus(); return; }
    if (previous) scrollPositions.set(previous.id, content.scrollTop);
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
    content.scrollTop = scrollPositions.get(tab.id) || 0;
    const saveRow = document.querySelector('.save-row');
    if (saveRow) saveRow.hidden = tab.id === 'tab-editor';
    if (focus) tab.focus();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(tabs[next], true);
    });
  }
  // Reveal a field's tab before the shared validator focuses that field.
  document.addEventListener('settingsinvalid', event => {
    const panel = $(event.detail?.field)?.closest('[role="tabpanel"]');
    const tab = panel && tabs.find(item => item.getAttribute('aria-controls') === panel.id);
    if (tab) activate(tab);
  });
  function send(type, callback) {
    if (closed || !globalThis.chrome?.runtime?.sendMessage) { callback(null); return; }
    let settled = false;
    const complete = response => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!closed) callback(response);
    };
    const timeout = setTimeout(() => complete(null), 8000);
    try {
      chrome.runtime.sendMessage({type}, response => {
        const failed = Boolean(chrome.runtime.lastError);
        complete(!failed && response?.ok === true ? response : null);
      });
    } catch (_) { complete(null); }
  }
  function renderStatus(response) {
    gameReady = response?.found === true && response.status?.ready === true;
    retryFailed.disabled = settingsBusy || !gameReady || retryPending;
    if (!response) {
      card.dataset.state = 'unavailable';
      gameStatus.textContent = '게임 상태를 확인하지 못했습니다. 게임 탭에서 이 팝업을 다시 열어 주세요.';
      return;
    }
    if (!response.found) {
      card.dataset.state = 'inactive';
      gameStatus.textContent = '현재 탭에서 게임을 찾지 못했습니다. 크레이브 사가 게임 탭에서 열어 주세요.';
      return;
    }
    const state = response.status || {};
    const count = value => Number.isSafeInteger(value) && value >= 0 ? numberFormat.format(value) : '–';
    const stopped = state.stopped === true;
    card.dataset.state = stopped ? 'stopped' : state.ready === true ? 'ready' : 'waiting';
    const summary = stopped ? '게임 연결됨 · 번역 대기/중지' : state.ready === true ? '게임 연결됨' : '게임 화면을 준비하고 있습니다.';
    // Deliberately do not echo runtime notice/error strings: status never needs credentials.
    const errorName = typeof response.lastErrorCode === 'string' && Object.hasOwn(ERROR_NAMES, response.lastErrorCode) ? ERROR_NAMES[response.lastErrorCode] : '';
    const waitSeconds = Number.isSafeInteger(response.nextRetryAt) && response.nextRetryAt > Date.now() ? Math.ceil((response.nextRetryAt - Date.now()) / 1000) : 0;
    gameStatus.textContent = summary + ' · 번역 ' + count(state.translated) + ' · 대기 ' + count(state.waiting) + ' · 캐시 적중 ' + count(response.cacheHits) + ' · 요청 대기 ' + count(response.queued) + ' · 재시도 ' + count(response.retrying) + ' · 실패 ' + count(response.failed) + ' · 시도 ' + count(response.attempts) + (errorName ? ' · ' + errorName : '') + (waitSeconds > 0 ? ' · 다음 재시도까지 ' + numberFormat.format(waitSeconds) + '초' : '');
  }
  function poll() {
    if (closed || statusPending) return;
    statusPending = true;
    send('GET_ACTIVE_STATUS', response => {
      statusPending = false;
      renderStatus(response);
    });
  }
  retryFailed.addEventListener('click', () => {
    if (settingsBusy || retryPending || !gameReady || closed) return;
    retryPending = true;
    retryFailed.disabled = true;
    send('RETRY_FAILED', response => {
      retryPending = false;
      retryFailed.disabled = settingsBusy || !gameReady;
      if (!response) {
        gameStatus.textContent = '실패 문구를 다시 시도하지 못했습니다. 게임 연결과 저장된 설정을 확인하세요.';
        return;
      }
      gameStatus.textContent = '실패 문구의 재시도를 요청했습니다.';
      poll();
    });
  });
  document.addEventListener('settingsbusy', event => {
    settingsBusy = event.detail?.busy !== false;
    retryFailed.disabled = settingsBusy || !gameReady || retryPending;
  });
  const timer = setInterval(poll, 2000);
  window.addEventListener('pagehide', () => { closed = true; clearInterval(timer); }, {once:true});
  poll();
})();

// Cache administration is intentionally isolated from provider settings and permissions.
(() => {
  const $ = id => document.getElementById(id);
  let generation = 0, selecting = 0, pending = false, closed = false;
  let cursor = null, done = true, scanned = 0, shown = 0;
  let selected = null, version = null, saving = false, dirty = false;
  const message = (type, payload = {}) => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({type,...payload}, response => {
        if (chrome.runtime.lastError) reject(new Error('CONNECTION'));
        else resolve(response || {ok:false});
      });
    } catch (_) { reject(new Error('CONNECTION')); }
  });
  function notice(text, error = false) {
    $('editorNotice').textContent = text;
    $('editorNotice').dataset.tone = error ? 'error' : 'info';
  }
  function controls() {
    $('editorSearch').disabled = pending || closed;
    $('editorCancel').disabled = !pending || closed;
    $('editorNext').disabled = pending || done || !cursor || closed;
    $('editorSave').disabled = !selected || saving || closed;
    $('editorDelete').disabled = !selected || saving || closed;
  }
  function reset() {
    generation++;
    cursor = null; done = true; scanned = 0; shown = 0;
    $('editorResults').replaceChildren();
    $('editorProgress').textContent = pending ? '중단 요청됨 · 진행 중인 응답을 기다립니다.' : '검색 조건이 바뀌었습니다. 검색 버튼을 눌러 주세요.';
    controls();
  }
  function updated(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '시간 정보 없음';
  }
  function meta(entry) { return (entry.manual === true ? '수동 수정' : '자동 번역') + ' · ' + updated(entry.updatedAt); }
  function paintRow(entry) {
    const li = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.className = 'editor-result';
    button.setAttribute('aria-pressed','false');
    const source = document.createElement('span'), text = document.createElement('span'), label = document.createElement('small');
    source.textContent = String(entry.sourcePreview ?? '');
    text.textContent = String(entry.textPreview ?? ''); text.className = 'editor-preview';
    label.textContent = meta(entry) + ' · ' + String(entry.target ?? '');
    button.append(source,text,label);
    button.addEventListener('click', () => select(entry.id));
    li.append(button); $('editorResults').append(li);
  }
  async function search(next = false) {
    if (pending || closed) return;
    const query = $('editorQuery').value, target = $('editorTarget').value.trim(), mode = $('editorMode').value;
    const max = mode === 'exact' ? 8192 : 256;
    if (query.length > max || !target || target.length > 64) {
      $('editorProgress').textContent = '검색어는 ' + max.toLocaleString('ko-KR') + '자 이하, 대상 언어는 1~64자로 입력하세요.'; return;
    }
    if (next && (done || !cursor)) return;
    if (!next) { reset(); done = false; }
    const token = generation;
    pending = true; shown = 0; $('editorResults').replaceChildren(); controls();
    try {
      while (!closed && token === generation && shown < 20 && !done) {
        $('editorProgress').textContent = '검색 중 · 확인한 항목 ' + scanned.toLocaleString('ko-KR') + '개 · 결과 ' + shown + '개';
        const response = await message('CACHE_SEARCH',{query,target,mode,cursor,limit:20-shown});
        if (closed || token !== generation) return;
        if (response.ok !== true || !Array.isArray(response.results)) throw new Error('SEARCH');
        for (const entry of response.results) { if (shown >= 20) break; paintRow(entry); shown++; }
        scanned += Number.isSafeInteger(response.scanned) && response.scanned >= 0 ? response.scanned : 0;
        const previousCursor = cursor;
        cursor = typeof response.cursor === 'string' ? response.cursor : null;
        done = response.done === true || !cursor;
        if (!done && cursor === previousCursor) throw new Error('CURSOR');
        $('editorProgress').textContent = '확인한 항목 ' + scanned.toLocaleString('ko-KR') + '개 · 이 페이지 ' + shown + '개' + (done ? ' · 검색 완료' : ' · 다음 페이지 있음');
      }
    } catch (_) {
      if (!closed && token === generation) { done = true; cursor = null; $('editorProgress').textContent = '검색하지 못했습니다. 검색 버튼으로 다시 시작해 주세요.'; }
    } finally { pending = false; if (!closed) { if (token !== generation) $('editorProgress').textContent = '검색을 중단했습니다. 다시 검색할 수 있습니다.'; controls(); } }
  }
  async function select(id, reload = false) {
    if (saving || closed) return;
    if (dirty && !window.confirm(reload ? '입력한 번역이 최신 저장본으로 바뀝니다. 필요한 문구를 먼저 복사하세요. 다시 불러올까요?' : '저장하지 않은 번역이 있습니다. 다른 항목을 불러올까요?')) return;
    const token = ++selecting;
    notice('원문과 번역문을 불러오는 중입니다.');
    $('editorDetail').hidden = false;
    selected = null; controls();
    try {
      const response = await message('CACHE_GET',{id});
      if (closed || token !== selecting) return;
      if (response.ok !== true || !response.entry) { notice('항목이 없거나 불러오지 못했습니다. 다시 검색해 주세요.',true); return; }
      selected = response.entry;
      version = response.version || {updatedAt:selected.updatedAt,text:selected.text};
      $('editorSource').value = String(selected.source ?? '');
      $('editorEntryTarget').value = String(selected.target ?? '');
      $('editorText').value = String(selected.text ?? '');
      $('editorMeta').textContent = meta(selected);
      $('editorReload').hidden = true; dirty = false;
      notice('번역문을 수정한 뒤 수정 번역 저장을 눌러 주세요.');
    } catch (_) { if (token === selecting && !closed) notice('항목을 불러오지 못했습니다.',true); }
    finally { if (!closed) controls(); }
  }
  async function save() {
    if (!selected || saving || closed) return;
    const entry = selected, text = $('editorText').value;
    saving = true; $('editorText').readOnly = true; controls(); notice('기기에 저장하는 중입니다.');
    try {
      const response = await message('CACHE_EDIT_SAVE',{id:entry.id,source:entry.source,target:entry.target,text,expectedUpdatedAt:version.updatedAt,expectedText:version.text,create:false});
      if (closed) return;
      if (response.ok !== true) {
        const conflict = [response.code,response.errorCode,response.error,response.error?.code].includes('CONFLICT');
        if (conflict) { $('editorReload').hidden = false; notice('다른 작업에서 이 번역이 변경되었습니다. 입력한 번역은 유지했습니다. 먼저 복사하거나 최신 번역 다시 불러오기를 선택하세요. 덮어쓰지 않았습니다.',true); }
        else notice('저장하지 못했습니다. 태그·숫자·변수·줄바꿈을 원문과 맞추고 다시 시도하세요.',true);
        return;
      }
      selected = response.entry || {...entry,text,manual:true};
      version = response.version || {updatedAt:selected.updatedAt,text:selected.text};
      dirty = false; $('editorMeta').textContent = meta(selected); $('editorReload').hidden = true;
      if (Number.isSafeInteger(response.cacheCount)) $('cacheCount').textContent = response.cacheCount.toLocaleString('ko-KR') + ' 개';
      notice('수동 번역을 기기에 저장했습니다. AI 요청은 하지 않았습니다.');
    } catch (_) { if (!closed) notice('저장하지 못했습니다. 입력한 번역은 유지했습니다.',true); }
    finally { saving = false; if (!closed) { $('editorText').readOnly = false; controls(); } }
  }
  async function removeEntry() {
    if (!selected || saving || closed) return;
    const entry = selected, expected = {...version};
    const warning = '선택한 저장 번역 1건을 삭제할까요? 다른 번역은 삭제하지 않습니다. 되돌릴 수 없습니다.' + (dirty ? '\n저장하지 않은 수정 내용도 사라집니다.' : '') + '\n삭제 자체는 AI를 호출하지 않습니다. 이후 같은 문구가 새로 나타나면 자동 번역으로 사용량이 발생할 수 있습니다.\n\n원문: ' + entry.source.slice(0,160);
    if (!window.confirm(warning)) return;
    saving = true; $('editorText').readOnly = true; controls(); notice('선택한 번역을 삭제하는 중입니다.');
    try {
      const response = await message('CACHE_ENTRY_DELETE',{id:entry.id,source:entry.source,target:entry.target,expectedUpdatedAt:expected.updatedAt,expectedText:expected.text});
      if (closed) return;
      if (response.ok !== true || response.deleted !== 1) {
        const codes = [response.code,response.errorCode,response.error,response.error?.code];
        if (codes.includes('CONFLICT')) { $('editorReload').hidden = false; notice('다른 작업에서 이 번역이 변경되어 삭제하지 않았습니다. 입력 내용은 유지했습니다. 최신 번역을 확인한 뒤 다시 삭제하세요.',true); }
        else if (codes.includes('NOT_FOUND')) notice('이미 삭제되었거나 항목을 찾을 수 없습니다. 입력 내용은 유지했습니다. 다시 검색해 주세요.',true);
        else notice('삭제하지 못했습니다. 선택한 항목과 입력 내용은 유지했습니다.',true);
        return;
      }
      selected = null; version = null; dirty = false;
      $('editorSource').value = ''; $('editorEntryTarget').value = ''; $('editorText').value = ''; $('editorMeta').textContent = ''; $('editorReload').hidden = true; $('editorDetail').hidden = true;
      reset();
      if (Number.isSafeInteger(response.cacheCount)) $('cacheCount').textContent = response.cacheCount.toLocaleString('ko-KR') + ' 개';
      $('editorProgress').textContent = '선택한 번역 1건을 삭제했습니다. AI 요청은 하지 않았습니다. 다시 검색해 주세요.';
    } catch (_) { if (!closed) notice('삭제 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 다시 검색해 저장 상태를 확인하세요.',true); }
    finally { saving = false; if (!closed) { $('editorText').readOnly = false; controls(); } }
  }
  $('editorSearch').addEventListener('click', () => search());
  $('editorNext').addEventListener('click', () => search(true));
  $('editorCancel').addEventListener('click', reset);
  for (const id of ['editorQuery','editorTarget','editorMode']) {
    $(id).addEventListener(id === 'editorMode' ? 'change' : 'input', () => {
      $('editorQuery').maxLength = $('editorMode').value === 'exact' ? 8192 : 256;
      reset();
    });
    $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); search(); } });
  }
  $('editorText').addEventListener('input', () => { dirty = true; });
  $('editorSave').addEventListener('click', save);
  $('editorDelete').addEventListener('click', removeEntry);
  $('editorReload').addEventListener('click', () => { if (selected) return select(selected.id,true); });
  for (const event of ['settingsloaded','settingssaved']) document.addEventListener(event, () => { $('editorTarget').value = $('target').value || '한국어'; reset(); });
  const close = () => { closed = true; generation++; selecting++; };
  window.addEventListener('beforeunload',close,{once:true});
  window.addEventListener('pagehide',close,{once:true});
  controls();
})();
