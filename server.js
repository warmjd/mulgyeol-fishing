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
    },
    // 4단계: 교환소 게시판 · 받은 소식
    async posts() {
      const { data, error } = await sb.from('trade_posts').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    async addPost(p) { const { error } = await sb.from('trade_posts').insert(p); if (error) throw error; },
    async delPost(id) { const { error } = await sb.from('trade_posts').delete().eq('id', id); if (error) throw error; },
    async mails() {
      const since = new Date(Date.now() - 14 * 864e5).toISOString();
      const { data, error } = await sb.from('trade_mail').select('to_key,text,created_at').gte('created_at', since).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    async addMail(m) { const { error } = await sb.from('trade_mail').insert(m); if (error) throw error; },
    // 낚싯대 강화 순위 (저장 안의 enh만 읽음)
    async ranks() {
      const { data, error } = await sb.from('players').select('key,name,enh:save->enh');
      if (error) throw error;
      return data;
    },
    async roster() {   // 직업 현황판: 모두의 직업 · 마을 레벨
      const { data, error } = await sb.from('players').select('key,name,job:save->job,vl:save->vl,boat:save->boat,dex:save->dex');
      if (error) throw error;
      return data;
    }
  };
  console.log('Supabase 연결 설정됨');
} else {
  const mem = new Map();
  db = {
    async get(key) { return mem.get(key) || null; },
    async create(key, name, codeHash) { mem.set(key, { name, code_hash: codeHash, save: null }); },
    async save(key, save) { const r = mem.get(key); if (r) r.save = save; },
    async posts() { return []; }, async addPost() {}, async delPost() {},
    async mails() { return []; }, async addMail() {},
    async ranks() { return [...mem.entries()].map(([key, r]) => ({ key, name: r.name, enh: r.save && r.save.enh })); },
    async roster() { return [...mem.entries()].map(([key, r]) => ({ key, name: r.name, job: r.save && r.save.job, vl: r.save && r.save.vl, boat: r.save && r.save.boat, dex: r.save && r.save.dex })); }
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

/* ---------- 3·4단계: 외형 · 가방 검증 · 교환 ---------- */
const FISH_N = 200;                                   // 게임의 본 도감 물고기 수
const SEASON_FISH = [[1, 1], [0, 2], [2, 3], [3, 5], [0, 2], [1, 3], [2, 4], [3, 5]]; // 계절 한정 [희귀도, 낚시터] — 게임의 SEASONS 순서
const ISLE_FIRST = FISH_N + SEASON_FISH.length, ISLE_N = 20;   // 2부 안개 섬 20종 (id 208~227)
const PTY_FIRST = ISLE_FIRST + ISLE_N, PTY_RAR = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 4], BOSS_ID = PTY_FIRST + 12;   // 배낚시 12종 (228~239) + 거대 참다랑어 (240)
const MK_FIRST = BOSS_ID + 1, MK_RAR = [0, 0, 0, 1, 1, 2];   // 물결 시장 6종 (241~246)
const FISH_MAX = MK_FIRST + MK_RAR.length;
const ZONE_PRICE = [8, 30, 90, 280, 950, 2000, 400, 100], RAR_MULT = [1, 2.2, 5, 14, 45];
const rarOf = i => i < 8 ? 0 : i < 14 ? 1 : i < 18 ? 2 : i < 19 ? 3 : 4;
function fishPrice(id) {
  let z, r;
  if (id < 100) { z = Math.floor(id / 20); r = rarOf(id % 20); }
  else if (id < FISH_N) { z = Math.floor((id - 100) / 20); r = rarOf((id - 100) % 20); }
  else if (id === BOSS_ID) return 20000;
  else if (id >= MK_FIRST) { z = 7; r = MK_RAR[id - MK_FIRST]; }
  else if (id >= PTY_FIRST) { z = 6; r = PTY_RAR[id - PTY_FIRST]; }
  else if (id >= ISLE_FIRST) { z = 5; r = rarOf(id - ISLE_FIRST); }
  else { const s = SEASON_FISH[id - FISH_N]; if (!s) return 0; r = s[0]; z = s[1] - 1; }
  return Math.max(1, Math.round(ZONE_PRICE[z] * RAR_MULT[r]));
}
const validFish = id => Number.isInteger(id) && id >= 0 && id < FISH_MAX;
const invOf = s => (s && s.inv) || {};
const ITEM_IDS = ['flesh', 'scale', 'note', 'shell', 'weed', 'pearl', 'feather', 'thread', 'sail', 'toy', 'map', 'b_dough', 'b_shine', 'b_legend', 'soup', 'grill', 'snack', 'charm'];   // index.html ITEMS와 같아야 해요
const itemsOf = s => (s && s.items && typeof s.items === 'object') ? s.items : {};
/* 교환 열쇠: 물고기 번호 · 'i:아이템' · 'g'(골드) */
const keyKind = k => k === 'g' ? 'g' : (typeof k === 'string' && k.startsWith('i:') && ITEM_IDS.includes(k.slice(2))) ? 'i' : validFish(+k) && String(+k) === String(k) ? 'f' : null;
function hasKey(s, k, n) { const t = keyKind(k); if (t === 'g') return (Number(s && s.gold) || 0) >= n; if (t === 'i') return (itemsOf(s)[k.slice(2)] | 0) >= n; if (t === 'f') return has(s, +k, n); return false; }
const has = (s, id, n) => (invOf(s)[id] | 0) >= n;
/* 직업 노드 단계 (index.html의 rk와 같아요) */
const JOB_LOCK_MS = 14 * 864e5;   // 직업을 바꾸면 2주 동안 끝 노드가 꺼져요
const jobLocked = s => { const j = s && s.job; return !!(j && j.ch && Date.now() - j.ch < JOB_LOCK_MS); };
const jobRank = (s, job, node) => { const j = s && s.job; if (!j || j.id !== job || !j.pts || !j.pts[job]) return 0; if (node === 'cap' && jobLocked(s)) return 0; return j.pts[job][node] | 0; };
const VL_CUM = [0, 0]; for (let L = 1; L < 30; L++) VL_CUM[L + 1] = VL_CUM[L] + Math.round(40 * Math.pow(L, 1.5));
const vlOf = v => { const xp = v && Number.isFinite(v.xp) ? v.xp : 0; let L = 1; while (L < 30 && xp >= VL_CUM[L + 1]) L++; return L; };
const cleanText = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// 친구에게 보여 줄 외형: 목록에 있고, 무료이거나 가진 것만
const LOOK_IDS = {
  hat: ['straw', 'nohat', 'cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'crown', 'lily', 'fishhat', 'shell', 'captain', 'moonband', 'maple', 'snowcap', 'lotus', 'leaf', 'whalehat', 'jelly', 'mooncrown', 'pirate'],
  o: ['tee', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star', 'suit', 'vest', 'sailor', 'wave', 'pondrobe', 'streamsuit', 'sunset', 'deepsea', 'starcloak', 'lifejacket'],
  rod: ['bamboo', 'mintrod', 'sakura', 'rainbowrod', 'goldrod', 'lotusrod', 'coral', 'galaxy'],
  bob: ['basicbob', 'heartbob', 'mushbob', 'catbob', 'goldbob', 'duck', 'leafbob', 'starfish', 'starbob'],
  ti: ['', 't_new', 't_villager', 't_nap', 't_cat', 't_big', 't_luck', 't_rich', 't_pond', 't_stream', 't_beach', 't_sea', 't_moon', 't_master',
    't_enh10', 't_enh15', 't_enh20', 't_pet_ruby', 't_pet_dot', 't_pet_nurung', 't_pet_kkam', 't_pet_churi']
};
const ENH_TITLE_NEED = { t_enh10: 10, t_enh15: 15, t_enh20: 20 };   // 강화 칭호는 서버 기록으로 확인
const FREE = new Set(['straw', 'nohat', 'tee', 'bamboo', 'basicbob', '']);
function cleanLook(l, save, color) {
  l = l && typeof l === 'object' ? l : {};
  const own = new Set((save && save.cos && Array.isArray(save.cos.own)) ? save.cos.own : []);
  const n = (v, max, d) => Number.isInteger(v) && v >= 0 && v < max ? v : d;
  const o = { h: n(l.h, 8, 0), k: n(l.k, 5, 0), s: n(l.s, 10, color | 0) };
  for (const k in LOOK_IDS) { const v = l[k]; o[k] = LOOK_IDS[k].includes(v) && (FREE.has(v) || own.has(v)) ? v : LOOK_IDS[k][0]; }
  const enh = save && save.enh;
  if (ENH_TITLE_NEED[o.ti] && !(enh && enh.max >= ENH_TITLE_NEED[o.ti])) o.ti = '';
  o.e = enh ? enh.lv | 0 : 0;   // 이름표 옆 +강화 수치: 서버 기록 그대로
  return o;
}

/* 가방 검증: 받은 저장을 서버가 가진 기록과 비교해요
   1) rev가 서버보다 옛것 → 무시 (교환 전 가방으로 되돌려 물고기를 복사하는 것을 막음)
   2) 물고기는 '잡은 만큼'만 늘 수 있음 (늘어난 마릿수 ≤ 도감 마릿수가 늘어난 만큼)
   3) 도감 마릿수는 줄지 않고, 실제 낚시가 가능한 빠르기까지만 늘어남
   4) 골드는 판(줄어든) 물고기 값만큼만 늘어남 */
/* 낚시터 문: 연 사람만 들어가요. 새로 연 문은 그 값만큼 골드가 줄어야 해요 (index.html ZONES의 gate와 같아야 해요) */
const GATE_PRICE = { 2: 3000, 3: 15000, 4: 60000, 5: 200000 };   // 6번 안개 섬은 문 대신 물결호 (마을에 배가 있어야 해요)
function zonesOf(s) { return Array.isArray(s && s.zones) ? s.zones : [1]; }
function checkSave(old, neu, elapsedMs) {
  if (!neu || typeof neu !== 'object') return '저장 형식이 이상해요';
  old = old || { inv: {}, dex: {}, gold: 60, rev: 0 };
  if ((neu.rev | 0) < (old.rev | 0)) return 'stale';
  if ((neu.rev | 0) > (old.rev | 0)) return '교환 기록 번호가 서버와 달라요';
  const oi = invOf(old), ni = invOf(neu), od = old.dex || {}, nd = neu.dex || {};
  if (typeof ni !== 'object' || typeof nd !== 'object') return '저장 형식이 이상해요';
  for (const k in ni) { const n = ni[k]; if (!validFish(+k) || !Number.isInteger(n) || n < 0 || n > 99999) return '가방에 이상한 물고기가 있어요'; }
  for (const k in nd) { if (!validFish(+k) || !nd[k] || !Number.isInteger(nd[k].n) || nd[k].n < 0) return '도감 기록이 이상해요'; }
  let caught = 0, soldValue = 0;
  const ids = new Set([...Object.keys(oi), ...Object.keys(ni), ...Object.keys(od), ...Object.keys(nd)]);
  for (const k of ids) {
    const a = oi[k] | 0, b = ni[k] | 0, da = od[k] ? od[k].n | 0 : 0, dn = nd[k] ? nd[k].n | 0 : 0;
    if (dn < da) return '도감 기록이 줄었어요';
    caught += dn - da;
    if (b - a > dn - da) return '잡지 않은 물고기가 가방에 늘었어요';
    if (b < a) soldValue += (a - b) * fishPrice(+k);
  }
  if (caught > 32 + elapsedMs / 1000) return '너무 빨리 많이 잡혔어요'; // 빠른 낚시 · 두 마리 · 통발(한 번에 최대 30마리) 기준
  const oz = zonesOf(old), nz = zonesOf(neu);
  if (nz.length > 6 || nz.some(z => !Number.isInteger(z) || z < 1 || z > 6) || new Set(nz).size !== nz.length) return '낚시터 기록이 이상해요';
  if (oz.some(z => nz.indexOf(z) < 0)) return '열었던 낚시터가 사라졌어요';
  let gateCost = 0; for (const z of nz) if (oz.indexOf(z) < 0) gateCost += GATE_PRICE[z] || 0;
  if (nz.indexOf(6) >= 0 && oz.indexOf(6) < 0 && !vBoat) return '물결호가 없는데 섬에 갔어요';
  const g0 = Number(old.gold) || 0, g1 = neu.gold;
  if (!Number.isFinite(g1) || g1 < 0) return '골드가 이상해요';
  // 판매가 보너스(도감 · 단골 2배 · 상인 · 요리 · 정복 · 시세)를 다 겹쳐도 넘지 않게 넉넉히 4배
  // (예전엔 return이 주석 안에 들어가 있어서 이 검사가 꺼져 있었어요)
  if (g1 - g0 + gateCost > soldValue * 4 + 50) return gateCost ? '문 값을 내지 않고 낚시터가 열렸어요' : '판 것보다 골드가 많이 늘었어요';
  return null;
}
/* ---------- 낚싯대 강화 룰렛 (게임의 ENH와 똑같은 규칙 — 결과는 서버가 정해요) ---------- */
const ENH = {
  MAX: 20,
  P: [.9, .75, .6, .5, .4, .32, .25, .2, .15, .12, .08, .06, .05, .04, .03, .025, .02, .015, .01, .005],
  cost: L => Math.round(20 * Math.pow(1.4, L) / 10) * 10 || 10,
  DAILY: 3, FISH_CAP: 10, FISH_PER: 40, IDLE_MIN: 30, IDLE_CAP: 3, PIECE_CAP: 10, PIECE_PER: 5, TK_MAX: 60,
  PTS: [1, 2, 5, 15, 40]
};
const fishRar = id => id < 100 ? rarOf(id % 20) : id < FISH_N ? rarOf((id - 100) % 20) : id === BOSS_ID ? 4 : id >= MK_FIRST ? MK_RAR[id - MK_FIRST] | 0 : id >= PTY_FIRST ? PTY_RAR[id - PTY_FIRST] | 0 : id >= ISLE_FIRST ? rarOf(id - ISLE_FIRST) : (SEASON_FISH[id - FISH_N] || [0])[0];
/* 전설을 잡은 낚시터 (길잡이 보너스) */
function legZones(save) { const d = (save && save.dex) || {}, out = []; for (const k in d) { const id = +k; if (!(d[k] && d[k].n > 0) || fishRar(id) !== 4) continue; const z = id < FISH_N ? (id < 100 ? Math.floor(id / 20) : Math.floor((id - 100) / 20)) + 1 : id >= ISLE_FIRST && id < PTY_FIRST ? 6 : 0; if (z && out.indexOf(z) < 0) out.push(z); } return out; }
const enhDefault = () => ({ lv: 0, max: 0, tk: 0, pity: 0, day: '', fp: 0, ft: 0, it: 0, idle: 0, pc: 0, pcd: 0, lit: 0 });
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function enhSlices(L, mode) {
  const p = ENH.P[L] || 0, s = [];
  if (mode === 'safe') {
    s.push({ k: 'up', p }); const f = 1 - p;
    if (L >= 10) s.push({ k: 'keep', p: f * .6 }, { k: 'down', p: f * .4 }); else if (L >= 5) s.push({ k: 'keep', p: f * .7 }, { k: 'down', p: f * .3 }); else s.push({ k: 'keep', p: f });
  } else {
    s.push({ k: 'jack', p: p * .105 }, { k: 'up', p: p * .595 }); const f = 1 - p * .7;
    if (L >= 10) s.push({ k: 'keep', p: f * .5 }, { k: 'down', p: f * .3 }, { k: 'break', p: f * .2 });
    else if (L >= 5) s.push({ k: 'keep', p: f * .67 }, { k: 'down', p: f * .25 }, { k: 'break', p: f * .08 });
    else s.push({ k: 'keep', p: f });
  }
  return s;
}
function enhOf(save) { if (!save) return null; save.enh = Object.assign(enhDefault(), save.enh && typeof save.enh === 'object' ? save.enh : {}); return save.enh; }
function enhDaily(e, out) { const d = kstDay(); if (e.day === d) return; e.day = d; e.ft = 0; e.it = 0; e.idle = 0; e.pcd = 0; e.tk = Math.min(ENH.TK_MAX, e.tk + ENH.DAILY); out.push('오늘의 출석 강화권 ' + ENH.DAILY + '장!'); }
function enhAddPoints(e, pts, out) {
  if (e.ft >= ENH.FISH_CAP) { e.fp = 0; return; }
  e.fp += pts;
  while (e.fp >= ENH.FISH_PER && e.ft < ENH.FISH_CAP) { e.fp -= ENH.FISH_PER; e.ft++; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('낚시 강화권 +1 (오늘 ' + e.ft + '/' + ENH.FISH_CAP + ')'); }
  if (e.ft >= ENH.FISH_CAP) e.fp = 0;
}
function enhAddPiece(e, n, out) {
  n = Math.min(n, ENH.PIECE_CAP - e.pcd); if (n <= 0) { out.push('오늘 모을 수 있는 반짝 조각은 다 모았어요'); return; }
  e.pcd += n; e.pc += n; out.push('반짝 조각 +' + n);
  while (e.pc >= ENH.PIECE_PER) { e.pc -= ENH.PIECE_PER; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('조각 ' + ENH.PIECE_PER + '개로 강화권 +1!'); }
}
function enhRoll(e, mode, gold, disc) {
  const L = e.lv; if (L >= ENH.MAX) return { err: '이미 최고 단계예요' };
  if (e.tk < 1) return { err: '강화권이 없어요' };
  const cost = mode === 'safe' ? Math.round(ENH.cost(L) * (1 - (disc || 0))) : 0; if ((Number(gold) || 0) < cost) return { err: '골드가 모자라요' };
  e.tk--;
  let k;
  if (mode === 'safe' && e.pity >= 100) k = 'up';
  else { const sl = enhSlices(L, mode); let r = Math.random(); k = sl[sl.length - 1].k; for (const x of sl) { if (r < x.p) { k = x.k; break; } r -= x.p; } }
  if (k === 'up') { e.lv++; if (mode === 'safe') e.pity = 0; }
  else if (k === 'jack') e.lv = Math.min(ENH.MAX, L + 2);
  else { if (mode === 'safe') e.pity = Math.min(100, e.pity + ENH.P[L] * 50); if (k === 'down') e.lv = Math.max(0, L - 1); if (k === 'break') e.lv = 0; }
  e.max = Math.max(e.max, e.lv);
  return { k, from: L, to: e.lv, cost, mode };
}
/* 반짝 조각: 어디서 왔든 하루 상한이 있어서, 꾸며서 보내도 정직한 사람보다 더 받을 수 없어요 */
const LIFE_RULE = { spark: { cd: 100, ch: 1, n: 1 }, tree: { cd: 1800, ch: .5, n: 1, per: true }, pet: { cd: 600, ch: .4, n: 1, per: true }, litter: { cd: 7000, ch: 1, n: 2 }, sit: { cd: 840, ch: 1, n: 1 } };
const DROP_MS = 10 * 60e3; let dropSeq = 0;   // 떨어진 반짝 조각은 10분 안에 주워요
const PET_IDS = ['ruby', 'dot', 'nurung', 'kkam', 'churi'];
/* ---------- 동물 친구: 산책 · 냄새 소원 · 선물 보상 (index.html의 petReward와 같은 규칙 — 골드 · 강화권은 서버가 줘요) ---------- */
const PLV_CUM = [0, 0]; for (let L = 1; L < 99; L++) PLV_CUM[L + 1] = PLV_CUM[L] + Math.round(1.3 * Math.pow(L, 1.95)) + 20;
const petLvOf = xp => { let L = 1; while (L < 99 && xp >= PLV_CUM[L + 1]) L++; return L; };
const petXp = st => !st || typeof st !== 'object' ? 0 : (Number.isFinite(st.xp) ? Math.max(0, st.xp) : Math.max(0, (st.a | 0) * 30));
const fetchMax = L => L >= 70 ? 3 : L >= 30 ? 2 : L >= 20 ? 1 : 0;
const WISH_RW = [{ tk: 1, g: 200 }, { tk: 2, g: 500 }, { tk: 3, g: 1200 }, { tk: 4, g: 3000 }, { tk: 5, g: 8000 }];
const fishZone = id => id < 100 ? Math.floor(id / 20) + 1 : Math.floor((id - 100) / 20) + 1;
/* 물고기가 사는 낚시터 (index.html FISH의 zone과 같아요): 1~5 · 6 안개 섬 · 7 배낚시 · 8 물결 시장 */
const placeOf = id => id < FISH_N ? fishZone(id) : id < ISLE_FIRST ? (SEASON_FISH[id - FISH_N] || [0, 0])[1] : id < PTY_FIRST ? 6 : id < MK_FIRST ? 7 : 8;
/* 교환 규칙: 물고기는 물고기와만, 같은 낚시터끼리만. 골드 · 아이템 교환은 그대로 */
function tradeRule(a, b) {
  const all = [a || {}, b || {}], fish = [];
  for (const o of all) for (const k in o) if (keyKind(k) === 'f' && o[k] > 0) fish.push(+k);
  if (!fish.length) return null;
  if (all.some(o => Object.keys(o).some(k => keyKind(k) !== 'f' && o[k] > 0))) return '물고기는 물고기와만 바꿀 수 있어요 (골드 · 아이템은 따로)';
  if (all.some(o => !Object.keys(o).some(k => o[k] > 0))) return '물고기는 서로 한 마리 이상씩 올려야 바꿀 수 있어요';
  if (new Set(fish.map(placeOf)).size > 1) return '같은 낚시터 물고기끼리만 바꿀 수 있어요';
  return null;
}
const postOk = p => !!(p.give && p.want && placeOf(p.give[0]) === placeOf(p.want[0]));
/* 장소마다 하루 한 번: 그날 처음 낚으면 랜덤 선물 (index.html GIFT와 같은 규칙). 어느 낚시터든 선물 가치는 같아요 */
const GIFT_PLACES = [1, 2, 3, 4, 5, 6, 8];   // 배낚시(7)는 귀항 보상이 따로 있어요
const GIFT_COS = ['cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star'];
function giftOf(s) { const d = kstDay(); let g = s.gift; if (!g || typeof g !== 'object' || g.d !== d || !Array.isArray(g.z)) g = s.gift = { d, z: [] }; return g; }
function giftRoll(s, e, delta, cos, out) {
  const r = Math.random();
  if (r < .04) {   // 옷 (다 가졌으면 강화권)
    const own = (s.cos && s.cos.own) || [], pool = GIFT_COS.filter(id => !own.includes(id));
    if (pool.length) { const id = pool[(Math.random() * pool.length) | 0]; cos.push(id); out.push('새 옷!'); return; }
  }
  if (r < .12) { e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('강화권 +1'); return; }
  if (r < .45) { e.pc += 2; out.push('반짝 조각 +2'); while (e.pc >= ENH.PIECE_PER) { e.pc -= ENH.PIECE_PER; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('조각으로 강화권 +1'); } return; }
  const m = Math.random() < .06 ? [['pearl', 1], ['feather', 1], ['scale', 1]][(Math.random() * 3) | 0] : [['flesh', 4], ['shell', 2], ['weed', 2]][(Math.random() * 3) | 0];
  delta['i:' + m[0]] = (delta['i:' + m[0]] | 0) + m[1];   // 재료 이름은 화면이 delta로 보여 줘요
}
function petRwOf(save) { const d = kstDay(); let r = save.petrw; if (!r || typeof r !== 'object' || r.d !== d) r = save.petrw = { d, walk: 0, wish: 0, fetch: 0 }; return r; }
const popOf = s => Object.assign({ n: 0, up: 0, dn: 0 }, s && s.pop && typeof s.pop === 'object' ? s.pop : {});
const lifeCd = new Map();     // key -> {src[:id]: 시각}
const rankCache = new Map();  // key -> {name, lv, max}
function rankSet(key, name, e) { if (e && (e.max > 0 || e.lv > 0)) rankCache.set(key, { name, lv: e.lv | 0, max: e.max | 0 }); }
const rankTop = () => [...rankCache.values()].sort((a, b) => b.max - a.max || b.lv - a.lv).slice(0, 10);
function sendEnh(ws, me, extra) { send(ws, Object.assign({ t: 'enh', enh: me.save.enh }, extra || {})); }
function lookChanged(ws, me) { me.look = cleanLook(me.look, me.save, me.color); broadcast({ t: 'look', id: me.id, look: me.look }, ws); }

/* 서버가 가방을 바꾸는 유일한 방법 (교환). rev를 1 올려요 */
function applyInv(save, delta) {
  save.inv = save.inv || {}; save.dex = save.dex || {};
  for (const k in delta) {
    const n = delta[k] | 0; if (!n) continue;
    const t = keyKind(k);
    if (t === 'g') { save.gold = Math.max(0, (Number(save.gold) || 0) + n); continue; }
    if (t === 'i') { const it = save.items && typeof save.items === 'object' ? save.items : (save.items = {}); const id = k.slice(2); it[id] = Math.max(0, (it[id] | 0) + n); if (!it[id]) delete it[id]; continue; }
    save.inv[k] = Math.max(0, (save.inv[k] | 0) + n);
    if (n > 0) { const e = save.dex[k] || (save.dex[k] = { n: 0, best: 0 }); e.n += n; }
  }
  save.rev = (save.rev | 0) + 1;
  return save.rev;
}
/* 같은 사람의 가방을 동시에 고치지 않도록 줄 세우기 */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => { });
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
function withLocks(keys, fn) { keys = [...new Set(keys)].sort(); return keys.reduceRight((inner, k) => () => withLock(k, inner), fn)(); }
const liveByKey = key => { for (const [ws, p] of players) if (p.key === key) return [ws, p]; return null; };
const liveById = id => { for (const [ws, p] of players) if (p.id === id) return [ws, p]; return null; };
const lastSaveAt = new Map(); // key -> 마지막으로 받아들인 저장 시각
async function loadSave(key) {
  const l = liveByKey(key); if (l && l[1].save) return l[1].save;
  if (pending.has(key)) return pending.get(key).save;
  const row = await db.get(key); return row ? row.save : null;
}
/* 교환 결과를 가방에 반영하고 바로 DB에 써요. 접속 중이면 화면에도 알려 줌 (잠금 안에서 부르기) */
async function changeBag(key, delta, why) {
  const save = await loadSave(key); if (!save) throw new Error('저장이 없어요');
  const rev = applyInv(save, delta);
  const l = liveByKey(key); if (l) { l[1].save = save; send(l[0], { t: 'delta', d: delta, rev, why: why || null }); } // why가 없으면 조용히 반영
  queueSave(key, save); await flushSave(key);
  return rev;
}

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
        for (const [ows, op] of [...players]) if (op.key === key) {
          endTrade(op, op.name + ' 님이 다른 기기로 옮겨 갔어요');
          players.delete(ows); broadcast({ t: 'leave', id: op.id });   // 바로 빼야 예전 가방을 건드리지 않아요
          send(ows, { t: 'kicked' }); ows.close();
        }
        if (pending.has(key)) { const p = pending.get(key); row.save = p.save; }
        const color = colorOf(key);
        const p = { id: nextId++, key, name: row.name, color, x: 0, y: 0, d: 'down', m: 0, b: 0, here: false,
          save: row.save, look: cleanLook(row.save && row.save.cos && row.save.cos.look, row.save, color), tr: null, sayT: 0, emoT: 0 };
        players.set(ws, p);
        send(ws, { t: 'login_ok', id: p.id, name: p.name, color: p.color, save: row.save, isNew });
        // 지금 있는 친구들 알려 주기 / 내가 왔다고 알리기 (외형 포함)
        for (const [ows, op] of players) if (ows !== ws) send(ws, { t: 'join', id: op.id, name: op.name, color: op.color, x: op.x, y: op.y, d: op.d, here: op.here, look: op.look });
        broadcast({ t: 'join', id: p.id, name: p.name, color: p.color, look: p.look }, ws);
        if (p.save) { const e = enhOf(p.save), out = []; enhDaily(e, out); rankSet(key, p.name, e); sendEnh(ws, p, { note: out }); if (out.length) queueSave(key, p.save); }
        rosterSet(key, p.name, p.save); rosterSend(true);
        send(ws, { t: 'pt', p: ptPub(), today: ptToday(p.save) });
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
      me.b = Number.isInteger(m.b) && m.b >= 0 && m.b < 100000 ? m.b : 0; // 낚시 중인 찌 위치 (친구 화면에 낚싯대 · 찌 스킨)
    } else if (m.t === 'save' && m.data && typeof m.data === 'object') {
      withLock(me.key, () => {
        const now = Date.now(), err = checkSave(me.save, m.data, now - (lastSaveAt.get(me.key) || 0));
        if (err === 'stale') return;                    // 교환 전 옛 가방: 무시 (곧 새 가방이 다시 와요)
        if (err) {
          console.warn('저장 거절', me.name, err);
          if (me.save) return send(ws, { t: 'sync', save: me.save, msg: '가방을 서버 기록에 맞췄어요 (' + err + ')' });
          return;
        }
        // 강화 기록은 서버 것만 믿어요. 새로 잡은 물고기만큼 낚시 점수
        const oldDex = (me.save && me.save.dex) || {}, newDex = m.data.dex || {}, first = !me.save;
        const ce = m.data.enh;   // 화면이 들고 있던 값 (믿지 않음)
        m.data.enh = me.save ? me.save.enh : enhDefault();
        m.data.pop = me.save && me.save.pop ? me.save.pop : { n: 0, up: 0, dn: 0 };   // 인기도도 서버 것만 믿어요
        m.data.popGv = me.save && me.save.popGv ? me.save.popGv : {};
        m.data.petrw = me.save && me.save.petrw ? me.save.petrw : null;   // 동물 친구 보상 받은 기록도 서버 것만
        m.data.cs = me.save && Array.isArray(me.save.cs) ? me.save.cs : [];   // 위탁 판매에 맡긴 물고기는 서버가 들고 있어요
        m.data.boat = me.save && me.save.boat ? me.save.boat : 0;   // 물결호를 만든 기록도 서버 것만
        m.data.don = me.save && me.save.don && typeof me.save.don === 'object' ? me.save.don : {};   // 마을 기부함에 넣은 것
        m.data.zrw = me.save && Array.isArray(me.save.zrw) ? me.save.zrw : [];   // 낚시터 정복 보상 받은 기록
        m.data.ptd = me.save && me.save.ptd ? me.save.ptd : null;   // 오늘 배낚시 나간 횟수
        m.data.gift = me.save && me.save.gift ? me.save.gift : null;   // 오늘 장소별 첫 낚시 선물 받은 기록
        m.data.cosg = me.save && Array.isArray(me.save.cosg) ? me.save.cosg : [];   // 서버가 준 옷: 화면 저장에서 빠져도 다시 넣어요
        if (m.data.cosg.length) { const c = m.data.cos && typeof m.data.cos === 'object' ? m.data.cos : (m.data.cos = {}); c.own = Array.isArray(c.own) ? c.own : []; for (const id of m.data.cosg) if (!c.own.includes(id)) c.own.push(id); }
        const e = enhOf(m.data), out = [];
        enhDaily(e, out);
        if (!first) { let pts = 0; for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0); if (dn > 0) pts += dn * ENH.PTS[fishRar(+k)]; } if (pts) enhAddPoints(e, pts, out); }
        me.save = m.data; lastSaveAt.set(me.key, now); rosterSet(me.key, me.name, m.data);
        if (!first) {   // 장소마다 오늘 첫 낚시 선물
          const g = giftOf(m.data), places = [];
          for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0), z = placeOf(+k); if (dn > 0 && GIFT_PLACES.includes(z) && !g.z.includes(z) && !places.includes(z)) places.push(z); }
          if (places.length) {
            const delta = {}, cos = [], gout = [];
            for (const z of places) { g.z.push(z); giftRoll(m.data, e, delta, cos, gout); }
            const got = giveCos(m.data, cos), rev = Object.keys(delta).length ? applyInv(m.data, delta) : (m.data.rev | 0);
            send(ws, { t: 'gift', places, d: delta, rev, enh: e, cos: got, note: gout, gift: g });
          }
        }
        queueSave(me.key, m.data);
        if (out.length || first || !ce || ce.tk !== e.tk || ce.lv !== e.lv || ce.max !== e.max) sendEnh(ws, me, { note: out });
      });
    } else onMsg(ws, me, m);
  });
  ws.on('close', () => {
    const p = players.get(ws); if (!p) return;
    endTrade(p, p.name + ' 님이 마을을 떠났어요');
    players.delete(ws);
    if (party && party.members.includes(p.key)) ptRemove(p.key);
    flushSave(p.key);
    broadcast({ t: 'leave', id: p.id }); rosterSoon();
    console.log('나감', p.name, '현재', players.size, '명');
  });
});

/* ---------- 3·4단계 메시지: 외형 · 말 · 감정표현 · 교환소 ---------- */
const EMOTES = ['heart', 'laugh', 'sweat', 'sleepy', 'sparkle', 'clap'];
const POST_DAYS = 3, POST_MAX_EACH = 3, POST_MAX_ALL = 80;
let posts = [];                 // 게시판 (DB와 같은 내용을 메모리에도)
const mail = new Map();         // key -> [{at,text}]
const postView = key => posts.map(p => ({ id: p.id, kind: p.kind, by: p.by_name, at: Date.parse(p.created_at), give: p.give, want: p.want, note: p.note, mine: p.by_key === key }));
const boardTo = (ws, key) => send(ws, { t: 'bd_list', posts: postView(key), mail: (mail.get(key) || []).slice(0, 10) });
function addMail(key, text) {
  const list = mail.get(key) || []; list.unshift({ at: Date.now(), text }); mail.set(key, list.slice(0, 20));
  db.addMail({ to_key: key, text }).catch(e => console.error('소식 저장 실패', e.message));
  const l = liveByKey(key); if (l) send(l[0], { t: 'mail', text });
}
const okPair = a => a === null || a === undefined || (Array.isArray(a) && a.length === 2 && validFish(a[0]) && Number.isInteger(a[1]) && a[1] >= 1 && a[1] <= 99);
const fishSpec = a => a ? [a[0], a[1]] : null;

function onMsg(ws, me, m) {
  switch (m.t) {
    case 'look':
      me.look = cleanLook(m.look, me.save, me.color);
      broadcast({ t: 'look', id: me.id, look: me.look }, ws); break;
    case 'say': {
      const now = Date.now(), text = cleanText(m.text, 30);
      if (!text || now - me.sayT < 600) return; me.sayT = now;
      broadcast({ t: 'say', id: me.id, text }, ws); break;
    }
    case 'emo': {
      const now = Date.now(); if (!EMOTES.includes(m.k) || now - me.emoT < 350) return; me.emoT = now;
      broadcast({ t: 'emo', id: me.id, k: m.k }, ws); break;
    }
    /* ----- 게시판 (접속 시간이 달라도 됨: 줄 물고기는 교환소가 맡아 둠) ----- */
    case 'bd_list': boardTo(ws, me.key); break;
    case 'bd_post': withLock(me.key, async () => {
      const kind = m.kind === 'want' ? 'want' : 'give', give = m.give || null, want = m.want || null;
      if (!okPair(give) || !okPair(want) || (kind === 'give' && !give) || (kind === 'want' && !want)) return send(ws, { t: 'bd_err', msg: '글 내용이 이상해요' });
      if (!give || !want) return send(ws, { t: 'bd_err', msg: '줄 물고기와 받을 물고기를 둘 다 골라 주세요' });
      if (placeOf(give[0]) !== placeOf(want[0])) return send(ws, { t: 'bd_err', msg: '같은 낚시터 물고기끼리만 바꿀 수 있어요' });
      const myMax = POST_MAX_EACH + jobRank(me.save, 'mer', 'slot');
      if (posts.filter(p => p.by_key === me.key).length >= myMax) return send(ws, { t: 'bd_err', msg: '글은 ' + myMax + '개까지 올릴 수 있어요' });
      if (posts.length >= POST_MAX_ALL) return send(ws, { t: 'bd_err', msg: '게시판이 꽉 찼어요. 조금 뒤에 올려 주세요' });
      if (give && !has(me.save, give[0], give[1])) return send(ws, { t: 'bd_err', msg: '가방에 그 물고기가 부족해요' });
      const p = { id: crypto.randomUUID(), by_key: me.key, by_name: me.name, kind, give: fishSpec(give), want: fishSpec(want), note: cleanText(m.note, 20), created_at: new Date().toISOString() };
      try { await db.addPost(p); } catch (e) { console.error('글 저장 실패', e.message); return send(ws, { t: 'bd_err', msg: '게시판에 저장하지 못했어요' }); }
      posts.unshift(p);
      if (give) await changeBag(me.key, { [give[0]]: -give[1] }, '교환소에 물고기를 맡겼어요');
      boardTo(ws, me.key);
    }).catch(e => { console.error('bd_post', e.message); send(ws, { t: 'bd_err', msg: '처리하지 못했어요' }); }); break;
    case 'bd_del': withLock(me.key, async () => {
      const i = posts.findIndex(p => p.id === m.id && p.by_key === me.key);
      if (i < 0) return send(ws, { t: 'bd_err', msg: '이미 없어진 글이에요' });
      const p = posts.splice(i, 1)[0];
      await db.delPost(p.id);
      if (p.give) await changeBag(me.key, { [p.give[0]]: p.give[1] }, '글을 내리고 맡긴 물고기를 돌려받았어요');
      boardTo(ws, me.key);
    }).catch(e => { console.error('bd_del', e.message); send(ws, { t: 'bd_err', msg: '처리하지 못했어요' }); }); break;
    case 'bd_take': {
      const p0 = posts.find(p => p.id === m.id);
      if (!p0) { send(ws, { t: 'bd_err', msg: '이미 누가 가져갔어요' }); break; }
      if (p0.by_key === me.key) { send(ws, { t: 'bd_err', msg: '내가 쓴 글이에요' }); break; }
      withLocks([me.key, p0.by_key], async () => {
        const i = posts.findIndex(p => p.id === m.id);
        if (i < 0) return send(ws, { t: 'bd_err', msg: '이미 누가 가져갔어요' });
        const p = posts[i];
        if (!postOk(p)) return send(ws, { t: 'bd_err', msg: '예전 규칙으로 쓴 글이라 받을 수 없어요 (곧 내려가요)' });
        if (p.want && !has(me.save, p.want[0], p.want[1])) return send(ws, { t: 'bd_err', msg: '가방에 그 물고기가 부족해요' });
        posts.splice(i, 1); await db.delPost(p.id);
        const d = {};
        if (p.want) d[p.want[0]] = (d[p.want[0]] | 0) - p.want[1];
        if (p.give) d[p.give[0]] = (d[p.give[0]] | 0) + p.give[1];
        await changeBag(me.key, d, '교환소 거래 완료!');
        if (p.want) await changeBag(p.by_key, { [p.want[0]]: p.want[1] }, false);
        addMail(p.by_key, me.name + ' 님이 「' + (p.kind === 'give' ? '드려요' : '구해요') + '」 글에 응했어요!' + (p.want ? ' 물고기가 가방에 들어왔어요.' : ''));
        boardTo(ws, me.key);
      }).catch(e => { console.error('bd_take', e.message); send(ws, { t: 'bd_err', msg: '처리하지 못했어요' }); });
      break;
    }
    /* ----- 직접 교환 (같이 있을 때) ----- */
    case 'tr_req': {
      const o = liveById(m.to);
      if (!o || o[1] === me || o[1].tr || me.tr) return send(ws, { t: 'tr_no', msg: '지금은 교환할 수 없어요' });
      send(o[0], { t: 'tr_req', from: me.id, name: me.name }); break;
    }
    case 'tr_ans': {
      const o = liveById(m.from); if (!o) break;
      const [ows, op] = o;
      if (!m.ok || op.tr || me.tr) { send(ows, { t: 'tr_no', msg: me.name + ' 님이 ' + (m.busy ? '지금 바빠요' : '교환을 거절했어요') }); break; }
      const T = { a: [ows, op], b: [ws, me], offer: new Map([[op.id, {}], [me.id, {}]]), ok: new Set() };
      op.tr = me.tr = T;
      send(ows, { t: 'tr_open', with: me.id, name: me.name }); send(ws, { t: 'tr_open', with: op.id, name: op.name }); break;
    }
    case 'tr_offer': withLock(me.key, () => {
      const T = me.tr; if (!T) return;
      const it = {}, src = m.items && typeof m.items === 'object' ? m.items : {};
      for (const k in src) {
        const t = keyKind(k), n = Math.min(t === 'g' ? 1e7 : 99, src[k] | 0); if (!t || n <= 0) continue;
        const cap = t === 'g' ? Math.floor(Number(me.save && me.save.gold) || 0) : t === 'i' ? itemsOf(me.save)[k.slice(2)] | 0 : invOf(me.save)[+k] | 0;
        const v = Math.min(n, cap); if (v > 0) it[k] = v;
      }
      if (Object.keys(it).length > 6) return;
      T.offer.set(me.id, it); T.ok.clear(); trState(T);
    }); break;
    case 'tr_ok': {
      const T = me.tr; if (!T) break;
      if (m.ok) T.ok.add(me.id); else T.ok.delete(me.id);
      if (T.ok.size < 2) { trState(T); break; }
      const [aws, A] = T.a, [bws, B] = T.b;
      withLocks([A.key, B.key], async () => {
        if (A.tr !== T || B.tr !== T) return;
        const oa = T.offer.get(A.id), ob = T.offer.get(B.id);
        const rule = tradeRule(oa, ob);
        if (rule) { T.ok.clear(); trState(T); for (const w of [aws, bws]) send(w, { t: 'bd_err', msg: rule }); return; }
        const fine = Object.keys(oa).every(k => hasKey(A.save, k, oa[k])) && Object.keys(ob).every(k => hasKey(B.save, k, ob[k]));
        if (!fine) { T.ok.clear(); trState(T); for (const w of [aws, bws]) send(w, { t: 'bd_err', msg: '가방이 바뀌어서 다시 확인해 주세요' }); return; }
        const da = {}, dbb = {};
        for (const k in oa) { da[k] = (da[k] | 0) - oa[k]; dbb[k] = (dbb[k] | 0) + oa[k]; }
        for (const k in ob) { dbb[k] = (dbb[k] | 0) - ob[k]; da[k] = (da[k] | 0) + ob[k]; }
        A.tr = B.tr = null;
        const ra = applyInv(A.save, da), rb = applyInv(B.save, dbb);
        queueSave(A.key, A.save); queueSave(B.key, B.save);
        await Promise.all([flushSave(A.key), flushSave(B.key)]);
        send(aws, { t: 'tr_done', d: da, rev: ra }); send(bws, { t: 'tr_done', d: dbb, rev: rb });
        console.log('교환', A.name, JSON.stringify(oa), '↔', B.name, JSON.stringify(ob));
      }).catch(e => console.error('tr_ok', e.message));
      break;
    }
    case 'tr_cancel': endTrade(me, me.name + ' 님이 교환을 그만뒀어요'); break;
    /* ----- 낚싯대 강화 룰렛 ----- */
    case 'enh_try': withLock(me.key, async () => {
      if (!me.save) return send(ws, { t: 'enh', err: '잠시 뒤에 다시 해 주세요' });
      const e = enhOf(me.save), out = []; enhDaily(e, out);
      const r = enhRoll(e, m.mode === 'gamble' ? 'gamble' : 'safe', me.save.gold, .1 * jobRank(me.save, 'mer', 'enh'));
      if (r.err) return sendEnh(ws, me, { err: r.err });
      const extra = { roll: r };
      if (r.cost) { me.save.gold = (Number(me.save.gold) || 0) - r.cost; me.save.rev = (me.save.rev | 0) + 1; extra.dgold = -r.cost; extra.rev = me.save.rev; }
      queueSave(me.key, me.save); sendEnh(ws, me, extra);
      rankSet(me.key, me.name, e); lookChanged(ws, me);
      if ((r.k === 'up' || r.k === 'jack') && r.to >= 10) broadcast({ t: 'news', text: '✨ ' + me.name + ' 님이 낚싯대 +' + r.to + ' 강화에 성공했어요!' }, ws);
      if (r.k === 'break' && r.from >= 8) broadcast({ t: 'news', text: '💥 ' + me.name + ' 님의 +' + r.from + ' 낚싯대가 산산조각 났어요…' }, ws);
    }).catch(e => console.error('enh_try', e.message)); break;
    case 'enh_rank': send(ws, { t: 'enh_rank', list: rankTop() }); break;
    /* ----- 친구 물고기 보기: 친구 가방에 있는 물고기 · 친구 도감에 없는 내 물고기 ----- */
    case 'fr_list': (async () => {
      const mine = invOf(me.save), live = new Set([...players.values()].map(p => p.key)), list = [];
      for (const key of rosterCache.keys()) {
        if (key === me.key) continue;
        const sv = await loadSave(key); if (!sv) continue;
        const inv = invOf(sv), dex = sv.dex || {}, have = [];
        for (const k in inv) if ((inv[k] | 0) > 0 && validFish(+k)) have.push([+k, inv[k] | 0]);
        const lack = Object.keys(mine).filter(k => (mine[k] | 0) > 0 && validFish(+k) && !(dex[k] && dex[k].n > 0)).map(Number);
        const l = liveByKey(key);
        list.push({ name: (rosterCache.get(key) || {}).name || key, on: live.has(key), id: l ? l[1].id : 0, have, lack });
      }
      send(ws, { t: 'fr_list', list });
    })().catch(e => console.error('fr_list', e.message)); break;
    case 'life': withLock(me.key, () => {
      const r = LIFE_RULE[m.src]; if (!r || !me.save) return;
      const id = cleanText(m.id, 12), cd = lifeCd.get(me.key) || {}, k = m.src + (r.per ? ':' + id : ''), now = Date.now();
      if (cd[k] && now - cd[k] < r.cd * 1000) return;
      cd[k] = now; lifeCd.set(me.key, cd);
      const e = enhOf(me.save), out = []; enhDaily(e, out);
      if (out.length) { queueSave(me.key, me.save); sendEnh(ws, me, { note: out }); }
      if (Math.random() < r.ch) {   // 조각은 땅에 떨어지고, 주워야(pick) 가방에 들어가요
        const dr = me.drops || (me.drops = new Map());
        for (const [k2, d] of dr) if (now - d.at > DROP_MS) dr.delete(k2);
        let lying = 0; for (const d of dr.values()) lying += d.n;
        const n = Math.min(r.n, ENH.PIECE_CAP - e.pcd - lying);
        if (n <= 0) return send(ws, { t: 'news', text: '오늘 모을 수 있는 반짝 조각은 다 모았어요' });
        const did = ++dropSeq; dr.set(did, { n, at: now });
        send(ws, { t: 'drop', src: m.src, id, did, n });
      }
    }); break;
    case 'pick': withLock(me.key, () => {
      const dr = me.drops, d = dr && dr.get(m.did); if (!d || !me.save) return;
      dr.delete(m.did); if (Date.now() - d.at > DROP_MS) return;
      const e = enhOf(me.save), out = []; enhDaily(e, out); enhAddPiece(e, d.n, out);
      queueSave(me.key, me.save); sendEnh(ws, me, { note: out });
    }); break;
    /* ----- 물결호: 마을 기부함. 서로 다른 친구 4명 이상이 기부하고, 공방 장인(바꾼 지 2주 지난)이 조립해요 ----- */
    case 'don_list': boxState().then(b => send(ws, Object.assign({ t: 'don_list' }, b))).catch(e => console.error('don_list', e.message)); break;
    case 'don_put': withLocks([me.key, '__box'], async () => {   // 기부는 한 번에 하나씩 (넘치지 않게)
      const s = me.save; if (!s || vBoat) return;
      const k = m.k, need = BOAT_NEED[k]; if (!need) return;
      const b = await boxState(), sk = k.startsWith('i:') ? k.slice(2) : k, mine = s.don && s.don[k] | 0;
      const left = k === 'g' ? Infinity : need - (b.tot[sk] | 0); let n = Math.min(m.n | 0, left, donCap(k) - mine);
      if (n <= 0) return send(ws, { t: 'news', text: left <= 0 ? '그 재료는 다 모였어요' : '한 사람이 넣을 수 있는 만큼 넣었어요. 다른 친구 몫이에요' });
      if (!hasKey(s, k, n)) return send(ws, { t: 'news', text: '가진 게 모자라요' });
      const don = s.don && typeof s.don === 'object' ? s.don : (s.don = {}); don[k] = (don[k] | 0) + n;
      await changeBag(me.key, { [k]: -n }, '마을 기부함에 기부했어요!');
    }).then(async () => { const b = await boxState(); broadcast(Object.assign({ t: 'don_list' }, b)); }).catch(e => console.error('don_put', e.message)); break;
    case 'boat_build': {
      const keys = [...rosterCache.keys()];
      withLocks(keys.concat([me.key]), async () => {
        const s = me.save; if (!s) return; if (vBoat) return send(ws, { t: 'news', text: '물결호는 이미 있어요!' });
        if (!jobRank(s, 'cra', 'prep') || jobLocked(s)) return send(ws, { t: 'news', text: '조립은 공방 장인만, 직업을 바꾼 지 2주가 지나야 해요' });
        const b = await boxState();
        if (Object.keys(BOAT_NEED).some(k => (b.tot[k.startsWith('i:') ? k.slice(2) : k] | 0) < BOAT_NEED[k])) return send(ws, { t: 'news', text: '기부함 재료가 아직 모자라요' });
        if (b.donors.length < DONORS_NEED) return send(ws, { t: 'news', text: '서로 다른 친구 ' + DONORS_NEED + '명이 기부해야 해요 (지금 ' + b.donors.length + '명)' });
        for (const key of keys) { const sv = await loadSave(key); if (sv && sv.don && Object.keys(sv.don).length) { sv.don = {}; queueSave(key, sv); } }
        s.boat = 1; vBoat = { by: me.name, with: b.donors }; queueSave(me.key, s); await flushSave(me.key);
        broadcast({ t: 'news', text: '⛵ ' + b.donors.join(', ') + ' 님이 함께 모은 물결호를 ' + me.name + ' 님이 조립했어요! 먼바다 부두 끝에서 안개 섬으로 갈 수 있어요' });
        rosterSend(true);
      }).catch(e => console.error('boat_build', e.message));
      break;
    }
    /* ----- 낚시터 정복: 한 낚시터를 다 채우면 강화권 · 골드 · 전용 옷 세트 ----- */
    case 'zone_rw': withLock(me.key, () => {
      const s = me.save, z = m.z | 0; if (!s || z < 1 || z > 6) return;
      const zr = Array.isArray(s.zrw) ? s.zrw : (s.zrw = []); if (zr.includes(z)) return send(ws, { t: 'cos_got', ids: [], zrw: zr });
      const dex = s.dex || {}; if (!zoneFishIds(z).every(id => dex[id] && dex[id].n > 0)) return;
      zr.push(z); const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + ZRW.tk[z - 1]);
      const g = ZRW.g[z - 1]; s.gold = (Number(s.gold) || 0) + g; s.rev = (s.rev | 0) + 1;
      const ids = giveCos(s, ZONE_COS[z] || []); queueSave(me.key, s);
      sendEnh(ws, me, { dgold: g, rev: s.rev, note: out });
      send(ws, { t: 'cos_got', ids, zrw: zr, z });
      broadcast({ t: 'news', text: '🏆 ' + me.name + ' 님이 「' + ZONE_NAMES[z - 1] + '」을(를) 정복했어요!' }, ws);
    }); break;
    /* ----- 4인 배낚시 ----- */
    case 'pt_open': case 'pt_join': case 'pt_leave': case 'pt_go': case 'pt_catch': case 'pt_tap': ptMsg(ws, me, m); break;
    /* ----- 도감 박사의 예보: 마을 모두에게 ----- */
    case 'vil_note': {
      if (!jobRank(me.save, 'sch', 'fc') && !jobRank(me.save, 'sch', 'cap')) return;
      const text = cleanText(m.text, 80); if (!text) return;
      vNote = { d: kstDay(), by: me.name, text }; broadcast({ t: 'vil_note', note: vNote }); break;
    }
    /* ----- 위탁 판매: 맡긴 물고기는 서버가 들고 있다가 떠돌이 상인이 팔아요 ----- */
    case 'cs_list': csList(ws, me).catch(e => console.error('cs_list', e.message)); break;
    case 'cs_put': withLock(me.key, async () => {
      const id = m.id, n = Math.min(99, m.n | 0); if (!validFish(id) || n <= 0 || !me.save || !has(me.save, id, n)) return;
      const cs = Array.isArray(me.save.cs) ? me.save.cs : (me.save.cs = []);
      if (cs.length >= 12 && !cs.some(c => c.id === id)) return send(ws, { t: 'news', text: '위탁은 12종까지 맡길 수 있어요' });
      await changeBag(me.key, { [id]: -n }, null);
      const c = cs.find(c => c.id === id); if (c) c.n += n; else cs.push({ id, n });
      queueSave(me.key, me.save);
    }).then(() => csList(ws, me)).catch(e => console.error('cs_put', e.message)); break;
    case 'cs_take': withLock(me.key, async () => {
      const cs = me.save && Array.isArray(me.save.cs) ? me.save.cs : []; const i = cs.findIndex(c => c.id === m.id); if (i < 0) return;
      const c = cs.splice(i, 1)[0]; await changeBag(me.key, { [c.id]: c.n }, '맡긴 물고기를 돌려받았어요');
    }).then(() => csList(ws, me)).catch(e => console.error('cs_take', e.message)); break;
    case 'cs_sell': {
      if (!jobRank(me.save, 'mer', 'cons')) return send(ws, { t: 'news', text: '위탁 판매는 떠돌이 상인만 할 수 있어요' });
      const keys = [...rosterCache.keys()];
      withLocks(keys.concat([me.key]), async () => {
        let mine = 0, cnt = 0;
        for (const key of keys) {
          const sv = await loadSave(key); if (!sv || !Array.isArray(sv.cs) || !sv.cs.length) continue;
          let got = 0; for (const c of sv.cs) { const v = fishPrice(c.id) * c.n; got += Math.floor(v * 1.15); mine += Math.floor(v * .15); cnt += c.n; }
          sv.cs = []; sv.gold = (Number(sv.gold) || 0) + got; sv.rev = (sv.rev | 0) + 1;
          const l = liveByKey(key);
          if (l && l[1].save === sv) send(l[0], { t: 'enh', enh: enhOf(sv), dgold: got, rev: sv.rev, note: ['위탁 판매 완료! 골드 +' + got] });
          else addMail(key, me.name + ' 님이 맡긴 물고기를 팔아 줬어요. 골드 +' + got);
          queueSave(key, sv); await flushSave(key);
        }
        if (!cnt) return send(ws, { t: 'news', text: '위탁함이 비어 있어요' });
        me.save.gold = (Number(me.save.gold) || 0) + mine; me.save.rev = (me.save.rev | 0) + 1;
        queueSave(me.key, me.save); sendEnh(ws, me, { dgold: mine, rev: me.save.rev, note: ['위탁 ' + cnt + '마리를 팔았어요 · 내 몫 골드 +' + mine] });
      }).then(() => csList(ws, me)).catch(e => console.error('cs_sell', e.message));
      break;
    }
    /* ----- 동물 친구 보상: 산책 · 냄새 소원은 하루 한 번, 선물은 짝꿍 레벨만큼 ----- */
    case 'pet_rw': withLock(me.key, () => {
      const s = me.save; if (!s) return;
      const rw = petRwOf(s), e = enhOf(s), out = []; enhDaily(e, out);
      let g = 0, tk = 0, label = '';
      if (m.kind === 'walk') {
        if (rw.walk) return send(ws, { t: 'news', text: '오늘 산책 보상은 이미 받았어요' });
        rw.walk = 1; g = 300 + 100 * jobRank(s, 'tam', 'walk'); tk = 1; label = '산책 보상';
      } else if (m.kind === 'wish') {
        if (rw.wish) return send(ws, { t: 'news', text: '오늘 냄새 소원 보상은 이미 받았어요' });
        const id = m.id, dex = s.dex || {}, hasD = k => !!(dex[k] && dex[k].n > 0);
        if (!Number.isInteger(id) || id < 0 || id >= FISH_N || zonesOf(s).indexOf(fishZone(id)) < 0) return;
        const full = !!m.full;
        if (full && !hasD(id)) return send(ws, { t: 'news', text: '도감에 없는 물고기예요' });
        if (!full && !Object.keys(dex).some(k => +k < FISH_N && +k !== id && fishZone(+k) === fishZone(id) && hasD(k))) return send(ws, { t: 'news', text: '같은 낚시터 물고기가 도감에 없어요' });
        rw.wish = 1; const w = WISH_RW[fishRar(id)]; g = full ? w.g : Math.round(w.g / 2); tk = full ? w.tk : Math.floor(w.tk / 2); label = '냄새 소원 보상';
      } else if (m.kind === 'fetch') {
        const sp = s.pets && typeof s.pets === 'object' ? s.pets : {}, pt = sp._ && PET_IDS.includes(sp._.pt) ? sp._.pt : 'ruby', L = petLvOf(petXp(sp[pt]));
        if (rw.fetch >= (L < 20 ? 0 : fetchMax(L) + jobRank(s, 'tam', 'gift'))) return;
        rw.fetch++; const tkP = (L >= 70 ? .12 : .06) * (pt === 'ruby' ? 1.5 : 1);
        if (Math.random() < tkP * 2) tk = 1; else g = 150 + L * 15;
        label = '선물 주머니';
      } else return;
      if (tk) e.tk = Math.min(ENH.TK_MAX, e.tk + tk);
      const extra = { note: out.concat([label + ': ' + [g ? '골드 +' + g : '', tk ? '강화권 +' + tk : ''].filter(Boolean).join(' · ')]) };
      if (g) { s.gold = (Number(s.gold) || 0) + g; s.rev = (s.rev | 0) + 1; extra.dgold = g; extra.rev = s.rev; }
      queueSave(me.key, s); sendEnh(ws, me, extra);
    }).catch(e => console.error('pet_rw', e.message)); break;
    /* ----- 스테이터스 창 · 인기도 ----- */
    case 'prof': {
      const l = liveById(m.id); if (!l) return;
      const o = l[1], s = o.save || {}, dex = s.dex || {};
      const pets = {}, sp = s.pets && typeof s.pets === 'object' ? s.pets : {};
      for (const k of PET_IDS) { const st = sp[k]; if (!st || typeof st !== 'object') continue;
        pets[k] = { a: Math.max(0, Math.min(100, st.a | 0)), xp: Math.floor(petXp(st)), h: Math.max(0, Math.min(100, st.h | 0)), hd: typeof st.hd === 'string' ? st.hd.slice(0, 10) : '' }; }
      if (sp._ && PET_IDS.includes(sp._.pt)) pets._ = { pt: sp._.pt };
      send(ws, { t: 'prof', id: o.id, name: o.name, ti: o.look.ti, e: o.look.e, max: s.enh ? s.enh.max | 0 : 0,
        pop: popOf(s), pets, catches: s.stats ? s.stats.catches | 0 : 0, dex: Object.keys(dex).filter(k => dex[k] && dex[k].n > 0).length });
      break;
    }
    case 'pop': {
      const l = liveById(m.id), v = m.v === 1 ? 1 : m.v === -1 ? -1 : 0; if (!l || !v) return;
      const [tws, T] = l; if (T.key === me.key) return;
      withLocks([me.key, T.key], () => {
        if (!me.save || !T.save) return send(ws, { t: 'news', text: '잠시 뒤에 다시 해 주세요' });
        const gv = me.save.popGv && typeof me.save.popGv === 'object' ? me.save.popGv : (me.save.popGv = {}), day = kstDay();
        if (gv[T.key] === day) return send(ws, { t: 'news', text: T.name + ' 님에게는 오늘 이미 인기도를 줬어요' });
        for (const k in gv) if (gv[k] !== day) delete gv[k];   // 지난 날 기록 정리
        gv[T.key] = day;
        const p = popOf(T.save); p.n += v; if (v > 0) p.up++; else p.dn++; T.save.pop = p;
        queueSave(me.key, me.save); queueSave(T.key, T.save);
        send(ws, { t: 'pop_ok', id: T.id, v, pop: p });
        send(tws, { t: 'pop_got', name: me.name, v, pop: p });
      }).catch(e => console.error('pop', e.message));
      break;
    }
  }
}
/* ---------- 낚시터 정복 ---------- */
const ZRW = { tk: [3, 4, 5, 6, 8, 6], g: [5000, 15000, 40000, 100000, 200000, 150000] };   // index.html ZRW와 같아야 해요
const ZONE_COS = { 1: ['lotus', 'pondrobe'], 2: ['leaf', 'streamsuit'], 3: ['whalehat', 'sunset'], 4: ['jelly', 'deepsea'], 5: ['mooncrown', 'starcloak'] };
const ZONE_NAMES = ['잔잔한 연못', '속삭이는 시냇가', '노을 바닷가', '푸른 먼바다', '달빛 호수', '안개 섬'];
function zoneFishIds(z) { if (z === 6) return Array.from({ length: ISLE_N }, (_, i) => ISLE_FIRST + i); const a = []; for (let i = 0; i < 20; i++) { a.push((z - 1) * 20 + i); a.push(100 + (z - 1) * 20 + i); } return a; }
function giveCos(s, ids) { const c = s.cos && typeof s.cos === 'object' ? s.cos : (s.cos = {}); c.own = Array.isArray(c.own) ? c.own : []; const g = Array.isArray(s.cosg) ? s.cosg : (s.cosg = []); const got = [];
  for (const id of ids) { if (!c.own.includes(id)) { c.own.push(id); got.push(id); } if (!g.includes(id)) g.push(id); } return got; }

/* ---------- 4인 배낚시: 모집 → 4명 이상 출항 → 10분 · 어창 · 거대 참다랑어(모두가 같이 당겨야) → 귀항 보상 ---------- */
const PT_MIN = 4, PT_MAX = 5, PT_MS = 10 * 60e3, PT_DAY = 2, PT_BOSS_AT = 4 * 60e3, PT_BOSS_MS = 25e3, PT_LOBBY_MS = 15 * 60e3, PT_TAP_MIN = 15;
let party = null, ptSendT = 0;
const ptToday = s => { const r = s && s.ptd; return r && r.d === kstDay() ? r.n | 0 : 0; };
function ptPub() { if (!party) return null; return { state: party.state, leader: party.names[party.leader], members: party.members.map(k => party.names[k]), hold: party.hold, need: party.need, end: party.end, boss: party.boss ? { got: party.boss.got, need: party.boss.need, until: party.boss.until } : null }; }
function ptSend(extra) { for (const [ws, p] of players) send(ws, Object.assign({ t: 'pt', p: ptPub(), today: ptToday(p.save) }, extra ? extra(p) : {})); }
function ptSoon() { if (ptSendT) return; ptSendT = setTimeout(() => { ptSendT = 0; ptSend(); }, 300); }
function ptClear() { if (party) for (const t of party.timers || []) clearTimeout(t); }
function ptMsg(ws, me, m) {
  const now = Date.now(), isMem = party && party.members.includes(me.key);
  if (m.t === 'pt_open') {
    if (party) return send(ws, { t: 'news', text: '이미 배낚시 모집 중이에요' });
    if (ptToday(me.save) >= PT_DAY) return send(ws, { t: 'news', text: '오늘 배낚시는 ' + PT_DAY + '번 다 나갔어요' });
    party = { leader: me.key, members: [me.key], names: { [me.key]: me.name }, state: 'lobby', hold: 0, need: 0, end: 0, boss: null, timers: [], last: {} };
    party.timers.push(setTimeout(() => { if (party && party.state === 'lobby') { ptClear(); party = null; ptSend(); } }, PT_LOBBY_MS));
    broadcast({ t: 'news', text: '⚓ ' + me.name + ' 님이 배낚시 모집을 시작했어요! 마을 오른쪽 표지판에서 같이 가요 (' + PT_MIN + '명부터 출항)' }, ws);
    return ptSend();
  }
  if (!party) return;
  if (m.t === 'pt_join') {
    if (party.state !== 'lobby' || isMem || party.members.length >= PT_MAX) return;
    if (ptToday(me.save) >= PT_DAY) return send(ws, { t: 'news', text: '오늘 배낚시는 ' + PT_DAY + '번 다 나갔어요' });
    party.members.push(me.key); party.names[me.key] = me.name; return ptSend();
  }
  if (m.t === 'pt_leave') { if (isMem) ptRemove(me.key); return; }
  if (m.t === 'pt_go') {
    if (party.state !== 'lobby' || party.leader !== me.key) return;
    party.members = party.members.filter(k => liveByKey(k));
    if (party.members.length < PT_MIN) { ptSend(); return send(ws, { t: 'news', text: PT_MIN + '명이 모여야 출항할 수 있어요' }); }
    ptClear(); party.timers = []; party.state = 'sea'; party.end = now + PT_MS; party.need = 40 * party.members.length; party.hold = 0;
    for (const k of party.members) { const l = liveByKey(k); if (l && l[1].save) { const s = l[1].save; s.ptd = { d: kstDay(), n: ptToday(s) + 1 }; queueSave(k, s); } }
    party.timers.push(setTimeout(ptBoss, PT_BOSS_AT), setTimeout(ptEnd, PT_MS));
    broadcast({ t: 'news', text: '⚓ ' + party.members.map(k => party.names[k]).join(', ') + ' 님이 배낚시를 떠났어요!' });
    return ptSend(p => party.members.includes(p.key) ? { go: party.members.indexOf(p.key) } : {});
  }
  if (!isMem || party.state !== 'sea') return;
  if (m.t === 'pt_catch') {
    if (now - (party.last[me.key] || 0) < 1200) return; party.last[me.key] = now;
    party.hold += [1, 2, 4, 8, 15][Math.max(0, Math.min(4, m.rar | 0))]; return ptSoon();
  }
  if (m.t === 'pt_tap') {
    const b = party.boss; if (!b) return; const tc = b.tc[me.key] || (b.tc[me.key] = []); while (tc.length && now - tc[0] > 1000) tc.shift(); if (tc.length >= 10) return; tc.push(now);
    b.got++; b.taps[me.key] = (b.taps[me.key] | 0) + 1;
    if (b.got >= b.need && party.members.every(k => (b.taps[k] | 0) >= PT_TAP_MIN)) ptBossWin(); else ptSoon();
  }
}
function ptBoss() { if (!party || party.state !== 'sea') return; party.boss = { got: 0, need: 50 * party.members.length, until: Date.now() + PT_BOSS_MS, taps: {}, tc: {} };
  party.timers.push(setTimeout(() => { if (party && party.boss) { const lazy = party.members.filter(k => (party.boss.taps[k] | 0) < PT_TAP_MIN).map(k => party.names[k]); party.boss = null;
    for (const k of party.members) { const l = liveByKey(k); if (l) send(l[0], { t: 'news', text: '거대 참다랑어가 줄을 끊고 사라졌어요…' + (lazy.length ? ' (' + lazy.join(', ') + ' 님이 더 당겨야 했어요)' : '') }); } ptSend(); } }, PT_BOSS_MS));
  ptSend(p => party.members.includes(p.key) ? { boss: 1 } : {}); }
async function ptBossWin() { const mem = party.members.slice(); party.boss = null; party.bossWin = true; ptSend();
  for (const k of mem) await withLock(k, () => changeBag(k, { [BOSS_ID]: 1 }, '🎉 다 같이 거대 참다랑어를 낚았어요!')).catch(e => console.error('boss', e.message)); }
function ptRemove(key) {
  if (!party) return; party.members = party.members.filter(k => k !== key);
  const l = liveByKey(key); if (l && party.state === 'sea') send(l[0], { t: 'pt', p: ptPub(), end: '먼저 돌아왔어요 (보상 없음)' });
  if (!party.members.length) { ptClear(); party = null; return ptSend(); }
  if (party.leader === key) party.leader = party.members[0];
  ptSend();
}
async function ptEnd() {
  if (!party || party.state !== 'sea') return; const P = party; ptClear(); party = null;
  const full = P.hold >= P.need, tk = full ? 2 : 1, g = full ? 3000 : 1000, mats = ['pearl', 'feather', 'scale', 'note', 'shell', 'weed'];
  for (const k of P.members) {
    await withLock(k, async () => {
      const s = await loadSave(k); if (!s) return;
      const d = { g }; let item = ''; if (full) { item = mats[(Math.random() * mats.length) | 0]; d['i:' + item] = 1; }
      const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + tk);
      const own = (s.cos && s.cos.own) || [], drop = [];
      if (full && !own.includes('lifejacket') && Math.random() < .3) drop.push('lifejacket');
      if (full && !own.includes('pirate') && Math.random() < .06) drop.push('pirate');
      const got = giveCos(s, drop);
      await changeBag(k, d, null);
      const msg = '⚓ 귀항! 어창 ' + Math.min(P.hold, P.need) + '/' + P.need + (full ? ' 만선!' : '') + ' · 강화권 +' + tk + ' · 골드 +' + g + (item ? ' · 재료 +1' : '') + (got.length ? ' · 새 옷!' : '') + (P.bossWin ? ' · 거대 참다랑어 🎉' : '');
      const l = liveByKey(k);
      if (l) { sendEnh(l[0], l[1], { note: out }); if (got.length) send(l[0], { t: 'cos_got', ids: got }); send(l[0], { t: 'pt', p: null, end: msg }); }
      else addMail(k, msg);
      queueSave(k, s);
    }).catch(e => console.error('ptEnd', e.message));
  }
  ptSend();
}

/* ---------- 직업 현황판 · 예보 ---------- */
const rosterCache = new Map();   // key -> {name, job, lv, sit}
let vNote = null, rosterSig = '', rosterT = 0, vBoat = null;
function rosterSet(key, name, save) {
  const j = save && save.job, job = j && ['fish', 'sch', 'cra', 'tam', 'mer'].includes(j.id) ? j.id : '';
  rosterCache.set(key, { name, job, lv: vlOf(save && save.vl), sit: jobRank(save, 'tam', 'sit') > 0, legs: legZones(save) });
  if (save && save.boat && !vBoat) vBoat = { by: name };
  rosterSoon();
}
function rosterSoon() { clearTimeout(rosterT); rosterT = setTimeout(rosterSend, 500); }
function rosterSend(force) {
  const live = new Set([...players.values()].map(p => p.key));
  const list = [...rosterCache.entries()].map(([k, r]) => ({ name: r.name, job: r.job, lv: r.lv, on: live.has(k), sit: r.sit && live.has(k) }));
  const note = vNote && vNote.d === kstDay() ? vNote : null, paths = [...new Set([...rosterCache.values()].flatMap(r => r.legs || []))].sort();
  const sig = JSON.stringify([list, note, vBoat, paths]);
  if (!force && sig === rosterSig) return; rosterSig = sig;
  broadcast({ t: 'roster', list, note, boat: vBoat, paths });
}
/* 마을 기부함: 모두의 저장에 흩어진 기부를 모아서 봐요 */
const BOAT_NEED = { 'i:scale': 10, 'i:pearl': 3, 'i:map': 1, 'i:sail': 1, g: 20000 }, DONORS_NEED = 4, DON_MIN_G = 1000;   // index.html BOAT_NEED와 같아야 해요
/* 한 사람이 넣을 수 있는 양: 재료는 필요한 양의 절반(최소 1), 골드는 1만까지. 골드는 목표를 넘어도 받아서 누구나 기부에 참여할 수 있어요 */
const donCap = k => k === 'g' ? 10000 : Math.max(1, Math.ceil(BOAT_NEED[k] / 2));
async function boxState() {
  const tot = {}, donors = [], per = {};
  for (const key of rosterCache.keys()) {
    const sv = await loadSave(key), d = sv && sv.don; if (!d || typeof d !== 'object') continue;
    let counts = false; for (const k in d) { const n = d[k] | 0; if (!BOAT_NEED[k] || n <= 0) continue; tot[k] = (tot[k] | 0) + n; if (k === 'g' ? n >= DON_MIN_G : n >= 1) counts = true; }
    const nm = (rosterCache.get(key) || {}).name || key; if (counts) donors.push(nm);
    per[nm] = {}; for (const k in d) if (BOAT_NEED[k]) per[nm][k.startsWith('i:') ? k.slice(2) : k] = d[k] | 0;
  }
  const t2 = {}; for (const k in tot) t2[k.startsWith('i:') ? k.slice(2) : k] = tot[k];   // 화면은 'scale', 'g'로 봐요
  return { tot: t2, donors, per };
}
async function csList(ws, me) {
  const all = [];
  for (const key of rosterCache.keys()) { const sv = await loadSave(key); if (sv && Array.isArray(sv.cs)) for (const c of sv.cs) all.push({ by: (rosterCache.get(key) || {}).name || key, id: c.id, n: c.n }); }
  send(ws, { t: 'cs_list', mine: (me.save && Array.isArray(me.save.cs)) ? me.save.cs : [], all });
}
function trState(T) {
  for (const [[w, p], [, o]] of [[T.a, T.b], [T.b, T.a]])
    send(w, { t: 'tr_state', mine: T.offer.get(p.id), theirs: T.offer.get(o.id), okMe: T.ok.has(p.id), okThem: T.ok.has(o.id) });
}
function endTrade(me, msg) {
  const T = me.tr; if (!T) return;
  const other = T.a[1] === me ? T.b : T.a;
  T.a[1].tr = T.b[1].tr = null;
  send(other[0], { t: 'tr_close', msg });
}
/* 3일 지난 글은 내리고, 맡긴 물고기는 주인에게 돌려줘요 */
async function expirePosts() {
  const old = posts.filter(p => Date.now() - Date.parse(p.created_at) > POST_DAYS * 864e5 || !postOk(p));   // 예전 규칙 글(선물 · 다른 낚시터)도 내려요
  for (const p of old) {
    await withLock(p.by_key, async () => {
      if (!posts.includes(p)) return;
      const rule = postOk(p);
      posts = posts.filter(x => x !== p); await db.delPost(p.id);
      if (p.give) await changeBag(p.by_key, { [p.give[0]]: p.give[1] }, rule ? '게시판 글 기한이 지나 맡긴 물고기가 돌아왔어요' : '교환 규칙이 바뀌어 글을 내리고 맡긴 물고기를 돌려드렸어요');
      addMail(p.by_key, rule ? '게시판 글이 ' + POST_DAYS + '일이 지나 내려갔어요.' : '이제 물고기는 같은 낚시터 물고기끼리만 바꿔요. 예전 글은 내려갔어요.');
    }).catch(e => console.error('글 정리 실패', e.message));
  }
}
(async () => {
  try {
    posts = await db.posts();
    for (const r of await db.mails()) { const l = mail.get(r.to_key) || []; if (l.length < 20) l.push({ at: Date.parse(r.created_at), text: r.text }); mail.set(r.to_key, l); }
    console.log('교환소 글', posts.length, '개 불러옴');
    expirePosts();
  } catch (e) { console.error('⚠ 교환소 표를 읽지 못했어요. supabase.sql의 교환소 부분을 Run 했는지 확인하세요:', e.message); }
})();
setInterval(expirePosts, 60 * 60 * 1000);
/* 켜 두기만 해도: 접속해 있는 30분마다 강화권 1장 (하루 3장) */
setInterval(() => {
  for (const [ws, p] of players) {
    if (!p.save || ws.readyState !== 1) continue;
    withLock(p.key, () => {
      const e = enhOf(p.save), out = []; enhDaily(e, out);
      if (e.it < ENH.IDLE_CAP) { e.idle += 60000; if (e.idle >= ENH.IDLE_MIN * 60000) { e.idle = 0; e.it++; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('켜 둔 보상! 강화권 +1 (오늘 ' + e.it + '/' + ENH.IDLE_CAP + ')'); } }
      queueSave(p.key, p.save); if (out.length) sendEnh(ws, p, { note: out });
    });
  }
}, 60000);
db.roster().then(rows => { for (const r of rows || []) { if (r.boat && !vBoat) vBoat = { by: r.name }; if (!rosterCache.has(r.key)) rosterCache.set(r.key, { name: r.name, job: r.job && r.job.id || '', lv: vlOf(r.vl), sit: false, legs: legZones({ dex: r.dex }) }); } console.log('현황판', rosterCache.size, '명'); }).catch(e => console.error('현황판을 읽지 못했어요', e.message));
db.ranks().then(rows => { for (const r of rows || []) rankSet(r.key, r.name, r.enh); console.log('강화 순위', rankCache.size, '명'); }).catch(e => console.error('강화 순위를 읽지 못했어요', e.message));

// 친구 위치 묶어서 보내기
setInterval(() => {
  const list = [];
  for (const p of players.values()) if (p.here && p.dirty) { list.push([p.id, p.x, p.y, p.d, p.m, p.b]); p.dirty = false; }
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
