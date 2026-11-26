// 핵심 기능 통합 테스트: 실제 서버를 임시 DB로 띄워서 HTTP로 검증
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
let proc;
const j = (p, o = {}) => fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } })
  .then(async r => ({ status: r.status, body: await r.json() }));
const post = (p, body, h) => j(p, { method: 'POST', body: JSON.stringify(body), headers: h });
const kstDate = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const D = kstDate(7);

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DB_PATH: path.join(dir, 't.db'), ADMIN_PASSWORD: 'admin-pw', CHURCH_NAME: '우리교회', SESSION_SECRET: 'x'.repeat(32) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

let spaceId;
test('기본 공간 3개', async () => {
  const r = await j('/api/spaces');
  assert.deepStrictEqual(r.body.map(s => s.name), ['본당', '소예배실', '교육관']);
  spaceId = r.body[0].id;
});

test('예약 성공 + 조회', async () => {
  const r = await post('/api/bookings', { spaceId, date: D, start: '10:00', end: '11:30', dept: '청년부', purpose: '연습', pin: '1234' });
  assert.strictEqual(r.status, 201);
  const g = await j(`/api/bookings?spaceId=${spaceId}&from=${D}&to=${D}`);
  assert.strictEqual(g.body.bookings.length, 1);
  assert.strictEqual(g.body.bookings[0].dept, '청년부');
  assert.ok(!('pin_hash' in g.body.bookings[0]));
});

test('겹치는 예약 거부, 경계 맞닿음 허용', async () => {
  let r = await post('/api/bookings', { spaceId, date: D, start: '11:00', end: '12:00', dept: '찬양대', pin: '1111' });
  assert.strictEqual(r.status, 409); assert.match(r.body.error, /이미 예약된 시간/);
  r = await post('/api/bookings', { spaceId, date: D, start: '09:00', end: '13:00', dept: '찬양대', pin: '1111' });
  assert.strictEqual(r.status, 409);
  r = await post('/api/bookings', { spaceId, date: D, start: '11:30', end: '12:00', dept: '찬양대', pin: '1111' });
  assert.strictEqual(r.status, 201, '끝=시작 은 허용');
  r = await post('/api/bookings', { spaceId, date: D, start: '09:30', end: '10:00', dept: '찬양대', pin: '1111' });
  assert.strictEqual(r.status, 201);
});

test('입력 검증: 부서명 필수, 잘못된 범위, 과거 시간', async () => {
  let r = await post('/api/bookings', { spaceId, date: D, start: '14:00', end: '15:00', dept: '  ', pin: '1111' });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /부서명/);
  r = await post('/api/bookings', { spaceId, date: D, start: '15:00', end: '14:00', dept: 'a', pin: '1111' });
  assert.strictEqual(r.status, 400);
  r = await post('/api/bookings', { spaceId, date: D, start: '14:10', end: '15:00', dept: 'a', pin: '1111' });
  assert.strictEqual(r.status, 400);
  r = await post('/api/bookings', { spaceId, date: kstDate(-1), start: '14:00', end: '15:00', dept: 'a', pin: '1111' });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /지난 시간/);
});

test('동시에 같은 시간 20건 요청 → 1건만 성공', async () => {
  const reqs = Array.from({ length: 20 }, (_, i) =>
    post('/api/bookings', { spaceId, date: D, start: '18:00', end: '19:00', dept: '부서' + i, pin: '0000' }));
  const res = await Promise.all(reqs);
  assert.strictEqual(res.filter(r => r.status === 201).length, 1);
  assert.strictEqual(res.filter(r => r.status === 409).length, 19);
});

test('DB 트리거가 직접 INSERT 중복도 막음', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec('PRAGMA busy_timeout=5000');
  assert.throws(() => db.prepare(`INSERT INTO bookings (space_id,start_at,end_at,dept,pin_hash,created_at) VALUES (?,?,?,?,?,?)`)
    .run(spaceId, D + 'T18:30', D + 'T19:30', 'x', 'x:y', 'now'), /BOOKING_OVERLAP/);
  db.close();
});

test('다른 공간은 같은 시간 예약 가능', async () => {
  const r = await post('/api/bookings', { spaceId: spaceId + 1, date: D, start: '10:00', end: '11:30', dept: '유년부', pin: '2222' });
  assert.strictEqual(r.status, 201);
});

test('취소: 비밀번호 틀리면 거부, 맞으면 성공 후 재예약 가능', async () => {
  const g = await j(`/api/bookings?spaceId=${spaceId}&from=${D}&to=${D}`);
  const b = g.body.bookings.find(x => x.dept === '청년부');
  let r = await post(`/api/bookings/${b.id}/cancel`, { pin: '9999' });
  assert.strictEqual(r.status, 403);
  r = await post(`/api/bookings/${b.id}/cancel`, { pin: '1234' });
  assert.strictEqual(r.status, 200);
  r = await post('/api/bookings', { spaceId, date: D, start: '10:00', end: '11:30', dept: '장년부', pin: '3333' });
  assert.strictEqual(r.status, 201);
});

test('관리자: 인증 없이 공간 추가 불가, 로그인 후 추가·강제취소', async () => {
  let r = await post('/api/spaces', { name: '카페' });
  assert.strictEqual(r.status, 401);
  r = await post('/api/admin/login', { password: 'wrong' });
  assert.strictEqual(r.status, 401);
  r = await post('/api/admin/login', { password: 'admin-pw' });
  const H = { Authorization: 'Bearer ' + r.body.token };
  r = await post('/api/spaces', { name: '카페' }, H);
  assert.strictEqual(r.status, 201);
  r = await post('/api/spaces', { name: '카페' }, H);
  assert.strictEqual(r.status, 409);
  const g = await j(`/api/bookings?spaceId=${spaceId}&from=${D}&to=${D}`);
  r = await post(`/api/bookings/${g.body.bookings[0].id}/cancel`, {}, H);
  assert.strictEqual(r.status, 200);
  r = await post('/api/spaces', { name: '해킹' }, { Authorization: 'Bearer abc.def' });
  assert.strictEqual(r.status, 401);
});

test('이력 기록', async () => {
  const r = await j('/api/logs');
  const acts = r.body.map(l => l.action);
  assert.ok(acts.includes('book') && acts.includes('cancel') && acts.includes('space_add'));
  assert.ok(!('ip' in r.body[0]), '비관리자에게 IP 비공개');
});

test('실시간 이벤트(SSE) 수신', async () => {
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // retry 라인
  post('/api/bookings', { spaceId, date: D, start: '20:00', end: '21:00', dept: 'SSE', pin: '1111' });
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /"type":"bookings"/);
  ctrl.abort();
});

test('교회별 설정: 이름·장소·부서 관리', async () => {
  const H = { Authorization: 'Bearer ' + (await post('/api/admin/login', { password: 'admin-pw' })).body.token };
  let c = await j('/api/config');
  assert.strictEqual(c.body.churchName, '우리교회');
  assert.strictEqual((await j('/api/settings', { method: 'PUT', body: '{"churchName":"해킹"}' })).status, 401);
  let r = await j('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ churchName: '샘물교회', subtitle: 'SAEMMUL', allowCustomDept: false }) });
  assert.strictEqual(r.status, 200);
  // 부서/교구
  r = await post('/api/departments', { name: '청년부', kind: '부서' }, H); assert.strictEqual(r.status, 201);
  const d2 = (await post('/api/departments', { name: '1교구', kind: '교구' }, H)).body;
  assert.strictEqual((await post('/api/departments', { name: '청년부' }, H)).status, 409);
  r = await j(`/api/departments/${d2.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: '2교구' }) });
  assert.strictEqual(r.body.name, '2교구');
  c = await j('/api/config');
  assert.strictEqual(c.body.churchName, '샘물교회');
  assert.deepStrictEqual(c.body.departments.map(d => d.name), ['청년부', '2교구']);
  // 직접 입력 금지 시 목록 외 부서 거부
  const sid = c.body.spaces[0].id;
  r = await post('/api/bookings', { spaceId: sid, date: D, start: '07:00', end: '07:30', dept: '없는부서', pin: '1111' });
  assert.strictEqual(r.status, 400);
  r = await post('/api/bookings', { spaceId: sid, date: D, start: '07:00', end: '07:30', dept: '2교구', pin: '1111' });
  assert.strictEqual(r.status, 201);
  // 장소 이름 변경, 미래 예약 있으면 삭제 거부, 없으면 삭제
  r = await j(`/api/spaces/${sid}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: '대예배실' }) });
  assert.strictEqual(r.body.name, '대예배실');
  assert.strictEqual((await j(`/api/spaces/${sid}`, { method: 'DELETE', headers: H })).status, 409);
  const sp = (await post('/api/spaces', { name: '임시방' }, H)).body;
  assert.strictEqual((await j(`/api/spaces/${sp.id}`, { method: 'DELETE', headers: H })).status, 200);
  c = await j('/api/config');
  assert.ok(!c.body.spaces.some(s => s.name === '임시방'));
  assert.strictEqual((await post('/api/spaces', { name: '임시방' }, H)).status, 201, '삭제한 이름 재사용 가능');
  r = await post('/api/bookings', { spaceId: sp.id, date: D, start: '08:00', end: '09:00', dept: '청년부', pin: '1111' });
  assert.strictEqual(r.status, 400, '삭제된 장소는 예약 불가');
});
