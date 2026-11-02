// 물결마을 낚시터 서버 (Render + Supabase)
// - 게임 화면(index.html)을 그대로 보내 줍니다.
// - 웹소켓(/ws)으로 로그인 · 저장 · 친구 위치를 주고받습니다.
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const MAX_PLAYERS = 16;          // 동시 접속 최대 (5명 기준이라 넉넉하게)
const SNAP_MS = 100;             // 친구 위치를 보내는 간격 (초당 10번)
const SAVE_MS = 5000;            // 같은 사람의 저장은 최소 5초 간격으로 DB에 씀

/* ---------- 저장소: Supabase (없으면 메모리 — 테스트용) ---------- */
let db;
if (SB_URL && SB_KEY) {
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  db = {
    async get(key) {
      const { data, error } = await sb.from('players').select('name,code_hash,save').eq('key', key).maybeSingle();
      if (error) throw error;
      return data;
    },
    async create(key, name, codeHash) {
      const { error } = await sb.from('players').insert({ key, name, code_hash: codeHash, save: null });
      if (error) throw error;
    },
    async save(key, save) {
      const { error } = await sb.from('players').update({ save, updated_at: new Date().toISOString() }).eq('key', key);
      if (error) throw error;
    }
  };
  console.log('Supabase 연결 설정됨');
} else {
  const mem = new Map();
  db = {
    async get(key) { return mem.get(key) || null; },
    async create(key, name, codeHash) { mem.set(key, { name, code_hash: codeHash, save: null }); },
    async save(key, save) { const r = mem.get(key); if (r) r.save = save; }
  };
  console.warn('⚠ SUPABASE_URL / SUPABASE_SECRET_KEY가 없어 메모리에만 저장합니다 (서버가 꺼지면 사라져요).');
}

/* ---------- 코드(비밀번호) 해시 ---------- */
function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(code, salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkCode(code, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(code, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- HTTP: 게임 파일 + 상태 확인 ---------- */
const app = express();
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/health', (req, res) => res.json({ ok: true, online: players.size }));
const server = http.createServer(app);

/* ---------- 웹소켓 ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
const players = new Map();   // ws -> {id,key,name,color,x,y,d,m,dirty}
let nextId = 1;
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const ws of players.keys()) if (ws !== except && ws.readyState === 1) ws.send(s); };
const colorOf = name => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 6; };

const pending = new Map();   // key -> {save, timer}
function queueSave(key, save) {
  const p = pending.get(key) || {};
  p.save = save;
  if (!p.timer) p.timer = setTimeout(() => flushSave(key), SAVE_MS);
  pending.set(key, p);
}
async function flushSave(key) {
  const p = pending.get(key); if (!p) return;
  pending.delete(key); clearTimeout(p.timer);
  try { await db.save(key, p.save); } catch (e) { console.error('저장 실패', key, e.message); }
}

wss.on('connection', (ws) => {
  ws.alive = true; ws.fails = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async (raw) => {
    ws.alive = true;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const me = players.get(ws);

    if (m.t === 'login' && !me && !ws.busy) {
      ws.busy = true;
      try {
        const name = String(m.name || '').trim().replace(/\s+/g, ' ');
        const code = String(m.code || '').trim();
        if (name.length < 2 || name.length > 10) return send(ws, { t: 'login_fail', msg: '닉네임은 2~10글자로 해 주세요.' });
        if (!/^\d{4,8}$/.test(code)) return send(ws, { t: 'login_fail', msg: '코드는 숫자 4~8자리예요.' });
        if (players.size >= MAX_PLAYERS) return send(ws, { t: 'login_fail', msg: '마을이 꽉 찼어요. 잠시 뒤에 다시 와 주세요.' });
        if (ws.fails >= 5) return send(ws, { t: 'login_fail', msg: '잠시 뒤에 다시 시도해 주세요.' });
        const key = name.toLowerCase();
        let row = await db.get(key), isNew = false;
        if (!row) { await db.create(key, name, hashCode(code)); row = { name, save: null }; isNew = true; }
        else if (!checkCode(code, row.code_hash)) { ws.fails++; await new Promise(r => setTimeout(r, 500)); return send(ws, { t: 'login_fail', msg: '코드가 맞지 않아요.' }); }
        // 같은 닉네임이 이미 접속 중이면 예전 접속을 끊음
        for (const [ows, op] of players) if (op.key === key) { send(ows, { t: 'kicked' }); ows.close(); }
        if (pending.has(key)) { const p = pending.get(key); row.save = p.save; }
        const p = { id: nextId++, key, name: row.name, color: colorOf(key), x: 0, y: 0, d: 'down', m: 0, here: false };
        players.set(ws, p);
        send(ws, { t: 'login_ok', id: p.id, name: p.name, color: p.color, save: row.save, isNew });
        // 지금 있는 친구들 알려 주기 / 내가 왔다고 알리기
        for (const [ows, op] of players) if (ows !== ws) send(ws, { t: 'join', id: op.id, name: op.name, color: op.color, x: op.x, y: op.y, d: op.d, here: op.here });
        broadcast({ t: 'join', id: p.id, name: p.name, color: p.color }, ws);
        console.log('접속', p.name, '현재', players.size, '명');
      } catch (e) {
        console.error('로그인 오류', e.message);
        send(ws, { t: 'login_fail', msg: '서버 저장소에 연결하지 못했어요. 잠시 뒤에 다시 시도해 주세요.' });
      } finally { ws.busy = false; }
      return;
    }
    if (!me) return;
    if (m.t === 'pos') {
      const x = Number(m.x), y = Number(m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      me.x = Math.round(x); me.y = Math.round(y);
      me.d = ['up', 'down', 'left', 'right'].includes(m.d) ? m.d : 'down';
      me.m = m.m ? 1 : 0; me.here = true; me.dirty = true;
    } else if (m.t === 'save' && m.data && typeof m.data === 'object') {
      queueSave(me.key, m.data);
    }
  });
  ws.on('close', () => {
    const p = players.get(ws); if (!p) return;
    players.delete(ws);
    flushSave(p.key);
    broadcast({ t: 'leave', id: p.id });
    console.log('나감', p.name, '현재', players.size, '명');
  });
});

// 친구 위치 묶어서 보내기
setInterval(() => {
  const list = [];
  for (const p of players.values()) if (p.here && p.dirty) { list.push([p.id, p.x, p.y, p.d, p.m]); p.dirty = false; }
  if (list.length) broadcast({ t: 's', p: list });
}, SNAP_MS);

// 끊긴 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) { }
  }
}, 30000);

// Render가 서버를 끌 때 남은 저장을 마저 씀
async function shutdown() {
  console.log('종료: 남은 저장을 기록하는 중');
  await Promise.all([...pending.keys()].map(flushSave));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log('물결마을 서버 시작: 포트 ' + PORT));
