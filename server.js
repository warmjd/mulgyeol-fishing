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
const SAVE_MS = 5000;
// 운영자: 이 닉네임으로 (그 계정 코드로) 로그인하면 운영자 도구를 쓸 수 있어요. Render 환경변수 ADMINS=이름1,이름2 로 바꿀 수 있어요
const ADMINS = new Set((process.env.ADMINS || '조돌맹').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));            // 같은 사람의 저장은 최소 5초 간격으로 DB에 씀

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
      const { data, error } = await sb.from('players').select('key,name,enh:save->enh,look:save->cos->look,own:save->cos->own');
      if (error) throw error;
      return data;
    },
    async roster() {   // 직업 현황판: 모두의 직업 · 마을 레벨 · 손맛 도감 · 덕분에
      const { data, error } = await sb.from('players').select('key,name,job:save->job,vl:save->vl,boat:save->boat,dex:save->dex,sdex:save->sdex,giant:save->giant,help:save->help');
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
    async ranks() { return [...mem.entries()].map(([key, r]) => ({ key, name: r.name, enh: r.save && r.save.enh, look: r.save && r.save.cos && r.save.cos.look, own: r.save && r.save.cos && r.save.cos.own })); },
    async roster() { return [...mem.entries()].map(([key, r]) => ({ key, name: r.name, job: r.save && r.save.job, vl: r.save && r.save.vl, boat: r.save && r.save.boat, dex: r.save && r.save.dex, sdex: r.save && r.save.sdex, giant: r.save && r.save.giant, help: r.save && r.save.help })); }
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
const ITEM_IDS = ['flesh', 'scale', 'note', 'shell', 'weed', 'pearl', 'feather', 'thread', 'sail', 'toy', 'map', 'b_dough', 'b_shine', 'b_legend_n', 'b_legend', 'shard', 'soup', 'grill', 'snack', 'charm'];   // index.html ITEMS와 같아야 해요
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
  hat: ['straw', 'nohat', 'cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'crown', 'lily', 'fishhat', 'shell', 'captain', 'moonband', 'maple', 'snowcap', 'lotus', 'leaf', 'whalehat', 'jelly', 'mooncrown', 'pirate', 'tiara', 'bearhood', 'bunnyhood', 'cathood', 'pandahood', 'penguinhood', 'foxhood', 'dinohood', 'pumpkin', 'witchhat', 'ghosthead', 'mummyhead', 'wolfhood', 'clownwig', 'devilhorns', 'nightcap', 'chefhat', 'knighthelm', 'halo', 'bunnyears', 'ebcrown'],
  o: ['tee', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star', 'suit', 'vest', 'sailor', 'wave', 'pondrobe', 'streamsuit', 'sunset', 'deepsea', 'starcloak', 'lifejacket', 'fogcoat', 'masterjacket', 'pd_pink', 'pd_sky', 'pd_lav', 'pd_rose', 'pd_snow', 'pd_sea', 'pd_gold', 'bearsuit', 'bunnysuit', 'catsuit', 'pandasuit', 'penguinsuit', 'foxsuit', 'dinosuit', 'witchrobe', 'dracula', 'ghostsheet', 'mummysuit', 'skeleton', 'wolfsuit', 'clownsuit', 'xtee_r', 'xtee_n', 'xtee_m', 'xtee_y', 'xtee_k', 'xtee_w', 'mtee', 'school', 'pajama', 'chef', 'hanbok_p', 'hanbok_b', 'knight', 'idol', 'ebsuit', 'mastercape'],
  fa: ['', 'fangs', 'skullpaint', 'zombie', 'rednose', 'glasses', 'sunglasses', 'heartglasses', 'mask', 'eyepatch', 'mustache', 'blush', 'starsticker', 'whiskers', 'tearpoint'],
  bk: ['', 'dracape', 'devilwings', 'xcape_n', 'xcape_r', 'xcape_k', 'angelwings', 'fairywings', 'butterfly', 'bearbag', 'ebwings'],
  rod: ['bamboo', 'mintrod', 'sakura', 'rainbowrod', 'goldrod', 'lotusrod', 'coral', 'galaxy', 's_rod1', 's_rod2', 's_rod3', 's_rod4', 's_rod5'],
  bob: ['basicbob', 'heartbob', 'mushbob', 'catbob', 'goldbob', 'duck', 'leafbob', 'starfish', 'starbob'],
  ti: ['', 't_new', 't_villager', 't_nap', 't_cat', 't_big', 't_luck', 't_rich', 't_pond', 't_stream', 't_beach', 't_sea', 't_moon', 't_master', 't_enh10', 't_enh15', 't_enh20', 't_pet_ruby', 't_pet_dot', 't_pet_nurung', 't_pet_kkam', 't_pet_churi', 't_s1', 't_s2', 't_s3', 't_s4', 't_s5', 't_s6', 't_smaster', 't_ebvip', 't_jackpot', 't_cup', 't_bounty', 't_host', 't_a_pearl', 't_a_moon', 't_a_tea', 't_a_star', 't_a_cloud', 't_a_sea',
    ...['fish', 'sch', 'cra', 'tam', 'mer'].flatMap(j => [1, 2, 3].map(r => 't_j' + j + r))]
};
const ENH_TITLE_NEED = { t_enh10: 10, t_enh15: 15, t_enh20: 20 };   // 강화 칭호는 서버 기록으로 확인
const FREE = new Set(['straw', 'nohat', 'tee', 'bamboo', 'basicbob', '']);
const HAIR_N = 22, HAIR_FREE = 8, HS_N = 8;   // index.html HAIRS · HSTYLES와 같아야 해요
function cleanLook(l, save, color) {
  l = l && typeof l === 'object' ? l : {};
  const own = new Set((save && save.cos && Array.isArray(save.cos.own)) ? save.cos.own : []);
  const n = (v, max, d) => Number.isInteger(v) && v >= 0 && v < max ? v : d;
  const o = { h: 0, k: n(l.k, 5, 0), s: n(l.s, 10, color | 0) };
  for (const k in LOOK_IDS) { const v = l[k]; o[k] = LOOK_IDS[k].includes(v) && (FREE.has(v) || own.has(v)) ? v : LOOK_IDS[k][0]; }
  o.h = n(l.h, HAIR_N, 0); if (o.h >= HAIR_FREE && !own.has('hc' + o.h)) o.h = 0;   // 8번부터는 염색약
  o.hs = n(l.hs, HS_N, 0); if (o.hs && !own.has('hs' + o.hs)) o.hs = 0;   // 헤어스타일
  const enh = save && save.enh;
  if (ENH_TITLE_NEED[o.ti] && !(enh && enh.max >= ENH_TITLE_NEED[o.ti])) o.ti = '';
  o.e = enh ? enh.lv | 0 : 0;   // 이름표 옆 +강화 수치: 서버 기록 그대로
  o.j = typeof l.j === 'string' && /^(fish|sch|cra|tam|mer)[0-3]$/.test(l.j) ? l.j : '';   // 직업 배지 (아이콘 + 등급 별)
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
/* 안개 조각 · 섬 장비: 조각은 서버만 늘려요 (shardRoll · 선물 · 운영자). 등불 · 섬 장비는 줄어든 조각만큼만 오를 수 있어요
   index.html의 IG_UP.shard · LAMP.it(shard)와 같아야 해요 */
const IG_SH = [3, 8, 15, 25], LAMP_SH = [2, 5, 10, 15, 25], IG_KEYS = ['rod', 'bob', 'lure', 'reel'];
function navCost(o, n) {
  o = o && typeof o === 'object' ? o : {}; n = n && typeof n === 'object' ? n : {};
  const og = o.g && typeof o.g === 'object' ? o.g : {}, ng = n.g && typeof n.g === 'object' ? n.g : {};
  let c = 0;
  for (const k of IG_KEYS) { const a = Math.max(1, og[k] | 0), b = Math.max(1, ng[k] | 0); if (b < a || b > 5) return -1; for (let L = a; L < b; L++) c += IG_SH[L - 1]; }
  const la = o.lamp | 0, lb = n.lamp | 0; if (lb < la || lb > 5) return -1; for (let L = la; L < lb; L++) c += LAMP_SH[L];
  return c;
}
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
  const nav = navCost(old.nav, neu.nav); if (nav < 0) return '섬 장비 기록이 이상해요';
  const sh0 = itemsOf(old).shard | 0, sh1 = itemsOf(neu).shard | 0;
  if (sh1 > sh0 - nav) return nav ? '안개 조각이 모자란데 섬 장비가 올랐어요' : '안개 조각이 저절로 늘었어요';
  return null;
}
/* ---------- 낚싯대 강화 룰렛 (게임의 ENH와 똑같은 규칙 — 결과는 서버가 정해요) ---------- */
const ENH = {
  MAX: 20,
  // 강화 2.0 (2026-11-04): 확률은 높게, 대신 단계마다 별을 여러 개 모아야 올라가요. 안전은 실패해도 별을 안 잃고 K번 연속 실패하면 다음은 확정.
  // 도전은 골드 없이 성공 시 별 3개(대성공 6개), +5부터 실패하면 별 1개를 잃어요. index.html ENH와 같아야 해요
  P: [.95, .90, .85, .80, .75, .70, .65, .60, .55, .50, .46, .43, .40, .37, .34, .31, .29, .27, .25, .23],
  S: [1, 1, 2, 3, 4, 6, 9, 13, 18, 24, 32, 40, 50, 62, 75, 90, 106, 124, 144, 168],
  cost: L => Math.round(50 * Math.pow(1.28, L) / 10) * 10,
  DAILY: 3, FISH_CAP: 15, FISH_PER: 40, IDLE_MIN: 30, IDLE_CAP: 6, PIECE_CAP: 20, PIECE_PER: 5, TK_MAX: 99,
  PTS: [1, 2, 5, 15, 40]
};
ENH.K = ENH.P.map(p => Math.max(2, Math.round(1.8 / p)));   // 안전: 이만큼 연속 실패하면 다음은 확정
const fishRar = id => id < 100 ? rarOf(id % 20) : id < FISH_N ? rarOf((id - 100) % 20) : id === BOSS_ID ? 4 : id >= MK_FIRST ? MK_RAR[id - MK_FIRST] | 0 : id >= PTY_FIRST ? PTY_RAR[id - PTY_FIRST] | 0 : id >= ISLE_FIRST ? rarOf(id - ISLE_FIRST) : (SEASON_FISH[id - FISH_N] || [0])[0];
/* 전설을 잡은 낚시터 (길잡이 보너스) */
function legZones(save) { const d = (save && save.dex) || {}, out = []; for (const k in d) { const id = +k; if (!(d[k] && d[k].n > 0) || fishRar(id) !== 4) continue; const z = id < FISH_N ? (id < 100 ? Math.floor(id / 20) : Math.floor((id - 100) / 20)) + 1 : id >= ISLE_FIRST && id < PTY_FIRST ? 6 : 0; if (z && out.indexOf(z) < 0) out.push(z); } return out; }
const enhDefault = () => ({ lv: 0, max: 0, tk: 0, star: 0, fl: 0, day: '', fp: 0, ft: 0, it: 0, idle: 0, pc: 0, pcd: 0, lit: 0, st: 0 });
const streakBonus = st => st >= 7 ? 2 : st >= 3 ? 1 : 0;   // 연속 출석: 3일째부터 +1, 7일째부터 +2
const CATCH_GAP = 5, CATCH_TK = 2;   // 따라잡기: 광장 동상 주인보다 5단계 이상 낮으면 출석 강화권 +2
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function enhOf(save) { if (!save) return null; save.enh = Object.assign(enhDefault(), save.enh && typeof save.enh === 'object' ? save.enh : {}); return save.enh; }
function enhDaily(e, out) {
  const d = kstDay(); if (e.day === d) return;
  const y = new Date(Date.now() + 9 * 3600e3 - 864e5).toISOString().slice(0, 10);
  e.st = e.day === y ? Math.min(999, (e.st | 0) + 1) : 1;
  e.day = d; e.ft = 0; e.it = 0; e.idle = 0; e.pcd = 0;
  const cu = champ && (champ.lv | 0) - (e.lv | 0) >= CATCH_GAP ? CATCH_TK : 0;
  const n = ENH.DAILY + streakBonus(e.st) + cu; e.tk = Math.min(ENH.TK_MAX, e.tk + n);
  out.push('오늘의 출석 강화권 ' + n + '장!' + (e.st > 1 ? ' (연속 ' + e.st + '일째)' : '') + (cu ? ' · 따라잡기 +' + cu : ''));
}
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
  e.tk--; e.star = e.star | 0; e.fl = e.fl | 0;
  const sure = mode === 'safe' && e.fl >= ENH.K[L], ok = sure || Math.random() < ENH.P[L];
  let k, ds = 0;
  if (ok) { ds = mode === 'safe' ? 1 : (Math.random() < .1 ? 6 : 3); k = ds >= 6 ? 'jack' : 'up'; e.fl = 0; }
  else { k = 'keep'; if (mode === 'safe') e.fl++; else if (L >= 5 && e.star > 0) { ds = -1; k = 'down'; } }
  e.star = Math.max(0, e.star + ds);
  while (e.lv < ENH.MAX && e.star >= ENH.S[e.lv]) { e.star -= ENH.S[e.lv]; e.lv++; e.fl = 0; if (e.lv < ENH.MAX) e.star = Math.min(e.star, ENH.S[e.lv] - 1); else e.star = 0; }
  e.max = Math.max(e.max, e.lv);
  return { k, ds, sure, from: L, to: e.lv, cost, mode };
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
  if (all.some(o => (o['i:shard'] | 0) > 0)) return '안개 조각은 주고받을 수 없어요';   // 섬은 모두 같이 시작
  if (!fish.length) return goldRule(all[0], all[1]) || goldRule(all[1], all[0]);
  if (all.some(o => Object.keys(o).some(k => keyKind(k) !== 'f' && o[k] > 0))) return '물고기는 물고기와만 바꿀 수 있어요 (골드 · 아이템은 따로)';
  if (all.some(o => !Object.keys(o).some(k => o[k] > 0))) return '물고기는 서로 한 마리 이상씩 올려야 바꿀 수 있어요';
  if (new Set(fish.map(placeOf)).size > 1) return '같은 낚시터 물고기끼리만 바꿀 수 있어요';
  return null;
}
/* 골드는 아이템 값만큼만: 골드를 주는 쪽 상대가 아이템을 내야 하고, 골드 ≤ 그 아이템 잡화점 값 × 1.5 (선물로 골드 퍼주기 막기) */
const ITEM_NPC = { flesh: 80, scale: 2500, note: 3000, shell: 300, weed: 300, pearl: 4000, feather: 3000, thread: 6000, sail: 30000, toy: 4000, map: 40000, b_dough: 150, b_shine: 1500, b_legend_n: 150000, b_legend: 150000, soup: 900, grill: 900, snack: 600, charm: 5000 };   // index.html ITEMS의 npc와 같아야 해요
const tradeGoldCap = o => { let v = 0; for (const k in o) if (keyKind(k) === 'i' && o[k] > 0) v += (ITEM_NPC[k.slice(2)] || 0) * o[k]; return Math.floor(v * 1.5); };
function goldRule(a, b) {   // a가 골드를 낼 때 b가 내는 것
  const g = a.g | 0; if (g <= 0) return null;
  if ((b.g | 0) > 0) return '골드끼리는 바꿀 수 없어요';
  const cap = tradeGoldCap(b);
  if (!cap) return '골드는 아이템을 받을 때만 줄 수 있어요';
  if (g > cap) return '골드는 받는 아이템 값의 1.5배(' + cap + ')까지만 줄 수 있어요';
  return null;
}
const postOk = p => !!(p.give && p.want && placeOf(p.give[0]) === placeOf(p.want[0]));
/* ---------- 직업 2.0: 의뢰판 · 이름 붙은 생산물 · 오늘의 일 · 명장 축복 ---------- */
const MAKER = { flesh: 'cra', b_dough: 'cra', soup: 'cra', grill: 'cra', b_shine: 'cra', snack: 'cra', charm: 'cra', b_legend: 'cra', note: 'sch', map: 'sch', shell: 'tam', weed: 'tam', pearl: 'tam', feather: 'tam', scale: 'fish', thread: 'mer', sail: 'mer', toy: 'mer' };   // index.html MAKER와 같아야 해요
const ITEM_NAME = { flesh: '생선살', b_dough: '반죽 미끼', soup: '생선 수프', grill: '소금구이', b_shine: '반짝 미끼', snack: '펫 간식', charm: '행운 부적', b_legend: '전설 미끼', note: '연구 노트', map: '항로 지도', shell: '조개껍데기', weed: '해초', pearl: '진주', feather: '반짝 깃털', scale: '대물 비늘', thread: '반짝 실', sail: '수입 돛', toy: '펫 장난감' };
const JOB_NAME = { fish: '물결 낚시꾼', sch: '도감 박사', cra: '공방 장인', tam: '동물 친구', mer: '떠돌이 상인' };
const jobOf = s => (s && s.job && MAKER_JOBS.includes(s.job.id)) ? s.job.id : '';
const MAKER_JOBS = ['fish', 'sch', 'cra', 'tam', 'mer'];
const REQ_DAYS = 3, REQ_MAX = 3, JR_MASTER = 4000;
const reqsOf = s => Array.isArray(s.req) ? s.req : (s.req = []);
/* 마을(NPC) 의뢰: 날짜로 정해져요. 직업마다 2개, 사람마다 하루 한 번씩 해결 */
const NPC_POOL = { cra: [['b_dough', 3], ['soup', 2], ['grill', 2], ['b_shine', 2], ['snack', 2]], sch: [['note', 1], ['note', 2]], tam: [['shell', 3], ['weed', 3], ['pearl', 1], ['feather', 1]], mer: [['thread', 1], ['toy', 1]], fish: [['scale', 1], ['f', 2]] };
const NPC_WHO = ['잡화점 할머니', '도감관 사서', '조선소 할아버지', '시장 아주머니', '등대지기', '꼬마 낚시꾼'];
function npcReqs() {
  const d = kstDay(), seed = +d.replace(/-/g, ''), rnd = i => { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }, out = [];
  MAKER_JOBS.forEach((job, ji) => { const pool = NPC_POOL[job], first = Math.floor(rnd(ji * 10) * pool.length); for (let i = 0; i < 2; i++) {
    const p = pool[i === 0 || pool.length < 2 ? first : (first + 1 + Math.floor(rnd(ji * 10 + 1) * (pool.length - 1))) % pool.length]; let item = p[0];   // 같은 직업 두 의뢰는 서로 달라요
    if (item === 'f') { const ids = []; for (let z = 0; z < 3; z++) for (let k = 0; k < 20; k++) if (rarOf(k) === 2) ids.push(z * 20 + k); item = 'f:' + ids[Math.floor(rnd(ji * 10 + i + 5) * ids.length)]; }
    out.push({ id: 'n' + d + job + i, job, item, n: p[1], who: NPC_WHO[Math.floor(rnd(ji * 10 + i + 7) * NPC_WHO.length)] });
  } });
  return out;
}
const hasReqItem = (s, item, n) => item.startsWith('f:') ? has(s, +item.slice(2), n) : (itemsOf(s)[item] | 0) >= n;
const reqDelta = (item, n) => item.startsWith('f:') ? { [+item.slice(2)]: n } : { ['i:' + item]: n };
/* 내가 만든 물건이 친구에게 가면 이름표를 붙여 둬요 (그걸로 대박이 나면 고맙다는 소식이 와요) */
function tagMaker(key, item, by, n) {
  return loadSave(key).then(s => { if (!s) return; const mk = s.mk && typeof s.mk === 'object' ? s.mk : (s.mk = {}); const q = Array.isArray(mk[item]) ? mk[item] : (mk[item] = []);
    for (let i = 0; i < Math.min(n, 20); i++) q.push(by); if (q.length > 40) q.splice(0, q.length - 40); queueSave(key, s);
    const l = liveByKey(key); if (l) send(l[0], { t: 'mk', item, by, n }); });
}
/* 숙련도: 접속 중이면 화면이 더하고, 아니면 저장에 바로 더해요 */
async function giveJxp(key, job, n, why) {
  const l = liveByKey(key); if (l) return send(l[0], { t: 'jxp', job, n, why: why || null });
  const s = await loadSave(key); if (!s) return; if (!s.job || typeof s.job !== 'object') return; const x = s.job.xp && typeof s.job.xp === 'object' ? s.job.xp : (s.job.xp = {});
  x[job] = (x[job] | 0) + n; queueSave(key, s); if (why) addMail(key, why);
}
const thanksCnt = new Map();   // key -> {d, n}
async function reqList(me) {
  const list = [], now = Date.now();
  for (const key of rosterCache.keys()) {
    const sv = await loadSave(key); if (!sv || !Array.isArray(sv.req) || !sv.req.length) continue;
    const old = sv.req.filter(q => now - q.at > REQ_DAYS * 864e5);
    for (const q of old) await withLock(key, async () => { const s2 = await loadSave(key), r = reqsOf(s2), i = r.findIndex(x => x.id === q.id); if (i < 0) return; r.splice(i, 1); if (q.pay) await changeBag(key, { g: q.pay }, '의뢰가 ' + REQ_DAYS + '일 지나 내려가고 의뢰비가 돌아왔어요'); else queueSave(key, s2); });
    for (const q of sv.req) if (now - q.at <= REQ_DAYS * 864e5) list.push({ id: q.id, by: (rosterCache.get(key) || {}).name || key, item: q.item, n: q.n, pay: q.pay, at: q.at, mine: key === me.key });
  }
  const nr = me.save && me.save.nrq && me.save.nrq.d === kstDay() ? me.save.nrq.done : [];
  return { t: 'rq_list', list: list.sort((a, b) => b.at - a.at), npc: npcReqs(), ndone: nr };
}
async function findReq(id) { for (const key of rosterCache.keys()) { const sv = await loadSave(key); if (sv && Array.isArray(sv.req) && sv.req.some(q => q.id === id)) return key; } return null; }
/* 손맛 도감: 내가 직접 낚은 물고기만 (교환 · 선물로 받은 건 안 올라가요). 저장에서 늘어난 도감 마릿수만큼만 늘 수 있어요 */
const SZRW_TK = [3, 4, 5, 6, 8, 6];   // index.html SZRW와 같아야 해요
const SZ_COS = { 1: ['t_s1', 's_rod1'], 2: ['t_s2', 's_rod2'], 3: ['t_s3', 's_rod3'], 4: ['t_s4', 's_rod4'], 5: ['t_s5', 's_rod5'], 6: ['t_s6', 'fogcoat'] };
const SZ_ALL = ['t_smaster', 'masterjacket'], SZ_ALL_TK = 10;
const sdexOf = s => (s.sdex && typeof s.sdex === 'object') ? s.sdex : (s.sdex = {});
const sdN = s => { const d = (s && s.sdex) || {}; let n = 0; for (const k in d) if ((d[k] | 0) > 0) n++; return n; };
function checkSdex(oldS, neu, oldDex, newDex) {
  const os = (oldS && oldS.sdex) || {}, ns = neu.sdex && typeof neu.sdex === 'object' ? neu.sdex : {}, out = {};
  let fixed = false;
  for (const k of new Set([...Object.keys(os), ...Object.keys(ns)])) {
    if (!validFish(+k)) { fixed = true; continue; }
    const a = Math.max(0, os[k] | 0), b = Math.max(0, ns[k] | 0);
    const dn = Math.max(0, (newDex[k] ? newDex[k].n | 0 : 0) - (oldDex[k] ? oldDex[k].n | 0 : 0));
    const v = Math.max(a, Math.min(b, a + dn)); if (v !== b) fixed = true; if (v > 0) out[k] = v;
  }
  neu.sdex = out; return fixed;
}
/* 장소마다 하루 한 번: 그날 처음 낚으면 랜덤 선물 (index.html GIFT와 같은 규칙). 어느 낚시터든 선물 가치는 같아요 */
const GIFT_PLACES = [1, 2, 3, 4, 5, 6, 8];   // 배낚시(7)는 귀항 보상이 따로 있어요
const GIFT_COS = ['cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star'];
function giftOf(s) { const d = kstDay(); let g = s.gift; if (!g || typeof g !== 'object' || g.d !== d || !Array.isArray(g.z)) g = s.gift = { d, z: [] }; return g; }
function giftRoll(s, e, delta, cos, out, z) {
  const r = Math.random();
  if (r < .04) {   // 옷 (다 가졌으면 강화권)
    const own = (s.cos && s.cos.own) || [], pool = GIFT_COS.filter(id => !own.includes(id));
    if (pool.length) { const id = pool[(Math.random() * pool.length) | 0]; cos.push(id); out.push('새 옷!'); return; }
  }
  if (r < .12) { e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('강화권 +1'); return; }
  if (r < .45) { e.pc += 2; out.push('반짝 조각 +2'); while (e.pc >= ENH.PIECE_PER) { e.pc -= ENH.PIECE_PER; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('조각으로 강화권 +1'); } return; }
  const m = z === 6 ? ['shard', 2] : Math.random() < .06 ? [['pearl', 1], ['feather', 1], ['scale', 1]][(Math.random() * 3) | 0] : [['flesh', 4], ['shell', 2], ['weed', 2]][(Math.random() * 3) | 0];
  delta['i:' + m[0]] = (delta['i:' + m[0]] | 0) + m[1];   // 재료 이름은 화면이 delta로 보여 줘요
}
/* 안개 조각: 섬 물고기를 직접 낚으면 (손맛 도감이 늘어난 만큼) 희귀할수록 잘. 하루 SHARD_DAY개까지 — index.html shardDrop과 같은 규칙 */
const SHARD_DAY = 12, SHARD_CH = [.15, .25, .6, 1, 1];
function shardRoll(s, oldSd) {
  const d = kstDay(); if (!s.shd || typeof s.shd !== 'object' || s.shd.d !== d) s.shd = { d, n: 0 };
  const nsd = (s.sdex && typeof s.sdex === 'object') ? s.sdex : {}; let got = 0;
  for (let id = ISLE_FIRST; id < PTY_FIRST; id++) {
    let dn = Math.max(0, (nsd[id] | 0) - (oldSd[id] | 0)); const r = fishRar(id);
    while (dn-- > 0 && s.shd.n < SHARD_DAY) if (Math.random() < SHARD_CH[r]) { const k = Math.min(r >= 4 ? 3 : 1, SHARD_DAY - s.shd.n); s.shd.n += k; got += k; }
  }
  return got;
}
function petRwOf(save) { const d = kstDay(); let r = save.petrw; if (!r || typeof r !== 'object' || r.d !== d) r = save.petrw = { d, walk: 0, wish: 0, fetch: 0 }; return r; }
const popOf = s => Object.assign({ n: 0, up: 0, dn: 0 }, s && s.pop && typeof s.pop === 'object' ? s.pop : {});
const lifeCd = new Map();     // key -> {src[:id]: 시각}
const rankCache = new Map();  // key -> {name, lv, max}
function rankSet(key, name, e, look) {
  if (!(e && (e.max > 0 || e.lv > 0))) return;
  const old = rankCache.get(key);
  rankCache.set(key, { name, lv: e.lv | 0, max: e.max | 0, look: look || (old && old.look) || null });
  champCheck();
}
/* 명예의 전당: 마을 광장 동상은 지금 강화 단계 1등의 모습. 같은 단계면 먼저 오른 사람이 지켜요 */
let champ = null, champBoot = false;
const champPub = () => champ && { name: champ.name, lv: champ.lv, max: champ.max, look: champ.look };
function champCheck() {
  let best = null;
  for (const [k, r] of rankCache) if (!best || r.lv > best.r.lv || (r.lv === best.r.lv && r.max > best.r.max)) best = { k, r };
  if (best && champ && champ.key !== best.k) { const cur = rankCache.get(champ.key); if (cur && cur.lv === best.r.lv) best = { k: champ.key, r: cur }; }
  const nc = best && best.r.lv > 0 ? { key: best.k, name: best.r.name, lv: best.r.lv, max: best.r.max, look: best.r.look } : null;
  if (JSON.stringify(nc) === JSON.stringify(champ)) return;
  const newKing = nc && (!champ || champ.key !== nc.key);
  champ = nc; broadcast({ t: 'champ', c: champPub() });
  if (newKing && champBoot) broadcast({ t: 'news', text: '👑 ' + nc.name + ' 님(+' + nc.lv + ')이 마을 광장 동상의 주인이 됐어요!' });
}
const rankTop = () => [...rankCache.values()].sort((a, b) => b.max - a.max || b.lv - a.lv).slice(0, 10).map(r => ({ name: r.name, lv: r.lv, max: r.max }));
function sendEnh(ws, me, extra) { send(ws, Object.assign({ t: 'enh', enh: me.save.enh }, extra || {})); }
function lookChanged(ws, me) { me.look = cleanLook(me.look, me.save, me.color); broadcast({ t: 'look', id: me.id, look: me.look }, ws); if (rankCache.has(me.key)) rankSet(me.key, me.name, me.save && me.save.enh, me.look); }

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
        const p = { id: nextId++, key, name: row.name, color, admin: ADMINS.has(key), x: 0, y: 0, d: 'down', m: 0, b: 0, here: false,
          save: row.save, look: cleanLook(row.save && row.save.cos && row.save.cos.look, row.save, color), tr: null, sayT: 0, emoT: 0 };
        players.set(ws, p);
        send(ws, { t: 'login_ok', id: p.id, name: p.name, color: p.color, save: row.save, isNew, admin: p.admin });
        // 지금 있는 친구들 알려 주기 / 내가 왔다고 알리기 (외형 포함)
        for (const [ows, op] of players) if (ows !== ws) send(ws, { t: 'join', id: op.id, name: op.name, color: op.color, x: op.x, y: op.y, d: op.d, here: op.here, look: op.look });
        broadcast({ t: 'join', id: p.id, name: p.name, color: p.color, look: p.look }, ws);
        if (p.save) { const e = enhOf(p.save), out = []; enhDaily(e, out); rankSet(key, p.name, e, p.look); sendEnh(ws, p, { note: out }); if (out.length) queueSave(key, p.save); }
        send(ws, { t: 'champ', c: champPub() });
        rosterSet(key, p.name, p.save); rosterSend(true);
        send(ws, { t: 'pt', p: ptPub(), today: ptToday(p.save) });
        send(ws, { t: 'ev', list: evList() });
        if (p.save && Array.isArray(p.save.auh) && p.save.auh.length) withLock(key, () => holdRefund(key)).catch(e => console.error('hold', e.message));
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
        m.data.szrw = me.save && Array.isArray(me.save.szrw) ? me.save.szrw : [];   // 손맛 정복 보상 받은 기록
        m.data.req = me.save && Array.isArray(me.save.req) ? me.save.req : [];   // 내가 올린 의뢰 (의뢰비는 서버가 맡아 둬요)
        m.data.nrq = me.save && me.save.nrq ? me.save.nrq : null;   // 오늘 해결한 마을 의뢰
        m.data.jtd = me.save && me.save.jtd ? me.save.jtd : '';   // 오늘의 일 강화권 받은 날
        m.data.blessd = me.save && me.save.blessd ? me.save.blessd : '';   // 명장 축복 한 날
        m.data.shd = me.save && me.save.shd ? me.save.shd : null;   // 오늘 모은 안개 조각 수 (서버가 세요)
        m.data.evd = me.save && me.save.evd ? me.save.evd : '';   // 행사를 연 날
        m.data.evn = me.save ? me.save.evn | 0 : 0;   // 행사를 연 횟수
        m.data.auh = me.save && Array.isArray(me.save.auh) ? me.save.auh : [];   // 반짝 장터에 맡긴 골드
        m.data.help = me.save && me.save.help ? me.save.help : null;   // 덕분에 받은 횟수
        m.data.eb = me.save && me.save.eb ? me.save.eb : null;   // 은비랜드 코인 (서버만)
        const oldSd = (me.save && me.save.sdex) || {};
        const sFixed = checkSdex(me.save, m.data, oldDex, newDex);   // 손맛 도감은 실제로 낚은 만큼만
        m.data.cosg = me.save && Array.isArray(me.save.cosg) ? me.save.cosg : [];   // 서버가 준 옷: 화면 저장에서 빠져도 다시 넣어요
        if (m.data.cosg.length) { const c = m.data.cos && typeof m.data.cos === 'object' ? m.data.cos : (m.data.cos = {}); c.own = Array.isArray(c.own) ? c.own : []; for (const id of m.data.cosg) if (!c.own.includes(id)) c.own.push(id); }
        const e = enhOf(m.data), out = [];
        enhDaily(e, out);
        if (!first) { let pts = 0; for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0); if (dn > 0) pts += dn * ENH.PTS[fishRar(+k)]; } if (pts) enhAddPoints(e, pts, out); }
        me.save = m.data; lastSaveAt.set(me.key, now); rosterSet(me.key, me.name, m.data);
        if (sFixed) send(ws, { t: 'sdex', sdex: m.data.sdex });   // 손맛 도감을 서버 기록에 맞춰요
        if (!first) {   // 섬 물고기를 직접 낚았으면 안개 조각
          const sh = shardRoll(m.data, oldSd);
          if (sh) { const rev = applyInv(m.data, { 'i:shard': sh }); send(ws, { t: 'delta', d: { 'i:shard': sh }, rev, shd: m.data.shd, why: '🔹 섬 물고기를 직접 낚았어요 (오늘 ' + m.data.shd.n + '/' + SHARD_DAY + ')' }); }
        }
        if (!first) {   // 장소마다 오늘 첫 낚시 선물
          const g = giftOf(m.data), places = [];
          for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0), z = placeOf(+k); if (dn > 0 && GIFT_PLACES.includes(z) && !g.z.includes(z) && !places.includes(z)) places.push(z); }
          if (places.length) {
            const delta = {}, cos = [], gout = [];
            for (const z of places) { g.z.push(z); giftRoll(m.data, e, delta, cos, gout, z); }
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
      broadcast({ t: 'look', id: me.id, look: me.look }, ws);
      if (rankCache.has(me.key)) rankSet(me.key, me.name, me.save && me.save.enh, me.look); break;
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
        for (const [from, to, o] of [[A, B, oa], [B, A, ob]]) for (const k in o) { const it = keyKind(k) === 'i' ? k.slice(2) : ''; if (it && MAKER[it] && jobOf(from.save) === MAKER[it]) await tagMaker(to.key, it, from.name, o[k]); }
        console.log('교환', A.name, JSON.stringify(oa), '↔', B.name, JSON.stringify(ob));
      }).catch(e => console.error('tr_ok', e.message));
      break;
    }
    case 'tr_cancel': endTrade(me, me.name + ' 님이 교환을 그만뒀어요'); break;
    /* ----- 낚싯대 강화 룰렛 ----- */
    case 'enh_try': withLock(me.key, async () => {
      if (!me.save) return send(ws, { t: 'enh', err: '잠시 뒤에 다시 해 주세요' });
      const e = enhOf(me.save), out = []; enhDaily(e, out); if (!e.star) e.star = 0; if (!e.fl) e.fl = 0;
      const mode = m.mode === 'gamble' ? 'gamble' : 'safe', n = Math.max(1, Math.min(10, m.n | 0)), rolls = [], from = e.lv; let gold = 0, err = '';
      for (let i = 0; i < n; i++) {
        const r = enhRoll(e, mode, (Number(me.save.gold) || 0), .1 * jobRank(me.save, 'mer', 'enh'));
        if (r.err) { err = r.err; break; }
        if (r.cost) { me.save.gold = (Number(me.save.gold) || 0) - r.cost; gold += r.cost; }
        rolls.push({ k: r.k, ds: r.ds, sure: r.sure, to: r.to });
      }
      if (!rolls.length) return sendEnh(ws, me, { err });
      const extra = { rolls, from, to: e.lv, mode };
      if (gold) { me.save.rev = (me.save.rev | 0) + 1; extra.dgold = -gold; extra.rev = me.save.rev; }
      queueSave(me.key, me.save); sendEnh(ws, me, extra);
      lookChanged(ws, me); rankSet(me.key, me.name, e, me.look);
      if (e.lv > from && e.lv >= 10) broadcast({ t: 'news', text: '✨ ' + me.name + ' 님이 낚싯대 +' + e.lv + ' 강화에 성공했어요!' }, ws);
    }).catch(e => console.error('enh_try', e.message)); break;
    case 'enh_rank': send(ws, { t: 'enh_rank', list: rankTop() }); break;
    case 'giant': {   // 👑 거대 개체 자랑 (+5 낚싯대부터)
      const now = Date.now(); if (now - (me.gtT || 0) < 20000) return; me.gtT = now;
      const nm = cleanText(m.name, 16), len = Math.max(1, Math.min(9999, m.len | 0)); if (!nm) return;
      broadcast({ t: 'news', text: '👑 ' + me.name + ' 님이 거대 ' + nm + '(' + len + 'cm)을(를) 낚았어요!' }, ws); break;
    }
    /* ----- 마을 의뢰판 ----- */
    case 'rq_list': reqList(me).then(r => send(ws, r)).catch(e => console.error('rq_list', e.message)); break;
    case 'rq_post': withLock(me.key, async () => {
      const s = me.save, item = String(m.item || ''), n = Math.max(1, Math.min(10, m.n | 0)), pay = Math.max(0, m.pay | 0);
      if (!s || !MAKER[item]) return send(ws, { t: 'rq_err', msg: '의뢰할 수 없는 물건이에요' });
      const cap = Math.floor((ITEM_NPC[item] || 0) * n * 1.5); if (pay > cap) return send(ws, { t: 'rq_err', msg: '의뢰비는 ' + cap + '골드까지예요' });
      if ((Number(s.gold) || 0) < pay) return send(ws, { t: 'rq_err', msg: '골드가 모자라요' });
      if (reqsOf(s).length >= REQ_MAX) return send(ws, { t: 'rq_err', msg: '의뢰는 ' + REQ_MAX + '개까지 올릴 수 있어요' });
      if (pay) await changeBag(me.key, { g: -pay }, null);
      reqsOf(me.save).push({ id: crypto.randomUUID(), item, n, pay, at: Date.now() }); queueSave(me.key, me.save);
      send(ws, { t: 'rq_ok', text: '📜 의뢰를 올렸어요' + (pay ? ' · 의뢰비 ' + pay + '골드는 교환소가 맡아 둬요' : '') });
      broadcast({ t: 'news', text: '📜 ' + me.name + ' 님이 ' + ITEM_NAME[item] + ' ×' + n + '을(를) 구해요 (' + JOB_NAME[MAKER[item]] + ' 의뢰)' }, ws);
    }).catch(e => console.error('rq_post', e.message)); break;
    case 'rq_del': withLock(me.key, async () => {
      const r = reqsOf(me.save || {}), i = r.findIndex(q => q.id === m.id); if (i < 0) return send(ws, { t: 'rq_err', msg: '이미 없는 의뢰예요' });
      const q = r.splice(i, 1)[0]; if (q.pay) await changeBag(me.key, { g: q.pay }, '의뢰를 내리고 의뢰비를 돌려받았어요'); else queueSave(me.key, me.save);
      send(ws, { t: 'rq_ok', text: '의뢰를 내렸어요' });
    }).catch(e => console.error('rq_del', e.message)); break;
    case 'rq_take': (async () => {
      const owner = await findReq(m.id); if (!owner) return send(ws, { t: 'rq_err', msg: '이미 누가 해결했어요' });
      if (owner === me.key) return send(ws, { t: 'rq_err', msg: '내 의뢰예요' });
      await withLocks([me.key, owner], async () => {
        const os = await loadSave(owner), r = reqsOf(os), i = r.findIndex(q => q.id === m.id); if (i < 0) return send(ws, { t: 'rq_err', msg: '이미 누가 해결했어요' });
        const q = r[i]; if (jobOf(me.save) !== MAKER[q.item]) return send(ws, { t: 'rq_err', msg: JOB_NAME[MAKER[q.item]] + '만 해결할 수 있어요' });
        if (!hasReqItem(me.save, q.item, q.n)) return send(ws, { t: 'rq_err', msg: '가진 게 모자라요' });
        r.splice(i, 1); queueSave(owner, os);
        await changeBag(me.key, Object.assign(reqDelta(q.item, -q.n), q.pay ? { g: q.pay } : {}), '📜 의뢰 해결!' + (q.pay ? ' 의뢰비 +' + q.pay + '골드' : ''));
        await changeBag(owner, reqDelta(q.item, q.n), '📜 ' + me.name + ' 님이 의뢰한 ' + ITEM_NAME[q.item] + ' ×' + q.n + '을(를) 보내 줬어요!');
        if (!liveByKey(owner)) addMail(owner, me.name + ' 님이 의뢰한 ' + ITEM_NAME[q.item] + ' ×' + q.n + '을(를) 보내 줬어요!');
        await tagMaker(owner, q.item, me.name, q.n);
        send(ws, { t: 'rq_ok', solved: true, text: '📜 ' + ((rosterCache.get(owner) || {}).name || '') + ' 님의 의뢰를 해결했어요! 숙련도 +40' });
        send(ws, { t: 'jxp', job: MAKER[q.item], n: 40 });
      });
    })().catch(e => { console.error('rq_take', e.message); send(ws, { t: 'rq_err', msg: '처리하지 못했어요' }); }); break;
    case 'rq_npc': withLock(me.key, async () => {
      const q = npcReqs().find(x => x.id === m.id), s = me.save; if (!q || !s) return send(ws, { t: 'rq_err', msg: '오늘 의뢰가 아니에요' });
      if (jobOf(s) !== q.job) return send(ws, { t: 'rq_err', msg: JOB_NAME[q.job] + '만 해결할 수 있어요' });
      const nr = s.nrq && s.nrq.d === kstDay() ? s.nrq : (s.nrq = { d: kstDay(), done: [] }); if (nr.done.includes(q.id)) return send(ws, { t: 'rq_err', msg: '이미 해결했어요' });
      if (!hasReqItem(s, q.item, q.n)) return send(ws, { t: 'rq_err', msg: '가진 게 모자라요' });
      nr.done.push(q.id); await changeBag(me.key, reqDelta(q.item, -q.n), null);
      const e = enhOf(me.save), out = []; enhDaily(e, out); e.pc += 3; out.push('마을 의뢰 해결! 반짝 조각 +3');
      while (e.pc >= ENH.PIECE_PER) { e.pc -= ENH.PIECE_PER; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('조각으로 강화권 +1'); }
      queueSave(me.key, me.save); sendEnh(ws, me, { note: out });
      send(ws, { t: 'rq_ok', solved: true, text: '🏘️ ' + q.who + '의 의뢰를 해결했어요! 숙련도 +30' }); send(ws, { t: 'jxp', job: q.job, n: 30 });
    }).catch(e => console.error('rq_npc', e.message)); break;
    /* ----- 이름 붙은 생산물: 친구가 만든 미끼로 대박이 나면 만든 사람에게 숙련도 + 소식 ----- */
    case 'thanks': {
      const to = String(m.to || '').trim().toLowerCase(), item = String(m.item || ''); if (!to || to === me.key || !rosterCache.has(to)) return;
      const kind = m.kind === 'fc' || m.kind === 'sit' ? m.kind : 'item'; if (kind === 'item' && !MAKER[item]) return;
      const d = kstDay(), c = thanksCnt.get(me.key); if (c && c.d === d && c.n >= 10) return; thanksCnt.set(me.key, { d, n: c && c.d === d ? c.n + 1 : 1 });
      if (kind === 'fc') {   // 도감 박사의 예보 덕분에
        if (!vNote || vNote.d !== d || vNote.by.toLowerCase() !== to) return;
        giveJxp(to, 'sch', 20, null).catch(() => { }); helpAdd(to, me.name, '내 예보 덕분에 ' + (validFish(m.fish) && fishRar(m.fish) >= 3 ? '영웅급 물고기를' : '귀한 물고기를') + ' 낚았대요').catch(() => { });
        if (validFish(m.fish) && fishRar(m.fish) >= 3) broadcast({ t: 'news', text: '📖 ' + me.name + ' 님이 ' + vNote.by + ' 박사의 예보 덕분에 귀한 물고기를 낚았어요!' }, ws);
        break;
      }
      if (kind === 'sit') {   // 동물 친구의 돌봐주기 덕분에
        const r = rosterCache.get(to), l = liveByKey(to); if (!r || !r.sit || !l) return;
        giveJxp(to, 'tam', 15, null).catch(() => { }); helpAdd(to, me.name, '돌봐주기 덕분에 짝꿍이 레벨업했어요').catch(() => { });
        break;
      }
      helpAdd(to, me.name, '내가 만든 ' + ITEM_NAME[item] + '(으)로 ' + (validFish(m.fish) && fishRar(m.fish) >= 4 ? '전설을' : '귀한 물고기를') + ' 낚았대요').catch(() => { });
      const what = validFish(m.fish) && fishRar(m.fish) >= 4 ? '전설을' : '귀한 물고기를', toName = rosterCache.get(to).name;
      giveJxp(to, MAKER[item], 30, '🌟 ' + me.name + ' 님이 내가 만든 ' + ITEM_NAME[item] + '(으)로 ' + what + ' 낚았어요! 숙련도 +30').catch(e => console.error('thanks', e.message));
      broadcast({ t: 'news', text: '🌟 ' + me.name + ' 님이 ' + toName + '표 ' + ITEM_NAME[item] + '(으)로 ' + what + ' 낚았어요!' }, ws);
      break;
    }
    /* ----- 마을 행사 ----- */
    case 'ev_open': evOpen(ws, me, m); break;
    case 'ev_catch': evCatch(ws, me, m); break;
    case 'ev_buy': evBuy(ws, me, m); break;
    case 'ev_bid': evBid(ws, me, m); break;
    case 'ev_list': send(ws, { t: 'ev', list: evList() }); break;
    /* ----- 은비랜드 ----- */
    case 'eb_info': case 'eb_buy': case 'eb_shop': case 'eb_slot': case 'eb_race': case 'eb_hilo': case 'eb_vip': ebMsg(ws, me, m); break;
    /* ----- 오늘의 일 세 가지 다 하면 강화권 1장 (하루 한 번) ----- */
    case 'jtask_all': withLock(me.key, () => {
      const s = me.save; if (!s || !jobOf(s) || s.jtd === kstDay()) return; s.jtd = kstDay();
      const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('오늘의 일 세 가지 완료! 강화권 +1'); queueSave(me.key, s); sendEnh(ws, me, { note: out });
    }); break;
    /* ----- 명장 축복: 하루 한 번, 마을 모두에게 20분 행운 ----- */
    case 'bless': withLock(me.key, () => {
      const s = me.save, job = jobOf(s); if (!job) return; const x = (s.job.xp && s.job.xp[job]) | 0;
      if (x < JR_MASTER) return send(ws, { t: 'news', text: '명장 등급부터 할 수 있어요' });
      if (s.blessd === kstDay()) return send(ws, { t: 'news', text: '오늘 축복은 이미 했어요' });
      s.blessd = kstDay(); queueSave(me.key, s);
      for (const [w, p] of players) send(w, { t: 'bless', by: me.name, job, mine: p === me });
    }); break;
    /* ----- 운영자 도구: 공지 · 선물(골드 · 강화권 · 아이템 · 물고기) · 직업 대기 풀기. 운영자 계정만 ----- */
    case 'adm': {
      if (!me.admin) return;
      const ok = text => send(ws, { t: 'adm_ok', text });
      if (m.op === 'notice') { const text = cleanText(m.text, 80); if (text) { broadcast({ t: 'news', text: '📢 운영자: ' + text }); ok('공지를 보냈어요'); } return; }
      const key = String(m.to || '').trim().toLowerCase(); if (!key) return;
      const nm = (rosterCache.get(key) || {}).name || (liveByKey(key) || [0, {}])[1].name; if (!nm) return ok('그런 친구가 없어요');
      withLock(key, async () => {
        const s = await loadSave(key); if (!s) return ok(nm + ' 님 저장이 아직 없어요');
        const l = liveByKey(key);
        if (m.op === 'unjob') {   // 직업 바꾸기 대기 14일 · 끝 노드 잠금 풀기
          if (s.job && typeof s.job === 'object') { s.job.t = 0; s.job.ch = 0; }
          queueSave(key, s); await flushSave(key); rosterSet(key, nm, s);
          if (l) send(l[0], { t: 'job_free' }); else addMail(key, '운영자가 직업 바꾸기 대기를 풀어 줬어요. 지금 바로 바꿀 수 있어요');
          return ok(nm + ' 님 직업 대기를 풀었어요');
        }
        if (m.op === 'give') {
          const k = String(m.k || ''), n = Math.max(-1e7, Math.min(1e7, m.n | 0)); if (!n) return;
          if (k === 'tk') {
            const e = enhOf(s); e.tk = Math.max(0, Math.min(ENH.TK_MAX, e.tk + n)); queueSave(key, s); await flushSave(key);
            if (l) sendEnh(l[0], l[1], { note: ['운영자 선물: 강화권 ' + (n > 0 ? '+' : '') + n] }); else addMail(key, '운영자 선물: 강화권 ' + (n > 0 ? '+' : '') + n);
          } else {
            if (!keyKind(k)) return ok('그런 물건은 없어요');
            await changeBag(key, { [k]: n }, '🎁 운영자 선물');
            if (!l) addMail(key, '운영자 선물이 가방에 들어왔어요');
          }
          console.log('운영자', me.name, '→', nm, k, n);
          return ok(nm + ' 님에게 ' + (k === 'g' ? '골드' : k === 'tk' ? '강화권' : k) + ' ' + n + ' 보냈어요');
        }
      }).catch(e => { console.error('adm', e.message); ok('처리하지 못했어요'); });
      break;
    }
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
    /* ----- 손맛 정복: 직접 낚은 물고기로 한 낚시터를 다 채우면 강화권 · 칭호 · 낚싯대(섬은 옷). 여섯 곳 다 채우면 명인 세트 ----- */
    case 'szone_rw': withLock(me.key, () => {
      const s = me.save, z = m.z | 0; if (!s || z < 1 || z > 6) return;
      const zr = Array.isArray(s.szrw) ? s.szrw : (s.szrw = []); if (zr.includes(z)) return send(ws, { t: 'sz_got', ids: [], szrw: zr });
      const sd = sdexOf(s); if (!zoneFishIds(z).every(id => (sd[id] | 0) > 0)) return;
      zr.push(z); const e = enhOf(s), out = []; enhDaily(e, out);
      let tk = SZRW_TK[z - 1], cos = SZ_COS[z].slice(); const all = [1, 2, 3, 4, 5, 6].every(x => zr.includes(x));
      if (all) { tk += SZ_ALL_TK; cos = cos.concat(SZ_ALL); }
      e.tk = Math.min(ENH.TK_MAX, e.tk + tk);
      const ids = giveCos(s, cos); queueSave(me.key, s);
      sendEnh(ws, me, { note: out });
      send(ws, { t: 'sz_got', ids, szrw: zr, z, tk, all });
      broadcast({ t: 'news', text: '🎣 ' + me.name + ' 님이 직접 낚은 물고기로 「' + ZONE_NAMES[z - 1] + '」 손맛 도감을 다 채웠어요!' + (all ? ' 손맛 명인 탄생!' : '') }, ws);
      rosterSoon();
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
        send(ws, { t: 'jxp', job: 'mer', n: Math.min(120, 20 + cnt * 2) });
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
        pop: popOf(s), pets, catches: s.stats ? s.stats.catches | 0 : 0, dex: Object.keys(dex).filter(k => dex[k] && dex[k].n > 0).length,
        job: jobOf(s) ? { id: jobOf(s), r: jrOf(s, jobOf(s)), cap: jobRank(s, jobOf(s), 'cap') > 0 } : null,
        help: s.help ? { n: s.help.n | 0, t: s.help.d === kstDay() ? s.help.t | 0 : 0 } : { n: 0, t: 0 }, evn: s.evn | 0 });
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
/* ---------- 마을 행사: 직업마다 하루 한 번 개최 (버튼 하나 → 저절로 진행 → 결과 뉴스) ----------
   참가는 평소 하던 행동 그대로 (낚시하면 대회 참가, 지나가다 사 먹기, 놀이터에 서 있기). index.html EV_KIND와 같아야 해요 */
const EV_KIND = {
  cup: { job: 'fish', min: 30, name: '월척 대회', ic: '🏆' },
  bounty: { job: 'sch', min: 60, name: '현상수배', ic: '🎯' },
  stall: { job: 'cra', min: 30, name: '포장마차', ic: '🍢' },
  play: { job: 'tam', min: 30, name: '펫 놀이터', ic: '🐾' },
  auc: { job: 'mer', min: 20, name: '반짝 장터', ic: '🔔' }
};
const EV_MAX = 3, STALL_MENU = ['soup', 'grill', 'snack', 'charm'], STALL_EACH = 3, PLAY_R = 4 * 16, NEAR_R = 3 * 16;
const AUC_TI = ['t_a_pearl', 't_a_moon', 't_a_tea', 't_a_star', 't_a_cloud', 't_a_sea'];   // 장터에서만 나오는 칭호
const AUC_MAT = [['pearl', 2], ['feather', 2], ['thread', 1], ['toy', 1], ['charm', 2]];
const EV_TI = ['t_cup', 't_bounty', 't_host'], HOST_TI_N = 5;   // 대회 우승 · 현상금 사냥꾼 · 행사 5번 연 사람
const JR_X = [0, 300, 1200, 4000];
const jrOf = (s, job) => { const x = s && s.job && s.job.xp ? s.job.xp[job] | 0 : 0; let r = 0; for (let i = 0; i < JR_X.length; i++) if (x >= JR_X[i]) r = i; return r; };
const evs = new Map(); let evSeq = 0, evT = 0;
const evLeft = e => Math.max(0, e.end - Date.now());
function evPub(e) {
  const o = { id: e.id, kind: e.kind, host: e.hostName, x: e.x, y: e.y, end: e.end, n: e.parts.size };
  if (e.kind === 'cup') o.top = [...e.board.values()].sort((a, b) => b.r - a.r).slice(0, 5).map(b => ({ name: b.name, r: b.r, fish: b.fish, len: b.len }));
  if (e.kind === 'bounty') { o.fish = e.fish; o.win = e.win || null; o.pay = e.pay; }
  if (e.kind === 'stall') { o.menu = STALL_MENU.map(k => ({ k, price: stallPrice(k), n: e.stock[k] | 0 })); o.sold = e.sold; }
  if (e.kind === 'auc') o.lots = e.lots.map(l => ({ k: l.k, id: l.id, n: l.n, min: l.min, bid: l.bid, by: l.byName || '', next: aucNext(l) }));
  return o;
}
const evList = () => [...evs.values()].map(evPub);
function evSoon() { if (evT) return; evT = setTimeout(() => { evT = 0; broadcast({ t: 'ev', list: evList() }); }, 300); }
const stallPrice = k => Math.round((ITEM_NPC[k] || 0) * .5);
const aucNext = l => l.bid ? Math.max(l.bid + 100, Math.ceil(l.bid * 1.1 / 10) * 10) : l.min;
/* 서버가 주는 강화권 · 옷 (잠금 안에서 부르기) */
async function giveTk(key, n, note) {
  const s = await loadSave(key); if (!s) return; const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + n); if (note) out.push(note); queueSave(key, s);
  const l = liveByKey(key); if (l && l[1].save === s) sendEnh(l[0], l[1], { note: out }); else if (note) addMail(key, note);
}
async function giveCosTo(key, ids) {
  const s = await loadSave(key); if (!s) return []; const got = giveCos(s, ids); queueSave(key, s);
  const l = liveByKey(key); if (l && got.length) send(l[0], { t: 'cos_got', ids: got }); return got;
}
/* 덕분에: 누군가 내 직업 덕을 보면 세어 두고, 접속 중이면 바로 알려요 */
async function helpAdd(key, fromName, text) {
  const s = await loadSave(key); if (!s) return; const d = kstDay(), h = s.help && typeof s.help === 'object' ? s.help : (s.help = { n: 0, d, t: 0 });
  if (h.d !== d) { h.d = d; h.t = 0; } h.n = (h.n | 0) + 1; h.t = (h.t | 0) + 1; queueSave(key, s);
  const r = rosterCache.get(key); if (r) { r.help = h.n; rosterSoon(); }
  const l = liveByKey(key); if (l) send(l[0], { t: 'thx', from: fromName, text, n: h.n });
}
function evOpen(ws, me, m) {
  return withLock(me.key, async () => {
    const s = me.save, K = EV_KIND[m.kind], err = text => send(ws, { t: 'ev_err', text });
    if (!s || !K) return; if (jobOf(s) !== K.job) return err(JOB_NAME[K.job] + '만 열 수 있어요');
    if (s.evd === kstDay()) return err('행사는 하루에 한 번 열 수 있어요. 내일 또 열어요!');
    if ([...evs.values()].some(e => e.kind === m.kind)) return err('지금 다른 친구가 ' + K.name + '을(를) 열고 있어요');
    if (evs.size >= EV_MAX) return err('지금 행사가 ' + EV_MAX + '개 열려 있어요. 하나가 끝나면 열어 주세요');
    if (!me.here) return err('잠시 뒤에 다시 해 주세요');
    const e = { id: 'e' + (++evSeq), kind: m.kind, host: me.key, hostName: me.name, x: me.x, y: me.y, at: Date.now(), end: Date.now() + K.min * 60e3, parts: new Set(), timer: 0 };
    if (m.kind === 'cup') { e.board = new Map(); e.last = new Map(); }
    if (m.kind === 'bounty') {
      const id = m.fish; if (!validFish(id) || id === BOSS_ID || (id >= FISH_N && id < ISLE_FIRST) || id >= PTY_FIRST) return err('현상수배할 수 없는 물고기예요');
      e.fish = id; e.pay = Math.min(30000, Math.max(1000, fishPrice(id) * 3));
    }
    if (m.kind === 'stall') { const it = itemsOf(s); e.stock = {}; let tot = 0; for (const k of STALL_MENU) { e.stock[k] = it[k] | 0; tot += it[k] | 0; } if (!tot) return err('팔 음식이 없어요. 공방에서 수프 · 구이 · 간식 · 부적을 먼저 만들어 주세요'); e.sold = 0; e.buy = new Map(); }
    if (m.kind === 'play') e.seen = new Set();
    if (m.kind === 'auc') {
      const r = n => Math.floor(Math.random() * n), ti = AUC_TI[r(AUC_TI.length)], mt = AUC_MAT[r(AUC_MAT.length)];
      e.lots = [{ k: 'cos', id: ti, n: 1, min: 3000 }, { k: 'i', id: mt[0], n: mt[1], min: Math.round((ITEM_NPC[mt[0]] || 1000) * mt[1] * .4 / 100) * 100 }, { k: 'i', id: 'b_legend', n: 1, min: 30000 }];
      for (const l of e.lots) { l.bid = 0; l.by = ''; l.byName = ''; }
    }
    s.evd = kstDay(); s.evn = (s.evn | 0) + 1; queueSave(me.key, s);
    evs.set(e.id, e); e.timer = setTimeout(() => evEnd(e.id), e.end - Date.now());
    send(ws, { t: 'ev_ok', kind: m.kind });
    // 행사를 열면 오늘의 일도 끝 (강화권 +1, 하루 한 번)
    if (s.jtd !== kstDay()) { s.jtd = kstDay(); const en = enhOf(s), out = []; enhDaily(en, out); en.tk = Math.min(ENH.TK_MAX, en.tk + 1); out.push('행사를 열어서 오늘의 일 완료! 강화권 +1'); sendEnh(ws, me, { note: out }); }
    if (s.evn >= HOST_TI_N) { const got = giveCos(s, ['t_host']); if (got.length) send(ws, { t: 'cos_got', ids: got }); }
    const where = me.y >= 60 * 16 ? '안개 섬' : (me.x >= 34 * 16 && me.y < 31 * 16) ? '축제 광장' : '마을';
    const how = { cup: K.min + '분 동안 낚은 물고기 크기로 겨뤄요. 낚시만 하면 자동 참가!', bounty: '처음 낚는 사람에게 현상금 ' + (e.pay || 0) + '골드!', stall: '지나가다 사 먹으면 30분 버프!', play: '근처에 있으면 짝꿍이 ♥ · 경험치를 받아요', auc: '오늘만 나오는 물건을 골드로 겨뤄요' }[m.kind];
    broadcast({ t: 'news', text: K.ic + ' ' + me.name + ' 님(' + JOB_NAME[K.job] + ')이 ' + where + '에서 「' + K.name + '」을(를) 열었어요! ' + how });
    evSoon(); rosterSoon();
  }).catch(e => console.error('ev_open', e.message));
}
function evCatch(ws, me, m) {
  const id = m.id; if (!validFish(id) || !me.save) return; const now = Date.now();
  for (const e of evs.values()) {
    if (e.kind === 'cup') {
      if (now - (e.last.get(me.key) || 0) < 1500) continue; e.last.set(me.key, now);
      const r = Math.max(0, Math.min(3, Number(m.r) || 0)), len = Math.max(1, Math.min(9999, m.len | 0)); if (!r) continue;
      e.parts.add(me.key); const b = e.board.get(me.key);
      if (!b || r > b.r) e.board.set(me.key, { name: me.name, r: Math.round(r * 1000) / 1000, fish: id, len });
      evSoon();
    } else if (e.kind === 'bounty' && !e.win && id === e.fish) {
      const z = placeOf(id); if (z <= 6 && zonesOf(me.save).indexOf(z) < 0) continue;
      e.win = me.name; e.parts.add(me.key);
      (async () => {
        await withLock(me.key, async () => { await changeBag(me.key, { g: e.pay }, '🎯 현상수배 해결! 현상금 +' + e.pay + '골드'); await giveTk(me.key, 1, '🎯 현상수배 해결! 강화권 +1'); await giveCosTo(me.key, ['t_bounty']); });
        if (e.host !== me.key) await withLock(e.host, async () => { await giveTk(e.host, 1, '🎯 ' + me.name + ' 님이 내 현상수배를 해결했어요! 강화권 +1'); });
        if (e.host !== me.key) helpAdd(e.host, me.name, '내 현상수배 덕분에 새 물고기를 낚았대요').catch(() => { });
        broadcast({ t: 'news', text: '🎯 현상수배 해결! ' + me.name + ' 님이 ' + e.hostName + ' 박사가 찾던 물고기를 낚았어요! (현상금 ' + e.pay + '골드)' });
        evEnd(e.id);
      })().catch(er => console.error('bounty', er.message));
    }
  }
}
function evBuy(ws, me, m) {
  const e = evs.get(m.ev), k = String(m.item || ''); const err = text => send(ws, { t: 'ev_err', text });
  if (!e || e.kind !== 'stall' || !STALL_MENU.includes(k)) return err('포장마차가 문을 닫았어요');
  if (e.host === me.key) return err('내 노점이에요');
  if (Math.hypot(me.x - e.x, me.y - e.y) > NEAR_R) return err('포장마차 가까이 가서 사 주세요');
  if ((e.buy.get(me.key) | 0) >= STALL_EACH) return err('한 사람은 ' + STALL_EACH + '개까지 살 수 있어요');
  const price = stallPrice(k);
  withLocks([me.key, e.host], async () => {
    if (!evs.has(e.id)) return err('포장마차가 문을 닫았어요');
    const hs = await loadSave(e.host); if (!hs || (itemsOf(hs)[k] | 0) < 1) { e.stock[k] = 0; evSoon(); return err('그 음식은 다 팔렸어요'); }
    if (!hasKey(me.save, 'g', price)) return err('골드가 모자라요');
    e.buy.set(me.key, (e.buy.get(me.key) | 0) + 1); e.parts.add(me.key); e.sold++;
    await changeBag(me.key, { g: -price, ['i:' + k]: 1 }, null);
    await changeBag(e.host, { g: price, ['i:' + k]: -1 }, null);
    e.stock[k] = itemsOf(await loadSave(e.host))[k] | 0;
    send(ws, { t: 'ev_ate', item: k, host: e.hostName });
    giveJxp(e.host, 'cra', 10, null).catch(() => { });
    helpAdd(e.host, me.name, '포장마차에서 ' + ITEM_NAME[k] + '을(를) 사 먹었어요 (+' + price + '골드)').catch(() => { });
    if (!Object.values(e.stock).some(n => n > 0)) { broadcast({ t: 'news', text: '🍢 ' + e.hostName + ' 님의 포장마차가 다 팔렸어요! 완판!' }); evEnd(e.id); } else evSoon();
  }).catch(er => console.error('ev_buy', er.message));
}
/* 반짝 장터: 입찰한 골드는 바로 빠지고(교환소가 맡아 둠), 더 높은 입찰이 오면 돌려줘요. 서버가 다시 켜지면 맡긴 골드는 접속할 때 돌려줘요 */
const holdsOf = s => Array.isArray(s.auh) ? s.auh : (s.auh = []);
function holdDel(s, ev, lot) { const h = holdsOf(s), i = h.findIndex(x => x.ev === ev && x.lot === lot); if (i >= 0) h.splice(i, 1); }
async function holdRefund(key) {   // 끝난(사라진) 장터에 맡긴 골드 돌려주기 (잠금 안에서)
  const s = await loadSave(key); if (!s || !Array.isArray(s.auh) || !s.auh.length) return;
  const dead = s.auh.filter(h => !evs.has(h.ev)); if (!dead.length) return; let g = 0;
  for (const h of dead) { g += h.g | 0; holdDel(s, h.ev, h.lot); }
  if (g > 0) await changeBag(key, { g }, '🔔 반짝 장터가 닫혀서 맡겨 둔 ' + g + '골드를 돌려받았어요'); else queueSave(key, s);
}
function evBid(ws, me, m) {
  const e = evs.get(m.ev), err = text => send(ws, { t: 'ev_err', text }); if (!e || e.kind !== 'auc') return err('장터가 끝났어요');
  const l = e.lots[m.lot | 0]; if (!l || !me.save) return; if (e.host === me.key) return err('내 장터에는 입찰할 수 없어요');
  if (l.by === me.key) return err('이미 내가 1등이에요');
  const g = Math.floor(Number(m.g) || 0); if (g < aucNext(l)) return err('지금은 ' + aucNext(l) + '골드부터 입찰할 수 있어요');
  if (l.k === 'cos') { const own = (me.save && me.save.cos && me.save.cos.own) || []; if (own.includes(l.id)) return err('이미 가진 칭호예요'); }
  const prev = l.by, prevG = l.bid;
  withLocks([me.key].concat(prev ? [prev] : []), async () => {
    if (!evs.has(e.id) || l.by !== prev || l.bid !== prevG) return err('그새 입찰이 바뀌었어요. 다시 해 주세요');
    if (!hasKey(me.save, 'g', g)) return err('골드가 모자라요');
    holdsOf(me.save).push({ ev: e.id, lot: m.lot | 0, g }); await changeBag(me.key, { g: -g }, null);
    l.bid = g; l.by = me.key; l.byName = me.name; e.parts.add(me.key);
    if (prev) { const ps = await loadSave(prev); if (ps) holdDel(ps, e.id, m.lot | 0); await changeBag(prev, { g: prevG }, '🔔 반짝 장터: ' + me.name + ' 님이 더 높게 불러서 ' + prevG + '골드를 돌려받았어요'); if (!liveByKey(prev)) addMail(prev, '반짝 장터에서 ' + me.name + ' 님이 더 높게 불렀어요. ' + prevG + '골드는 돌려드렸어요'); }
    if (evLeft(e) < 60e3) { e.end = Date.now() + 60e3; clearTimeout(e.timer); e.timer = setTimeout(() => evEnd(e.id), 60e3); }   // 막판 입찰은 1분 연장
    send(ws, { t: 'ev_err', text: '🔔 ' + g + '골드에 입찰했어요!' }); evSoon();
  }).catch(er => console.error('ev_bid', er.message));
}
/* 펫 놀이터: 1분마다 근처 친구의 짝꿍이 ♥ · 경험치 */
function evTick() {
  for (const e of evs.values()) {
    if (e.kind !== 'play') continue;
    for (const [ws, p] of players) {
      if (!p.here || !p.save || Math.hypot(p.x - e.x, p.y - e.y) > PLAY_R) continue;
      send(ws, { t: 'ev_pet', host: e.hostName });
      if (p.key !== e.host && !e.seen.has(p.key)) { e.seen.add(p.key); e.parts.add(p.key); giveJxp(e.host, 'tam', 10, null).catch(() => { }); helpAdd(e.host, p.name, '펫 놀이터에서 짝꿍이 신나게 놀았어요').catch(() => { }); evSoon(); }
    }
  }
}
setInterval(evTick, 60000);
async function evEnd(id) {
  const e = evs.get(id); if (!e) return; evs.delete(id); clearTimeout(e.timer); evSoon(); rosterSoon();
  const K = EV_KIND[e.kind], others = [...e.parts].filter(k => k !== e.host), n = others.length;
  try {
    if (e.kind === 'cup') {
      const top = [...e.board.entries()].sort((a, b) => b[1].r - a[1].r);
      if (top.length >= 2) {
        const pay = [2000, 1000, 500];
        for (let i = 0; i < Math.min(3, top.length); i++) { const [k, b] = top[i]; await withLock(k, async () => { await changeBag(k, { g: pay[i] }, '🏆 월척 대회 ' + (i + 1) + '등! 골드 +' + pay[i]); if (i === 0) { await giveCosTo(k, ['t_cup']); if (top.length >= 3) await giveTk(k, 1, '🏆 월척 대회 우승! 강화권 +1'); } }); }
        for (const [k] of top.slice(3)) await withLock(k, () => changeBag(k, { g: 300 }, '🏆 월척 대회 참가상 골드 +300'));
        broadcast({ t: 'news', text: '🏆 월척 대회 끝! 1등 ' + top[0][1].name + ' 님 (평균보다 ' + Math.round(top[0][1].r * 100) + '% 크기)' + (top[1] ? ' · 2등 ' + top[1][1].name : '') + (top[2] ? ' · 3등 ' + top[2][1].name : '') + ' · 참가 ' + top.length + '명' });
      } else broadcast({ t: 'news', text: '🏆 ' + e.hostName + ' 님의 월척 대회가 끝났어요. 다음엔 친구 둘 이상이 모이면 상이 나와요!' });
    }
    if (e.kind === 'bounty' && !e.win) broadcast({ t: 'news', text: '🎯 ' + e.hostName + ' 박사의 현상수배는 아무도 해결하지 못했어요…' });
    if (e.kind === 'stall') broadcast({ t: 'news', text: '🍢 ' + e.hostName + ' 님의 포장마차가 문을 닫았어요 · ' + e.sold + '그릇 · 손님 ' + n + '명' });
    if (e.kind === 'play') broadcast({ t: 'news', text: '🐾 ' + e.hostName + ' 님의 펫 놀이터가 끝났어요 · 놀러 온 친구 ' + n + '명' });
    if (e.kind === 'auc') {
      let sum = 0; const res = [];
      for (let i = 0; i < e.lots.length; i++) {
        const l = e.lots[i]; if (!l.by) continue; sum += l.bid; res.push(l.byName + ' ' + l.bid + '골드');
        await withLock(l.by, async () => {
          const s = await loadSave(l.by); if (s) holdDel(s, e.id, i);
          if (l.k === 'cos') { await giveCosTo(l.by, [l.id]); addMail(l.by, '🔔 반짝 장터 낙찰! 새 칭호를 받았어요 (' + l.bid + '골드)'); }
          else await changeBag(l.by, { ['i:' + l.id]: l.n }, '🔔 반짝 장터 낙찰! ' + ITEM_NAME[l.id] + ' ×' + l.n + ' (' + l.bid + '골드)');
          helpAdd(e.host, l.byName, '반짝 장터에서 물건을 샀어요').catch(() => { });
        });
      }
      const fee = Math.floor(sum * .1);
      if (fee) await withLock(e.host, () => changeBag(e.host, { g: fee }, '🔔 반짝 장터 수수료 +' + fee + '골드'));
      broadcast({ t: 'news', text: '🔔 ' + e.hostName + ' 님의 반짝 장터 끝! ' + (res.length ? '낙찰: ' + res.join(' · ') : '이번엔 낙찰이 없었어요') });
    }
    await giveJxp(e.host, K.job, 20 + Math.min(100, n * 10), n ? K.ic + ' 내 「' + K.name + '」에 친구 ' + n + '명이 함께했어요! 숙련도 +' + (20 + Math.min(100, n * 10)) : null);
  } catch (er) { console.error('ev_end', er.message); }
}

/* ---------- 은비랜드: 골드 → 코인 (한 방향) · 슬롯 · 거북이 경주 · 하이로우 · 경품 교환소 ----------
   결과는 전부 서버가 정해요. 코인은 골드로 되돌릴 수 없어서 골드가 빠져나가는 곳이에요 (게임 평균 환급 약 90%).
   코인을 쓰는 이유: 은비랜드에서만 파는 치장 · 칭호, VIP 등급과 매일 보너스, 마을 전체 잭팟. index.html EB와 같아야 해요 */
const EB = {
  RATE: 10, BUY_DAY: 20000, BETS: [10, 50, 100, 500, 1000],
  SLOT_W: [30, 24, 18, 12, 8, 4], SLOT3: [5, 10, 24, 60, 150, 0], SLOT2: [0, .4, .7, 1, 2, 4], JP_CUT: .03, JP_BASE: 2000,
  RACE_W: [.34, .26, .18, .13, .09], RACE_X: [2.6, 3.5, 5, 6.9, 10],
  VIP: [[5000, '브론즈', 50], [30000, '실버', 200], [150000, '골드', 800], [600000, '다이아', 2000]],
  SHOP: { ebcrown: 40000, ebsuit: 60000, ebwings: 80000, hc20: 20000, hc21: 20000, t_ebvip: 30000 }
};
let ebJP = EB.JP_BASE;
const ebOf = s => { const e = s.eb && typeof s.eb === 'object' ? s.eb : (s.eb = { c: 0, d: '', buy: 0, wag: 0, best: 0, vd: '' }); if (e.d !== kstDay()) { e.d = kstDay(); e.buy = 0; } return e; };
const ebVip = wag => { let t = -1; EB.VIP.forEach((v, i) => { if (wag >= v[0]) t = i; }); return t; };
const ebPub = (s, me) => { const e = ebOf(s); return { t: 'eb', c: e.c | 0, buy: e.buy | 0, wag: e.wag | 0, best: e.best | 0, vip: ebVip(e.wag | 0), vd: e.vd === kstDay(), jp: Math.floor(ebJP), card: me.hiCard || 0 }; };
function ebPick(w) { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return w.length - 1; }
function ebMsg(ws, me, m) {
  withLock(me.key, async () => {
    const s = me.save; if (!s) return; const e = ebOf(s), err = text => send(ws, { t: 'eb_err', text }), done = extra => { queueSave(me.key, s); send(ws, Object.assign(ebPub(s, me), extra || {})); };
    if (m.t === 'eb_info') { if (!me.hiCard) me.hiCard = 1 + Math.floor(Math.random() * 13); return done(); }
    if (m.t === 'eb_vip') { const t = ebVip(e.wag | 0); if (t < 0) return err('VIP 브론즈부터 받을 수 있어요'); if (e.vd === kstDay()) return err('오늘 보너스는 이미 받았어요'); e.vd = kstDay(); const n = EB.VIP[t][2]; e.c += n; return done({ win: n, note: 'VIP ' + EB.VIP[t][1] + ' 오늘의 보너스 코인 +' + n }); }
    if (m.t === 'eb_buy') {
      const n = Math.floor(Number(m.n) || 0); if (n < 10 || n > EB.BUY_DAY) return;
      if ((e.buy | 0) + n > EB.BUY_DAY) return err('오늘은 ' + fmtN(EB.BUY_DAY - (e.buy | 0)) + '코인까지 바꿀 수 있어요');
      const g = n * EB.RATE; if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
      await changeBag(me.key, { g: -g }, null); e.buy = (e.buy | 0) + n; e.c = (e.c | 0) + n; return done({ note: '코인 ' + fmtN(n) + '개로 바꿨어요' });
    }
    if (m.t === 'eb_shop') {
      const id = String(m.id || ''), price = EB.SHOP[id]; if (!price) return; const own = (s.cos && s.cos.own) || [];
      if (own.includes(id)) return err('이미 가지고 있어요'); if ((e.c | 0) < price) return err('코인이 모자라요');
      e.c -= price; const got = giveCos(s, [id]); send(ws, { t: 'cos_got', ids: got }); return done({ note: '경품 교환 완료!' });
    }
    const bet = m.bet | 0; if (!EB.BETS.includes(bet)) return; if ((e.c | 0) < bet) return err('코인이 모자라요');
    e.c -= bet; e.wag = (e.wag | 0) + bet; const v0 = ebVip(e.wag - bet), v1 = ebVip(e.wag);
    let win = 0, extra = {};
    if (m.t === 'eb_slot') {
      ebJP += bet * EB.JP_CUT; const r = [ebPick(EB.SLOT_W), ebPick(EB.SLOT_W), ebPick(EB.SLOT_W)];
      if (r[0] === r[1] && r[1] === r[2]) {
        if (r[0] === 5) { win = Math.floor(ebJP * Math.min(1, bet / 500)); ebJP = Math.max(EB.JP_BASE, ebJP - win); extra.jack = true; const got = giveCos(s, ['t_jackpot']); if (got.length) send(ws, { t: 'cos_got', ids: got }); broadcast({ t: 'news', text: '🎰 잭팟!! ' + me.name + ' 님이 은비랜드에서 ' + fmtN(win) + '코인을 터뜨렸어요!' }); }
        else win = Math.floor(bet * EB.SLOT3[r[0]]);
      } else { const c = {}; r.forEach(x => c[x] = (c[x] | 0) + 1); for (const x in c) if (c[x] === 2) win = Math.floor(bet * EB.SLOT2[x]); }
      extra.reels = r;
    } else if (m.t === 'eb_race') {
      const pick = m.pick | 0; if (pick < 0 || pick > 4) { e.c += bet; e.wag -= bet; return; }
      const w = ebPick(EB.RACE_W); if (w === pick) win = Math.floor(bet * EB.RACE_X[pick]); extra.race = { pick, win: w };
    } else if (m.t === 'eb_hilo') {
      const cur = me.hiCard || (me.hiCard = 1 + Math.floor(Math.random() * 13)), hi = m.g === 'hi', cnt = hi ? 13 - cur : cur - 1;
      if (!cnt) { e.c += bet; e.wag -= bet; return err(hi ? 'K보다 높은 카드는 없어요' : 'A보다 낮은 카드는 없어요'); }
      const nx = 1 + Math.floor(Math.random() * 13), ok = hi ? nx > cur : nx < cur; if (ok) win = Math.floor(bet * Math.floor(.94 / (cnt / 13) * 20) / 20);
      me.hiCard = nx; extra.hilo = { from: cur, to: nx, ok };
    } else { e.c += bet; e.wag -= bet; return; }
    e.c += win; if (win > (e.best | 0)) e.best = win;
    if (win >= 5000 && !extra.jack) broadcast({ t: 'news', text: '🎰 ' + me.name + ' 님이 은비랜드에서 ' + fmtN(win) + '코인을 땄어요!' }, ws);
    if (v1 > v0) extra.note = '🎉 은비랜드 VIP ' + EB.VIP[v1][1] + ' 등급이 됐어요!';
    done(Object.assign(extra, { bet, win }));
  }).catch(er => console.error('eb', er.message));
}
const fmtN = n => Math.round(n).toLocaleString('ko-KR');

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
  for (const k of mem) await withLock(k, async () => {
    await changeBag(k, { [BOSS_ID]: 1 }, '🎉 다 같이 거대 참다랑어를 낚았어요!');
    const s = await loadSave(k); if (!s) return; const sd = sdexOf(s); sd[BOSS_ID] = (sd[BOSS_ID] | 0) + 1; queueSave(k, s);   // 다 같이 당긴 것도 손맛
    const l = liveByKey(k); if (l) send(l[0], { t: 'sdex', sdex: sd });
  }).catch(e => console.error('boss', e.message)); }
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
  rosterCache.set(key, { name, job, lv: vlOf(save && save.vl), sit: jobRank(save, 'tam', 'sit') > 0, legs: legZones(save), sd: sdN(save), gt: gtN(save), dex: dexIds(save && save.dex), help: save && save.help ? save.help.n | 0 : 0, jr: jrOf(save, job) });
  if (save && save.boat && !vBoat) vBoat = { by: name };
  rosterSoon();
}
const gtN = s => (s && s.giant && typeof s.giant === 'object') ? Object.keys(s.giant).length : 0;
const dexIds = d => { const out = []; if (d && typeof d === 'object') for (const k in d) if (d[k] && d[k].n > 0 && validFish(+k)) out.push(+k); return out; };
function rosterSoon() { clearTimeout(rosterT); rosterT = setTimeout(rosterSend, 500); }
function rosterSend(force) {
  const live = new Set([...players.values()].map(p => p.key));
  const list = [...rosterCache.entries()].map(([k, r]) => ({ name: r.name, job: r.job, lv: r.lv, on: live.has(k), sit: r.sit && live.has(k), sd: r.sd | 0, gt: r.gt | 0, help: r.help | 0, jr: r.jr | 0 }));
  const vdex = [...new Set([...rosterCache.values()].flatMap(r => r.dex || []))].sort((a, b) => a - b);   // 마을 도감: 모두가 만난 물고기
  const note = vNote && vNote.d === kstDay() ? vNote : null, paths = [...new Set([...rosterCache.values()].flatMap(r => r.legs || []))].sort();
  let rich = null, rg = -1; for (const p of players.values()) { const g = Number(p.save && p.save.gold) || 0; if (p.save && g > rg) { rg = g; rich = p.name; } }   // 누릉이가 따라다니는 리치맨
  const sig = JSON.stringify([list, note, vBoat, paths, vdex, rich]);
  if (!force && sig === rosterSig) return; rosterSig = sig;
  broadcast({ t: 'roster', list, note, boat: vBoat, paths, vdex, rich });
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
db.roster().then(rows => { for (const r of rows || []) { if (r.boat && !vBoat) vBoat = { by: r.name }; if (!rosterCache.has(r.key)) rosterCache.set(r.key, { name: r.name, job: r.job && r.job.id || '', lv: vlOf(r.vl), sit: false, legs: legZones({ dex: r.dex }), sd: sdN({ sdex: r.sdex }), gt: gtN({ giant: r.giant }), dex: dexIds(r.dex), help: r.help ? r.help.n | 0 : 0, jr: jrOf({ job: r.job }, r.job && r.job.id) }); } console.log('현황판', rosterCache.size, '명'); }).catch(e => console.error('현황판을 읽지 못했어요', e.message));
db.ranks().then(rows => { for (const r of rows || []) rankSet(r.key, r.name, r.enh, cleanLook(r.look, { cos: { own: Array.isArray(r.own) ? r.own : [] }, enh: r.enh }, colorOf(r.key))); champBoot = true; console.log('강화 순위', rankCache.size, '명 · 동상', champ ? champ.name + ' +' + champ.lv : '없음'); }).catch(e => { champBoot = true; console.error('강화 순위를 읽지 못했어요', e.message); });

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
