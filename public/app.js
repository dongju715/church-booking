'use strict';
const DAY_START = 6 * 60, DAY_END = 24 * 60, SLOT = 30;
const WD = ['월', '화', '수', '목', '금', '토', '일'];
const MONTH_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const $ = id => document.getElementById(id);

const state = {
  spaces: [], spaceId: Number(localStorage.getItem('spaceId')) || null,
  weekStart: null, bookings: [], now: kstNow(), selDay: 0,
  token: localStorage.getItem('adminToken') || '', admin: false,
};

// ---------- 시간 (Asia/Seoul) ----------
function kstNow() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16); }
function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function mondayOf(d) { const t = new Date(d + 'T00:00:00Z'); const w = (t.getUTCDay() + 6) % 7; return addDays(d, -w); }
function hm(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function stampMin(stamp, date) { // 해당 날짜 기준 분
  if (stamp.slice(0, 10) > date) return 1440;
  if (stamp.slice(0, 10) < date) return 0;
  return Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16));
}
function korDate(d) { const t = new Date(d + 'T00:00:00Z'); return `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 (${WD[(t.getUTCDay() + 6) % 7]})`; }
function endLabel(stamp) { return stamp.slice(11) === '00:00' ? '24:00' : stamp.slice(11); }

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let res;
  try { res = await fetch(path, { ...opts, headers }); }
  catch { throw new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'); e.status = res.status; throw e; }
  return data;
}

function toast(msg, bad = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 3200);
}

// ---------- 공간 ----------
async function loadSpaces() {
  const c = await api('/api/config');
  state.config = c; state.spaces = c.spaces; state.depts = c.departments;
  const title = `${c.churchName} 장소예약`;
  $('churchTitle').textContent = title; document.title = title;
  $('subtitle').textContent = c.subtitle || '';
  if ($('adminDlg').open && state.admin) renderAdminLists();
  if (!state.spaces.some(s => s.id === state.spaceId)) state.spaceId = state.spaces[0]?.id;
  renderSpaces();
}
function renderSpaces() {
  const box = $('spaceList'); box.innerHTML = '';
  for (const s of state.spaces) {
    const b = document.createElement('button');
    b.textContent = s.name; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', s.id === state.spaceId);
    b.onclick = () => { state.spaceId = s.id; localStorage.setItem('spaceId', s.id); renderSpaces(); loadBookings(); };
    box.appendChild(b);
  }
  $('addSpaceBtn').hidden = !state.admin;
}
const spaceName = () => state.spaces.find(s => s.id === state.spaceId)?.name || '';

// ---------- 예약 ----------
async function loadBookings() {
  if (!state.spaceId) return;
  const from = state.weekStart, to = addDays(from, 6);
  try {
    const r = await api(`/api/bookings?spaceId=${state.spaceId}&from=${from}&to=${to}`);
    state.bookings = r.bookings; state.now = r.now;
    render();
  } catch (e) { toast(e.message, true); }
}

function render() {
  const ws = state.weekStart, today = state.now.slice(0, 10);
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  // 포스터 스타일 헤더
  const mid = new Date(addDays(ws, 3) + 'T00:00:00Z');
  $('bigMonth').textContent = MONTH_EN[mid.getUTCMonth()];
  $('monthNum').textContent = String(mid.getUTCMonth() + 1).padStart(2, '0');
  $('yearNum').textContent = mid.getUTCFullYear();
  $('rangeLabel').textContent = `${korDate(days[0])} ~ ${korDate(days[6])}`;

  // 요일 탭
  const tabs = $('dayTabs'); tabs.innerHTML = '';
  days.forEach((d, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', i === state.selDay);
    if (d === today) b.classList.add('today');
    b.innerHTML = `<small>${WD[i]}</small>${Number(d.slice(8))}`;
    b.onclick = () => { state.selDay = i; render(); };
    tabs.appendChild(b);
  });

  const board = $('board'); board.innerHTML = '';
  const corner = el('div', 'col-head corner'); board.appendChild(corner);
  days.forEach((d, i) => {
    const h = el('div', 'col-head d' + (d === today ? ' today' : '') + (i === state.selDay ? ' sel' : ''));
    h.innerHTML = `<span>${WD[i]}</span><small>${Number(d.slice(5, 7))}/${Number(d.slice(8))}</small>`;
    board.appendChild(h);
  });
  const times = el('div', 'times');
  for (let m = DAY_START; m < DAY_END; m += SLOT) {
    const t = el('div', 'time' + (m % 60 === 0 ? ' hour' : '')); t.textContent = m === DAY_START ? '' : hm(m);
    times.appendChild(t);
  }
  board.appendChild(times);

  days.forEach((d, i) => {
    const col = el('div', 'day' + (i === state.selDay ? ' sel' : ''));
    for (let m = DAY_START; m < DAY_END; m += SLOT) {
      const b = el('button', 'slot' + (m % 60 === 0 ? ' hour' : ''));
      b.type = 'button';
      const past = `${d}T${hm(m)}` < state.now;
      b.disabled = past;
      b.textContent = past ? '' : '+ ' + hm(m);
      b.setAttribute('aria-label', `${korDate(d)} ${hm(m)} ${past ? '지난 시간' : '빈 시간, 예약하기'}`);
      if (!past) b.onclick = () => openBook(d, m);
      col.appendChild(b);
    }
    for (const bk of state.bookings) {
      const s = Math.max(stampMin(bk.startAt, d), DAY_START), e = Math.min(stampMin(bk.endAt, d), DAY_END);
      if (e <= s) continue;
      const card = el('button', 'booking' + (bk.endAt <= state.now ? ' past' : ''));
      card.type = 'button';
      card.style.top = `calc(var(--slot) * ${(s - DAY_START) / SLOT} + 2px)`;
      card.style.height = `calc(var(--slot) * ${(e - s) / SLOT} - 4px)`;
      card.innerHTML = `<b></b><span>${bk.startAt.slice(11)}~${endLabel(bk.endAt)}</span>`;
      card.querySelector('b').textContent = bk.dept;
      card.setAttribute('aria-label', `${bk.dept} ${bk.startAt.slice(11)}부터 ${endLabel(bk.endAt)}까지 예약됨`);
      card.onclick = () => openDetail(bk);
      col.appendChild(card);
    }
    if (d === today) {
      const nm = Number(state.now.slice(11, 13)) * 60 + Number(state.now.slice(14, 16));
      if (nm >= DAY_START && nm < DAY_END) {
        const line = el('div', 'now-line'); line.style.top = `calc(var(--slot) * ${(nm - DAY_START) / SLOT})`;
        col.appendChild(line);
      }
    }
    board.appendChild(col);
  });
}
function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }

// ---------- 예약하기 ----------
let booking = null, submitting = false;
function openBook(date, startMin) {
  booking = { date };
  $('bkSpace').textContent = spaceName();
  $('bkDate').textContent = korDate(date);
  $('bkErr').textContent = '';
  const nowMin = date === state.now.slice(0, 10) ? Number(state.now.slice(11, 13)) * 60 + Number(state.now.slice(14, 16)) : -1;
  const startSel = $('bkStart'); startSel.innerHTML = '';
  for (let m = DAY_START; m < DAY_END; m += SLOT) {
    if (m < nowMin || isBooked(date, m)) continue;
    startSel.add(new Option(hm(m), m, false, m === startMin));
  }
  startSel.value = startMin;
  fillEnd();
  setupDeptPicker(localStorage.getItem('lastDept') || '');
  $('bkPurpose').value = ''; $('bkPin').value = '';
  $('bookDlg').showModal();
  setTimeout(() => (currentDept() ? $('bkPin') : ($('bkDept').hidden ? $('bkDeptSel') : $('bkDept'))).focus(), 50);
}
function isBooked(date, m) {
  return state.bookings.some(b => stampMin(b.startAt, date) <= m && stampMin(b.endAt, date) > m);
}
function fillEnd() {
  const s = Number($('bkStart').value), endSel = $('bkEnd'); endSel.innerHTML = '';
  // 다음 예약 시작 전까지 연속으로 선택 가능
  let limit = DAY_END;
  for (const b of state.bookings) { const bs = stampMin(b.startAt, booking.date); if (bs > s && bs < limit) limit = bs; }
  for (let m = s + SLOT; m <= limit; m += SLOT) {
    const dur = m - s;
    endSel.add(new Option(`${hm(m)} (${dur >= 60 ? Math.floor(dur / 60) + '시간' : ''}${dur % 60 ? ' 30분' : ''})`.replace('( ', '('), m));
  }
}
$('bkStart').onchange = fillEnd;

// 부서 · 교구 선택 (관리자가 등록한 목록 + 필요시 직접 입력)
const CUSTOM = '__custom__';
function setupDeptPicker(last) {
  const sel = $('bkDeptSel'), inp = $('bkDept'), list = state.depts || [], custom = state.config?.allowCustomDept !== false;
  sel.innerHTML = '';
  if (!list.length) { sel.hidden = true; inp.hidden = false; inp.value = last; return; }
  sel.hidden = false;
  sel.add(new Option('선택해 주세요', ''));
  const groups = {};
  for (const d of list) (groups[d.kind] ||= []).push(d);
  for (const [kind, items] of Object.entries(groups)) {
    const g = document.createElement('optgroup'); g.label = kind;
    for (const d of items) g.appendChild(new Option(d.name, d.name));
    sel.appendChild(g);
  }
  if (custom) sel.add(new Option('직접 입력…', CUSTOM));
  const known = list.some(d => d.name === last);
  sel.value = known ? last : (last && custom ? CUSTOM : '');
  inp.value = known ? '' : (custom ? last : '');
  inp.hidden = sel.value !== CUSTOM;
}
$('bkDeptSel').onchange = () => { const c = $('bkDeptSel').value === CUSTOM; $('bkDept').hidden = !c; if (c) $('bkDept').focus(); };
function currentDept() {
  const sel = $('bkDeptSel');
  if (!sel.hidden && sel.value !== CUSTOM) return sel.value;
  return $('bkDept').value.trim();
}

$('bookForm').onsubmit = async ev => {
  ev.preventDefault();
  if (submitting) return;
  const dept = currentDept(), pin = $('bkPin').value.trim();
  if (!dept) { $('bkErr').textContent = '부서명을 입력해 주세요.'; ($('bkDept').hidden ? $('bkDeptSel') : $('bkDept')).focus(); return; }
  if (!/^\d{4}$/.test(pin)) { $('bkErr').textContent = '취소용 비밀번호를 숫자 4자리로 입력해 주세요.'; $('bkPin').focus(); return; }
  const s = Number($('bkStart').value), e = Number($('bkEnd').value);
  if (!(e > s)) { $('bkErr').textContent = '종료 시간을 다시 선택해 주세요.'; return; }
  submitting = true; const btn = $('bkSubmit'); btn.disabled = true; btn.textContent = '저장 중…';
  try {
    await api('/api/bookings', { method: 'POST', body: JSON.stringify({
      spaceId: state.spaceId, date: booking.date, start: hm(s), end: hm(e), dept, purpose: $('bkPurpose').value.trim(), pin,
    }) });
    localStorage.setItem('lastDept', dept);
    $('bookDlg').close();
    toast(`예약이 완료되었습니다. (${spaceName()} ${korDate(booking.date)} ${hm(s)}~${hm(e)})`);
    await loadBookings();
  } catch (err) {
    $('bkErr').textContent = err.message;
    if (err.status === 409) loadBookings().then(() => { if ($('bookDlg').open) fillEnd(); });
  } finally { submitting = false; btn.disabled = false; btn.textContent = '예약하기'; }
};

// ---------- 상세 / 취소 ----------
let current = null;
function openDetail(bk) {
  current = bk;
  const info = $('dtInfo'); info.innerHTML = '';
  const rows = [['공간', spaceName()], ['날짜', korDate(bk.startAt.slice(0, 10))], ['시간', `${bk.startAt.slice(11)} ~ ${endLabel(bk.endAt)}`],
    ['부서', bk.dept], ['사용 목적', bk.purpose || '—'], ['신청 시각', bk.createdAt.replace('T', ' ')]];
  for (const [k, v] of rows) { const dt = el('dt', ''), dd = el('dd', ''); dt.textContent = k; dd.textContent = v; info.append(dt, dd); }
  const ended = bk.endAt <= state.now;
  $('cancelArea').hidden = ended; $('dtCancel').hidden = ended;
  $('pinLabel').hidden = state.admin; $('adminHint').hidden = !state.admin;
  $('dtPin').value = ''; $('dtErr').textContent = '';
  $('detailDlg').showModal();
}
$('detailForm').onsubmit = async ev => {
  ev.preventDefault();
  const pin = $('dtPin').value.trim();
  if (!state.admin && !/^\d{4}$/.test(pin)) { $('dtErr').textContent = '예약할 때 정한 숫자 4자리 비밀번호를 입력해 주세요.'; return; }
  $('confirmText').textContent = `${korDate(current.startAt.slice(0, 10))} ${current.startAt.slice(11)}~${endLabel(current.endAt)} · ${current.dept} 예약을 취소합니다.`;
  const cd = $('confirmDlg'); cd.returnValue = ''; cd.showModal();
  cd.onclose = async () => {
    if (cd.returnValue !== 'yes') return;
    const btn = $('dtCancel'); btn.disabled = true;
    try {
      await api(`/api/bookings/${current.id}/cancel`, { method: 'POST', body: JSON.stringify({ pin }) });
      $('detailDlg').close(); toast('예약이 취소되었습니다. 이 시간은 다시 예약할 수 있습니다.');
      loadBookings();
    } catch (err) { $('dtErr').textContent = err.message; if (err.status === 404) { $('detailDlg').close(); loadBookings(); } }
    finally { btn.disabled = false; }
  };
};

// ---------- 관리자 ----------
async function checkAdmin() {
  if (!state.token) { state.admin = false; return; }
  const r = await api('/api/admin/me').catch(() => ({ admin: false }));
  state.admin = r.admin;
  if (!state.admin) { state.token = ''; localStorage.removeItem('adminToken'); }
}
function adminError(err) {
  $('adErr2').textContent = err.message;
  if (err.status === 401) { state.admin = false; state.token = ''; localStorage.removeItem('adminToken'); renderSpaces(); openAdmin(); }
}
function openAdmin(tab = 'info') {
  $('adminLogin').hidden = state.admin; $('adminPanel').hidden = !state.admin;
  $('adErr').textContent = ''; $('adErr2').textContent = ''; $('adPw').value = '';
  if (state.admin) { fillInfo(); renderAdminLists(); showTab(tab); }
  if (!$('adminDlg').open) $('adminDlg').showModal();
  if (!state.admin) setTimeout(() => $('adPw').focus(), 50);
}
function showTab(tab) {
  document.querySelectorAll('#adminPanel [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  document.querySelectorAll('#adminPanel [data-pane]').forEach(p => p.hidden = p.dataset.pane !== tab);
  $('adErr2').textContent = '';
}
document.querySelectorAll('#adminPanel [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('adminBtn').onclick = () => openAdmin();
$('addSpaceBtn').onclick = () => openAdmin('spaces');

$('adminForm').onsubmit = async ev => {   // 로그인
  ev.preventDefault();
  if (state.admin) return;
  const btn = $('adSubmit'); if (btn.disabled) return; btn.disabled = true;
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('adPw').value }) });
    state.token = r.token; state.admin = true; localStorage.setItem('adminToken', r.token);
    toast('관리자로 로그인했습니다.'); renderSpaces(); openAdmin();
  } catch (err) { $('adErr').textContent = err.message; }
  finally { btn.disabled = false; }
};
$('adLogout').onclick = () => {
  state.admin = false; state.token = ''; localStorage.removeItem('adminToken');
  $('adminDlg').close(); renderSpaces(); toast('로그아웃했습니다.');
};

// 기본 정보
function fillInfo() {
  const c = state.config;
  $('setName').value = c.churchName; $('setSub').value = c.subtitle || ''; $('setCustom').checked = c.allowCustomDept;
  $('setPreview').textContent = c.churchName;
}
$('setName').oninput = () => $('setPreview').textContent = $('setName').value.trim() || '교회 이름';
$('saveInfo').onclick = async () => {
  const name = $('setName').value.trim();
  if (!name) { $('adErr2').textContent = '교회 이름을 입력해 주세요.'; return; }
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ churchName: name, subtitle: $('setSub').value.trim(), allowCustomDept: $('setCustom').checked }) });
    await loadSpaces(); toast('기본 정보가 저장되었습니다.');
  } catch (err) { adminError(err); }
};

// 장소 · 부서 목록 편집
function renderAdminLists() {
  const sp = $('spaceEdit'); sp.innerHTML = '';
  for (const s of state.spaces) sp.appendChild(editRow(s, {
    save: name => api(`/api/spaces/${s.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    del: () => confirm(`'${s.name}' 장소를 삭제할까요?\n지난 예약 기록은 이력에 남습니다.`) && api(`/api/spaces/${s.id}`, { method: 'DELETE' }),
  }));
  if (!state.spaces.length) sp.innerHTML = '<li class="empty">등록된 장소가 없습니다. 아래에서 추가해 주세요.</li>';
  const dp = $('deptEdit'); dp.innerHTML = '';
  for (const d of state.depts) dp.appendChild(editRow(d, {
    kind: true,
    save: (name, kind) => api(`/api/departments/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name, kind }) }),
    del: () => confirm(`'${d.name}'을(를) 목록에서 삭제할까요?\n이미 한 예약은 그대로 남습니다.`) && api(`/api/departments/${d.id}`, { method: 'DELETE' }),
  }));
  if (!state.depts.length) dp.innerHTML = '<li class="empty">아직 목록이 없습니다. 목록이 없으면 예약할 때 부서명을 직접 입력합니다.</li>';
}
function editRow(item, { kind, save, del }) {
  const li = el('li', '');
  let kindSel;
  if (kind) {
    kindSel = document.createElement('select');
    const kinds = ['부서', '교구', '기관', '선교회', '기타'];
    if (!kinds.includes(item.kind)) kinds.unshift(item.kind);
    for (const k of kinds) kindSel.add(new Option(k, k, false, k === item.kind));
    li.appendChild(kindSel);
  }
  const inp = document.createElement('input'); inp.value = item.name; inp.maxLength = 30; inp.setAttribute('aria-label', '이름');
  const sv = el('button', 'icon-btn save'); sv.type = 'button'; sv.textContent = '저장';
  const dl = el('button', 'icon-btn del'); dl.type = 'button'; dl.textContent = '삭제';
  sv.onclick = async () => {
    try { await save(inp.value.trim(), kindSel?.value); await loadSpaces(); toast('저장되었습니다.'); }
    catch (err) { adminError(err); }
  };
  dl.onclick = async () => {
    try { const r = await del(); if (r) { await loadSpaces(); loadBookings(); toast('삭제되었습니다.'); } }
    catch (err) { adminError(err); }
  };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); sv.click(); } };
  li.append(inp, sv, dl);
  return li;
}
$('addSpace').onclick = async () => {
  const name = $('newSpace').value.trim();
  if (!name) { $('adErr2').textContent = '장소 이름을 입력해 주세요.'; return; }
  try {
    const s = await api('/api/spaces', { method: 'POST', body: JSON.stringify({ name }) });
    $('newSpace').value = ''; state.spaceId = s.id; localStorage.setItem('spaceId', s.id);
    await loadSpaces(); loadBookings(); toast(`'${s.name}' 장소가 추가되었습니다.`);
  } catch (err) { adminError(err); }
};
$('addDept').onclick = async () => {
  const name = $('newDept').value.trim();
  if (!name) { $('adErr2').textContent = '이름을 입력해 주세요.'; return; }
  try {
    await api('/api/departments', { method: 'POST', body: JSON.stringify({ name, kind: $('newDeptKind').value }) });
    $('newDept').value = ''; await loadSpaces(); toast(`'${name}'이(가) 추가되었습니다.`);
  } catch (err) { adminError(err); }
};
$('newSpace').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('addSpace').click(); } };
$('newDept').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('addDept').click(); } };

// ---------- 이력 ----------
$('logBtn').onclick = async () => {
  try {
    const logs = await api('/api/logs?limit=200');
    const ul = $('logList'); ul.innerHTML = '';
    if (!logs.length) ul.innerHTML = '<li>아직 이력이 없습니다.</li>';
    const label = { book: '예약', cancel: '취소', space_add: '장소', space_edit: '장소', space_delete: '장소', dept_add: '부서', dept_edit: '부서', dept_delete: '부서', settings: '설정' };
    for (const l of logs) {
      const li = el('li', '');
      li.innerHTML = `<span class="tag ${l.action}">${label[l.action] || l.action}</span><span class="d"></span><small></small>`;
      li.querySelector('.d').textContent = `${l.spaceName || ''} · ${l.detail}`;
      li.querySelector('small').textContent = `${l.at.replace('T', ' ')} · ${l.actor}${l.ip ? ' · ' + l.ip : ''}`;
      ul.appendChild(li);
    }
    $('logDlg').showModal();
  } catch (e) { toast(e.message, true); }
};

// 공통 닫기 버튼
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

// ---------- 주 이동 ----------
function setWeek(ws) {
  state.weekStart = ws;
  const today = state.now.slice(0, 10);
  const idx = Math.round((new Date(today) - new Date(ws)) / 864e5);
  state.selDay = idx >= 0 && idx < 7 ? idx : 0;
  loadBookings();
}
$('prevWeek').onclick = () => setWeek(addDays(state.weekStart, -7));
$('nextWeek').onclick = () => setWeek(addDays(state.weekStart, 7));
$('thisWeek').onclick = () => setWeek(mondayOf(kstNow().slice(0, 10)));

// ---------- 실시간 갱신 ----------
function connectLive() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('live').textContent = '● 실시간 연결'; $('live').classList.remove('off'); loadBookings(); };
  es.onerror = () => { $('live').textContent = '● 재연결 중…'; $('live').classList.add('off'); };
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'spaces' || m.type === 'config') loadSpaces().then(loadBookings);
    if (m.type === 'bookings' && m.spaceId === state.spaceId) loadBookings();
  };
}
// 지난 시간 표시 갱신 + 연결 끊김 대비 1분마다 새로고침
setInterval(loadBookings, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadBookings(); });

(async function init() {
  try {
    await checkAdmin();
    await loadSpaces();
    setWeek(mondayOf(kstNow().slice(0, 10)));
    connectLive();
  } catch (e) { toast(e.message, true); }
})();
