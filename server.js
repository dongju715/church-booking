// 감람교회 장소예약 — 서버 (Node.js 22.5+ 내장 모듈만 사용, 외부 의존성 없음)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- 설정 ----------
loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'reservations.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DAY_START = 6 * 60;   // 06:00
const DAY_END = 24 * 60;    // 24:00
const SLOT = 30;            // 30분 단위
const MAX_DAYS_AHEAD = Number(process.env.MAX_DAYS_AHEAD || 180);

if (!ADMIN_PASSWORD) console.warn('[경고] ADMIN_PASSWORD 환경변수가 없어 관리자 로그인이 비활성화됩니다.');
if (!process.env.SESSION_SECRET) console.warn('[경고] SESSION_SECRET이 없어 재시작 시 관리자 로그인이 풀립니다.');

// ---------- 데이터베이스 ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id),
  start_at TEXT NOT NULL,          -- 'YYYY-MM-DDTHH:MM' (Asia/Seoul)
  end_at TEXT NOT NULL,
  dept TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  pin_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | cancelled
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  CHECK (start_at < end_at)
);
CREATE INDEX IF NOT EXISTS idx_bookings_space_time ON bookings(space_id, status, start_at);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,            -- book | cancel | space_add
  booking_id INTEGER,
  space_name TEXT,
  detail TEXT NOT NULL,
  actor TEXT NOT NULL,             -- 예약자 | 관리자
  ip TEXT,
  at TEXT NOT NULL
);
-- DB 레벨 최종 방어선: 같은 공간의 활성 예약끼리 시간이 겹치면 INSERT/UPDATE 자체를 거부
-- (끝 시간 = 다음 시작 시간은 허용: 부등호가 엄격함)
CREATE TRIGGER IF NOT EXISTS trg_no_overlap_insert
BEFORE INSERT ON bookings WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM bookings WHERE space_id = NEW.space_id AND status = 'active'
      AND start_at < NEW.end_at AND end_at > NEW.start_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_no_overlap_update
BEFORE UPDATE OF start_at, end_at, status, space_id ON bookings WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM bookings WHERE space_id = NEW.space_id AND status = 'active' AND id <> NEW.id
      AND start_at < NEW.end_at AND end_at > NEW.start_at);
END;
`);
// ---- 교회별 설정 (교회 이름, 부서/교구) ----
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT '부서',   -- 부서 | 교구 | 기관 등 자유 분류
  sort INTEGER NOT NULL DEFAULT 0
);`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('spaces') WHERE name = 'active'").get())
  db.exec('ALTER TABLE spaces ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSetting.run('churchName', process.env.CHURCH_NAME || '우리교회');
seedSetting.run('subtitle', process.env.CHURCH_SUBTITLE || 'CHURCH · SPACE BOOKING');
seedSetting.run('allowCustomDept', '1');
if (db.prepare('SELECT COUNT(*) AS n FROM spaces').get().n === 0) {
  const ins = db.prepare('INSERT INTO spaces (name, sort, created_at) VALUES (?, ?, ?)');
  (process.env.DEFAULT_SPACES || '본당,소예배실,교육관').split(',').map(s => s.trim()).filter(Boolean)
    .forEach((n, i) => ins.run(n, i, nowKst()));
}
function getSettings() {
  const s = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  return { churchName: s.churchName, subtitle: s.subtitle, allowCustomDept: s.allowCustomDept === '1' };
}
const cleanName = (v, max = 30) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max + 1);

// ---------- 시간 유틸 (Asia/Seoul = UTC+9, 서머타임 없음) ----------
function nowKst() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16); }
function toMin(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
function validDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function stamp(date, min) { // 24:00 → 다음날 00:00
  if (min >= 1440) return addDays(date, 1) + 'T00:00';
  return `${date}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ---------- 보안 유틸 ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, h] = stored.split(':');
  const a = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(a, Buffer.from(h, 'hex'));
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function isAdmin(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [body, sig] = tok.split('.');
  if (!body || !sig) return false;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.role === 'admin' && p.exp > Date.now(); }
  catch { return false; }
}
// 간단한 시도 횟수 제한 (무차별 대입 방지)
const attempts = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (now > a.reset) { a.n = 0; a.reset = now + windowMs; }
  a.n++; attempts.set(key, a);
  return a.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k); }, 60e3).unref();

// ---------- 실시간 갱신 (Server-Sent Events) ----------
const clients = new Set();
function broadcast(evt) {
  const msg = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3).unref();

// ---------- HTTP ----------
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { send(res, status, { error: message }); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('bad json')); } });
  });
}
function clientIp(req) {
  return (process.env.TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;
}
function publicBooking(b) {
  return { id: b.id, spaceId: b.space_id, startAt: b.start_at, endAt: b.end_at, dept: b.dept, purpose: b.purpose, createdAt: b.created_at };
}
function log(action, bookingId, spaceName, detail, actor, ip) {
  db.prepare('INSERT INTO logs (action, booking_id, space_name, detail, actor, ip, at) VALUES (?,?,?,?,?,?,?)')
    .run(action, bookingId, spaceName, detail, actor, ip, nowKst());
}

const routes = {
  'GET /api/spaces': (req, res) => {
    send(res, 200, db.prepare('SELECT id, name FROM spaces WHERE active = 1 ORDER BY sort, id').all());
  },

  // 화면 초기 설정 한 번에: 교회 이름, 장소, 부서/교구
  'GET /api/config': (req, res) => {
    send(res, 200, {
      ...getSettings(),
      spaces: db.prepare('SELECT id, name FROM spaces WHERE active = 1 ORDER BY sort, id').all(),
      departments: db.prepare('SELECT id, name, kind FROM departments ORDER BY sort, id').all(),
    });
  },

  'PUT /api/settings': async (req, res) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const b = await readJson(req);
    const churchName = cleanName(b.churchName, 20), subtitle = cleanName(b.subtitle, 40);
    if (!churchName || churchName.length > 20) return fail(res, 400, '교회 이름을 1~20자로 입력해 주세요.');
    if (subtitle.length > 40) return fail(res, 400, '영문 부제는 40자 이내로 입력해 주세요.');
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    up.run('churchName', churchName); up.run('subtitle', subtitle);
    up.run('allowCustomDept', b.allowCustomDept === false ? '0' : '1');
    log('settings', null, null, `기본 정보 변경: ${churchName}`, '관리자', clientIp(req));
    broadcast({ type: 'config' });
    send(res, 200, getSettings());
  },

  'PATCH /api/spaces/:id': async (req, res, url, id) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const n = cleanName((await readJson(req)).name);
    if (!n || n.length > 30) return fail(res, 400, '장소 이름을 1~30자로 입력해 주세요.');
    const s = db.prepare('SELECT * FROM spaces WHERE id = ? AND active = 1').get(Number(id));
    if (!s) return fail(res, 404, '없는 장소입니다.');
    try { db.prepare('UPDATE spaces SET name = ? WHERE id = ?').run(n, s.id); }
    catch (e) { if (String(e.message).includes('UNIQUE')) return fail(res, 409, '이미 같은 이름의 장소가 있습니다.'); throw e; }
    log('space_edit', null, n, `장소 이름 변경: ${s.name} → ${n}`, '관리자', clientIp(req));
    broadcast({ type: 'config' });
    send(res, 200, { id: s.id, name: n });
  },

  'DELETE /api/spaces/:id': (req, res, url, id) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const s = db.prepare('SELECT * FROM spaces WHERE id = ? AND active = 1').get(Number(id));
    if (!s) return fail(res, 404, '없는 장소입니다.');
    const future = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE space_id = ? AND status = 'active' AND end_at > ?`).get(s.id, nowKst()).n;
    if (future) return fail(res, 409, `이 장소에 앞으로 있을 예약이 ${future}건 있습니다. 예약을 먼저 취소한 뒤 삭제해 주세요.`);
    // 과거 기록 보존을 위해 숨김 처리하고 이름은 비워 둠(같은 이름 재사용 가능)
    db.prepare('UPDATE spaces SET active = 0, name = ? WHERE id = ?').run(`${s.name} (삭제됨 #${s.id})`, s.id);
    log('space_delete', null, s.name, `장소 삭제: ${s.name}`, '관리자', clientIp(req));
    broadcast({ type: 'config' });
    send(res, 200, { ok: true });
  },

  'POST /api/departments': async (req, res) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const b = await readJson(req);
    const n = cleanName(b.name), kind = cleanName(b.kind || '부서', 10) || '부서';
    if (!n || n.length > 30) return fail(res, 400, '이름을 1~30자로 입력해 주세요.');
    try {
      const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM departments').get().s;
      const r = db.prepare('INSERT INTO departments (name, kind, sort) VALUES (?,?,?)').run(n, kind, sort);
      log('dept_add', null, null, `${kind} 추가: ${n}`, '관리자', clientIp(req));
      broadcast({ type: 'config' });
      send(res, 201, { id: Number(r.lastInsertRowid), name: n, kind });
    } catch (e) { if (String(e.message).includes('UNIQUE')) return fail(res, 409, '이미 같은 이름이 있습니다.'); throw e; }
  },

  'PATCH /api/departments/:id': async (req, res, url, id) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const b = await readJson(req);
    const d = db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(id));
    if (!d) return fail(res, 404, '없는 항목입니다.');
    const n = b.name === undefined ? d.name : cleanName(b.name), kind = b.kind === undefined ? d.kind : (cleanName(b.kind, 10) || '부서');
    if (!n || n.length > 30) return fail(res, 400, '이름을 1~30자로 입력해 주세요.');
    try { db.prepare('UPDATE departments SET name = ?, kind = ? WHERE id = ?').run(n, kind, d.id); }
    catch (e) { if (String(e.message).includes('UNIQUE')) return fail(res, 409, '이미 같은 이름이 있습니다.'); throw e; }
    log('dept_edit', null, null, `${d.name} → ${n} (${kind})`, '관리자', clientIp(req));
    broadcast({ type: 'config' });
    send(res, 200, { id: d.id, name: n, kind });
  },

  'DELETE /api/departments/:id': (req, res, url, id) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const d = db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(id));
    if (!d) return fail(res, 404, '없는 항목입니다.');
    db.prepare('DELETE FROM departments WHERE id = ?').run(d.id); // 기존 예약의 부서명 기록은 그대로 남음
    log('dept_delete', null, null, `${d.kind} 삭제: ${d.name}`, '관리자', clientIp(req));
    broadcast({ type: 'config' });
    send(res, 200, { ok: true });
  },

  'POST /api/spaces': async (req, res) => {
    if (!isAdmin(req)) return fail(res, 401, '관리자 로그인이 필요합니다.');
    const { name } = await readJson(req);
    const n = String(name || '').trim();
    if (!n || n.length > 30) return fail(res, 400, '공간 이름을 1~30자로 입력해 주세요.');
    try {
      const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM spaces').get().s;
      const r = db.prepare('INSERT INTO spaces (name, sort, created_at) VALUES (?,?,?)').run(n, sort, nowKst());
      log('space_add', null, n, `공간 추가: ${n}`, '관리자', clientIp(req));
      broadcast({ type: 'spaces' });
      send(res, 201, { id: Number(r.lastInsertRowid), name: n });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(res, 409, '이미 같은 이름의 공간이 있습니다.');
      throw e;
    }
  },

  'GET /api/bookings': (req, res, url) => {
    const spaceId = Number(url.searchParams.get('spaceId'));
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!spaceId || !validDate(from) || !validDate(to)) return fail(res, 400, '조회 조건이 올바르지 않습니다.');
    const rows = db.prepare(`SELECT * FROM bookings WHERE space_id = ? AND status = 'active'
      AND start_at < ? AND end_at > ? ORDER BY start_at`).all(spaceId, addDays(to, 1) + 'T00:00', from + 'T00:00');
    send(res, 200, { now: nowKst(), bookings: rows.map(publicBooking) });
  },

  'POST /api/bookings': async (req, res) => {
    const ip = clientIp(req);
    if (limited('book:' + ip, 120, 60e3)) return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const b = await readJson(req);
    const spaceId = Number(b.spaceId);
    const dept = String(b.dept || '').trim();
    const purpose = String(b.purpose || '').trim();
    const pin = String(b.pin || '');
    const s = toMin(b.start), e = b.end === '24:00' ? 1440 : toMin(b.end);
    const space = db.prepare('SELECT * FROM spaces WHERE id = ? AND active = 1').get(spaceId);
    if (!space) return fail(res, 400, '장소를 다시 선택해 주세요.');
    if (!validDate(b.date)) return fail(res, 400, '날짜가 올바르지 않습니다.');
    if (!dept) return fail(res, 400, '부서명을 입력해 주세요.');
    if (dept.length > 30) return fail(res, 400, '부서명은 30자 이내로 입력해 주세요.');
    if (!getSettings().allowCustomDept && !db.prepare('SELECT 1 FROM departments WHERE name = ?').get(dept))
      return fail(res, 400, '목록에 있는 부서·교구를 선택해 주세요.');
    if (purpose.length > 200) return fail(res, 400, '사용 목적은 200자 이내로 입력해 주세요.');
    if (!/^\d{4}$/.test(pin)) return fail(res, 400, '취소용 비밀번호는 숫자 4자리로 입력해 주세요.');
    if (isNaN(s) || isNaN(e) || s % SLOT || e % SLOT || s < DAY_START || e > DAY_END || s >= e)
      return fail(res, 400, '예약 시간이 올바르지 않습니다. 종료 시간은 시작 시간보다 늦어야 합니다.');
    const startAt = stamp(b.date, s), endAt = stamp(b.date, e);
    const now = nowKst();
    if (startAt < now) return fail(res, 400, '이미 지난 시간은 예약할 수 없습니다.');
    if (b.date > addDays(now.slice(0, 10), MAX_DAYS_AHEAD)) return fail(res, 400, `예약은 오늘부터 ${MAX_DAYS_AHEAD}일 이내만 가능합니다.`);

    try {
      // BEGIN IMMEDIATE: 쓰기 잠금을 먼저 잡아 검사~저장 사이에 다른 예약이 끼어들 수 없게 함
      db.exec('BEGIN IMMEDIATE');
      const clash = db.prepare(`SELECT dept, start_at, end_at FROM bookings WHERE space_id = ? AND status = 'active'
        AND start_at < ? AND end_at > ? LIMIT 1`).get(spaceId, endAt, startAt);
      if (clash) {
        db.exec('ROLLBACK');
        return fail(res, 409, `이미 예약된 시간입니다. (${clash.dept} ${clash.start_at.slice(11)}~${clash.end_at.slice(11) === '00:00' ? '24:00' : clash.end_at.slice(11)}) 다른 시간을 선택해 주세요.`);
      }
      const r = db.prepare(`INSERT INTO bookings (space_id, start_at, end_at, dept, purpose, pin_hash, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(spaceId, startAt, endAt, dept, purpose, hashPin(pin), now);
      const id = Number(r.lastInsertRowid);
      log('book', id, space.name, `${b.date} ${b.start}~${b.end} · ${dept}${purpose ? ' · ' + purpose : ''}`, '예약자', ip);
      db.exec('COMMIT');
      broadcast({ type: 'bookings', spaceId });
      send(res, 201, publicBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id)));
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(err.message).includes('BOOKING_OVERLAP'))
        return fail(res, 409, '방금 다른 분이 이 시간을 먼저 예약했습니다. 다른 시간을 선택해 주세요.');
      throw err;
    }
  },

  'POST /api/bookings/:id/cancel': async (req, res, url, id) => {
    const ip = clientIp(req);
    const { pin } = await readJson(req);
    const b = db.prepare('SELECT b.*, s.name AS space_name FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE b.id = ?').get(Number(id));
    if (!b || b.status !== 'active') return fail(res, 404, '이미 취소되었거나 없는 예약입니다.');
    const admin = isAdmin(req);
    if (!admin) {
      if (limited('pin:' + b.id + ':' + ip, 10, 10 * 60e3)) return fail(res, 429, '비밀번호를 여러 번 틀렸습니다. 10분 후 다시 시도해 주세요.');
      if (!/^\d{4}$/.test(String(pin || '')) || !checkPin(pin, b.pin_hash))
        return fail(res, 403, '취소용 비밀번호가 맞지 않습니다. 예약할 때 정한 숫자 4자리를 입력해 주세요.');
    }
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowKst(), b.id);
    const end = b.end_at.slice(11) === '00:00' ? '24:00' : b.end_at.slice(11);
    log('cancel', b.id, b.space_name, `${b.start_at.slice(0, 10)} ${b.start_at.slice(11)}~${end} · ${b.dept}`, admin ? '관리자' : '예약자', ip);
    broadcast({ type: 'bookings', spaceId: b.space_id });
    send(res, 200, { ok: true });
  },

  'GET /api/logs': (req, res, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const admin = isAdmin(req);
    const rows = db.prepare('SELECT id, action, booking_id AS bookingId, space_name AS spaceName, detail, actor, at' + (admin ? ', ip' : '') +
      ' FROM logs ORDER BY id DESC LIMIT ?').all(limit);
    send(res, 200, rows);
  },

  'POST /api/admin/login': async (req, res) => {
    const ip = clientIp(req);
    if (limited('login:' + ip, 5, 10 * 60e3)) return fail(res, 429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
    const { password } = await readJson(req);
    const a = crypto.createHash('sha256').update(String(password || '')).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!ADMIN_PASSWORD || !crypto.timingSafeEqual(a, b)) return fail(res, 401, '관리자 비밀번호가 맞지 않습니다.');
    send(res, 200, { token: signToken({ role: 'admin', exp: Date.now() + 12 * 3600e3 }) });
  },

  'GET /api/admin/me': (req, res) => send(res, 200, { admin: isAdmin(req) }),

  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },

  'GET /healthz': (req, res) => send(res, 200, { ok: true, now: nowKst() }),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let handler, param;
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) handler = routes[key];
  else {
    const m = /^(\/api\/\w+)\/(\d+)(\/\w+)?$/.exec(url.pathname);
    if (m) { handler = routes[`${req.method} ${m[1]}/:id${m[3] || ''}`]; param = m[2]; }
  }
  try {
    if (handler) return await handler(req, res, url, param);
    if (url.pathname.startsWith('/api/')) return fail(res, 404, '없는 요청입니다.');
    // 정적 파일
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) fail(res, 500, '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`감람교회 장소예약 서버 실행 중: http://localhost:${PORT}`));
}
module.exports = { server, db };

function loadDotEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
