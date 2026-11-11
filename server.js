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
const BUILD = (() => { try { return require('crypto').createHash('md5').update(require('fs').readFileSync(path.join(__dirname, 'index.html'))).digest('hex').slice(0, 10); } catch (e) { return String(Date.now()); } })();
app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); require('fs').readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => { if (err) { res.statusCode = 500; return res.end(); } res.end(html.replace('__BUILD__', BUILD)); }); });
for (const f of ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-mask.png', 'apple-touch-icon.png']) app.get('/' + f, (req, res) => { if (f === 'sw.js') res.setHeader('Service-Worker-Allowed', '/'); res.setHeader('Content-Type', f.endsWith('.webmanifest') ? 'application/manifest+json' : f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'image/png'); res.setHeader('Cache-Control', f === 'sw.js' ? 'no-cache' : 'public, max-age=86400'); require('fs').readFile(path.join(__dirname, f), (err, buf) => { if (err) { res.statusCode = 404; return res.end(); } res.end(buf); }); });   // 📲 홈 화면에 추가하면 앱처럼 (주소창 없이)
app.get('/version', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ v: BUILD })); });   // 🔄 새 버전 알림
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
const MYTH_FIRST = MK_FIRST + MK_RAR.length, MYTH_Z = [1, 2, 3, 4, 5, 6];   // 신화 6종 (247~252) · 낚시터마다 1종 · index.html MYTH_RAW와 같은 순서
const MYTH_PRICE = [300000, 500000, 800000, 1200000, 2000000, 3000000];
const isMyth = id => id >= MYTH_FIRST && id < MYTH_FIRST + MYTH_Z.length;
/* 배낚시 2탄 (2026-11-04): 24종 (253~276) + 보스 2종 (277 왕청새치 · 278 대왕오징어) — index.html PTY2_RAW · BOSS2_RAW와 같은 순서 */
const PTY2_FIRST = MYTH_FIRST + MYTH_Z.length, PTY2_RAR = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4];
const BOSS_IDS = [BOSS_ID, PTY2_FIRST + PTY2_RAR.length, PTY2_FIRST + PTY2_RAR.length + 1], BOSS_PRICE = [20000, 30000, 40000];
const BOSS_NAMES = ['거대 참다랑어', '왕청새치', '대왕오징어'];
const isBoss = id => BOSS_IDS.indexOf(id) >= 0;
const isPty2 = id => id >= PTY2_FIRST && id < PTY2_FIRST + PTY2_RAR.length;
/* 물고기 2배 (2026-11-05): 마을 1~5 각 40종 (279~478) · 안개 섬 새 낚시터 9 안개 연못 · 10 안개 계곡 · 11 산호초 해안 각 40종 (479~598) — index.html FISH2와 같은 순서 */
const VIL2_FIRST = PTY2_FIRST + PTY2_RAR.length + 2, ISX_FIRST = VIL2_FIRST + 200, RAR40 = i => i < 16 ? 0 : i < 28 ? 1 : i < 36 ? 2 : i < 38 ? 3 : 4;
const isV2 = id => id >= VIL2_FIRST && id < ISX_FIRST, isIsx = id => id >= ISX_FIRST && id < ISX_FIRST + 120;
const zone2 = id => isV2(id) ? 1 + Math.floor((id - VIL2_FIRST) / 40) : 9 + Math.floor((id - ISX_FIRST) / 40);
const rar2 = id => RAR40((id - (isV2(id) ? VIL2_FIRST : ISX_FIRST)) % 40);
/* 갯것 40종 (2026-11-09 · 599~638): 통발로만 · 손맛 도감에 들어가요 · 반짝은 없어요 — index.html GET_RAW와 같은 순서 [낚시터, 희귀도] */
const GET_FIRST = ISX_FIRST + 120;
const GET_ZR = [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3],[4,0],[4,1],[4,2],[4,4],[5,0],[5,1],[5,2],[5,4],[8,0],[8,1],[8,2],[8,3],[6,0],[6,1],[6,2],[6,4],[9,0],[9,1],[9,2],[9,3],[10,0],[10,1],[10,2],[10,3],[11,0],[11,1],[11,2],[11,4]];
const isGet = id => id >= GET_FIRST && id < GET_FIRST + GET_ZR.length;
/* 3차-2 물안개 숲 섬 100종 (639~738) [낚시터, 희귀도] — index.html FISH3와 같은 순서 */
const ISY_FIRST = GET_FIRST + GET_ZR.length, ISY_ZR = [[13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 0], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 1], [13, 2], [13, 2], [13, 2], [13, 2], [13, 2], [13, 2], [13, 3], [13, 3], [13, 4], [13, 4], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 0], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 1], [14, 2], [14, 2], [14, 2], [14, 2], [14, 2], [14, 2], [14, 3], [14, 3], [14, 4], [14, 4], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 0], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 1], [15, 2], [15, 2], [15, 2], [15, 2], [15, 2], [15, 2], [15, 3], [15, 3], [15, 4], [15, 4]];
/* 3차-3 달콤섬 · 소복섬 80종 (739~818) — index.html FISH4와 같은 순서 */
const ISY_ZR2 = [[16, 0], [16, 0], [16, 0], [16, 0], [16, 0], [16, 0], [16, 0], [16, 0], [16, 1], [16, 1], [16, 1], [16, 1], [16, 1], [16, 1], [16, 2], [16, 2], [16, 3], [16, 3], [16, 4], [16, 4], [17, 0], [17, 0], [17, 0], [17, 0], [17, 0], [17, 0], [17, 0], [17, 0], [17, 1], [17, 1], [17, 1], [17, 1], [17, 1], [17, 1], [17, 2], [17, 2], [17, 3], [17, 3], [17, 4], [17, 4], [18, 0], [18, 0], [18, 0], [18, 0], [18, 0], [18, 0], [18, 0], [18, 0], [18, 1], [18, 1], [18, 1], [18, 1], [18, 1], [18, 1], [18, 2], [18, 2], [18, 3], [18, 3], [18, 4], [18, 4], [19, 0], [19, 0], [19, 0], [19, 0], [19, 0], [19, 0], [19, 0], [19, 0], [19, 1], [19, 1], [19, 1], [19, 1], [19, 1], [19, 1], [19, 2], [19, 2], [19, 3], [19, 3], [19, 4], [19, 4]];
ISY_ZR.push(...ISY_ZR2);
/* 3차-5 축제 5세트 20종 · 제주 8종 · 깊은 물 6종 (819~852) — index.html FEST2 · JEJU_RAW · HID_RAW와 같은 순서 */
ISY_ZR.push(...[[5, 0], [5, 1], [5, 2], [5, 4], [1, 0], [1, 1], [1, 2], [1, 4], [16, 0], [16, 1], [16, 2], [16, 4], [2, 0], [2, 1], [2, 2], [2, 4], [3, 0], [3, 1], [3, 2], [4, 4], [20, 0], [20, 0], [20, 1], [20, 1], [20, 2], [20, 2], [20, 3], [20, 4], [21, 2], [21, 2], [21, 3], [21, 3], [21, 4], [21, 4]]);
const isIsy = id => id >= ISY_FIRST && id < ISY_FIRST + ISY_ZR.length;
const FISH_MAX = ISY_FIRST + ISY_ZR.length;
const ZONE_PRICE = [8, 30, 90, 280, 950, 2000, 400, 100, 1200, 1500, 2600, 400, 3000, 3400, 4200, 7000, 8000, 10000, 12000, 3000, 9000], RAR_MULT = [1, 2.2, 5, 20, 120];   // 2026-11-09: 영웅 · 전설 값 올림 (index.html RARITY와 같아요)
const rarOf = i => i < 8 ? 0 : i < 14 ? 1 : i < 18 ? 2 : i < 19 ? 3 : 4;
function fishPrice(id) {
  let z, r;
  if (id < 100) { z = Math.floor(id / 20); r = rarOf(id % 20); }
  else if (id < FISH_N) { z = Math.floor((id - 100) / 20); r = rarOf((id - 100) % 20); }
  else if (isGet(id)) { z = GET_ZR[id - GET_FIRST][0] - 1; r = GET_ZR[id - GET_FIRST][1]; }
  else if (isIsy(id)) { z = ISY_ZR[id - ISY_FIRST][0] - 1; r = ISY_ZR[id - ISY_FIRST][1]; }
  else if (isBoss(id)) return BOSS_PRICE[BOSS_IDS.indexOf(id)];
  else if (isV2(id) || isIsx(id)) { z = zone2(id) - 1; r = rar2(id); }
  else if (isPty2(id)) { z = 6; r = PTY2_RAR[id - PTY2_FIRST]; }
  else if (isMyth(id)) return MYTH_PRICE[id - MYTH_FIRST];   // 신화는 상점에서 '와!' 소리가 나게 (index.html MYTH_PRICE와 같아요)
  else if (id >= MK_FIRST) { z = 7; r = MK_RAR[id - MK_FIRST]; }
  else if (id >= PTY_FIRST) { z = 6; r = PTY_RAR[id - PTY_FIRST]; }
  else if (id >= ISLE_FIRST) { z = 5; r = rarOf(id - ISLE_FIRST); }
  else { const s = SEASON_FISH[id - FISH_N]; if (!s) return 0; r = s[0]; z = s[1] - 1; }
  return Math.max(1, Math.round(ZONE_PRICE[z] * RAR_MULT[r]));
}
const validFish = id => Number.isInteger(id) && id >= 0 && id < FISH_MAX;
const invOf = s => (s && s.inv) || {};
const ITEM_IDS = ['flesh', 'scale', 'note', 'shell', 'weed', 'pearl', 'feather', 'thread', 'sail', 'toy', 'map', 'b_dough', 'b_shine', 'b_legend_n', 'b_legend', 'shard', 'soup', 'grill', 'snack', 'charm', 'knack'];   // index.html ITEMS와 같아야 해요
/* 2026-11-05 재료 정리: 직업 재료 다섯 가지는 「✨ 솜씨 재료」 하나로, 방수 판자 → 판자, 꽃 염료 → 꽃잎 돛천, 라벤더꿀 → 들꽃꿀 (index.html MERGE와 같아요) */
const MERGE = { scale: 'knack', pearl: 'knack', feather: 'knack', note: 'knack', thread: 'knack', wplank: 'plank', dye: 'cloth', honey_lav: 'honey' };
const mk = k => MERGE[k] || k;
const mkKey = k => typeof k === 'string' && k.startsWith('i:') ? 'i:' + mk(k.slice(2)) : k;
function foldItems(s) { const it = s && s.items; if (!it || typeof it !== 'object') return; for (const k in MERGE) if (it[k]) { it[MERGE[k]] = (it[MERGE[k]] | 0) + (it[k] | 0); delete it[k]; } }
const itemsOf = s => (s && s.items && typeof s.items === 'object') ? s.items : {};
/* 교환 열쇠: 물고기 번호 · 'i:아이템' · 'g'(골드) */
const keyKind = k => k === 'g' ? 'g' : (typeof k === 'string' && k.startsWith('i:') && ITEM_IDS.includes(k.slice(2))) ? 'i' : validFish(+k) && String(+k) === String(k) ? 'f' : null;
function hasKey(s, k, n) { k = mkKey(k); const t = keyKind(k); if (t === 'g') return (Number(s && s.gold) || 0) >= n; if (t === 'i') return (itemsOf(s)[k.slice(2)] | 0) >= n; if (t === 'f') return has(s, +k, n); return false; }
const has = (s, id, n) => (invOf(s)[id] | 0) >= n;
/* 직업 노드 단계 (index.html의 rk와 같아요) */
const JOB_LOCK_MS = 0;   // 직업 3.0: 바꿔도 마지막 스킬이 꺼지지 않아요
const jobLocked = s => { const j = s && s.job; return !!(j && j.ch && Date.now() - j.ch < JOB_LOCK_MS); };
const jobRank = (s, job, node) => { const j = s && s.job; if (!j || j.id !== job || !j.pts || !j.pts[job]) return 0; if (node === 'cap' && jobLocked(s)) return 0; return j.pts[job][node] | 0; };
const VL_CUM = [0, 0]; for (let L = 1; L < 30; L++) VL_CUM[L + 1] = VL_CUM[L] + Math.round(40 * Math.pow(L, 1.5));
const vlOf = v => { const xp = v && Number.isFinite(v.xp) ? v.xp : 0; let L = 1; while (L < 30 && xp >= VL_CUM[L + 1]) L++; return L; };
const cleanText = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// 친구에게 보여 줄 외형: 목록에 있고, 무료이거나 가진 것만
const LOOK_IDS = {
  hat: ['straw', 'nohat', 'cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'crown', 'lily', 'fishhat', 'shell', 'captain', 'moonband', 'maple', 'snowcap', 'lotus', 'leaf', 'whalehat', 'jelly', 'mooncrown', 'pirate', 'tiara', 'bearhood', 'bunnyhood', 'cathood', 'pandahood', 'penguinhood', 'foxhood', 'dinohood', 'pumpkin', 'witchhat', 'ghosthead', 'mummyhead', 'wolfhood', 'clownwig', 'devilhorns', 'nightcap', 'chefhat', 'knighthelm', 'halo', 'bunnyears', 'ebcrown', 'laurel', 'aurora'],
  o: ['tee', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star', 'suit', 'vest', 'sailor', 'wave', 'pondrobe', 'streamsuit', 'sunset', 'deepsea', 'starcloak', 'lifejacket', 'fogcoat', 'masterjacket', 'pd_pink', 'pd_sky', 'pd_lav', 'pd_rose', 'pd_snow', 'pd_sea', 'pd_gold', 'bearsuit', 'bunnysuit', 'catsuit', 'pandasuit', 'penguinsuit', 'foxsuit', 'dinosuit', 'witchrobe', 'dracula', 'ghostsheet', 'mummysuit', 'skeleton', 'wolfsuit', 'clownsuit', 'xtee_r', 'xtee_n', 'xtee_m', 'xtee_y', 'xtee_k', 'xtee_w', 'mtee', 'school', 'pajama', 'chef', 'hanbok_p', 'hanbok_b', 'knight', 'idol', 'ebsuit', 'stardress', 'legendcoat', 'mastercape'],
  fa: ['', 'fangs', 'skullpaint', 'zombie', 'rednose', 'glasses', 'sunglasses', 'heartglasses', 'mask', 'eyepatch', 'mustache', 'blush', 'starsticker', 'whiskers', 'tearpoint'],
  bk: ['', 'dracape', 'devilwings', 'xcape_n', 'xcape_r', 'xcape_k', 'angelwings', 'fairywings', 'butterfly', 'bearbag', 'ebwings', 'flagback', 'kingcape', 'rainbowwings'],
  tf: ['', 'tf_silver', 'tf_gold', 'tf_rainbow'],
  ft: ['', 'ft_petal', 'ft_star', 'ft_drop'],
  rod: ['bamboo', 'mintrod', 'sakura', 'rainbowrod', 'goldrod', 'lotusrod', 'coral', 'galaxy', 's_rod1', 's_rod2', 's_rod3', 's_rod4', 's_rod5'],
  bob: ['basicbob', 'heartbob', 'mushbob', 'catbob', 'goldbob', 'duck', 'leafbob', 'starfish', 'starbob', 'sb_pearl', 'sb_prism', 'sb_rainbow', 'sb_star'],
  ti: ['', 't_new', 't_villager', 't_nap', 't_cat', 't_big', 't_luck', 't_rich', 't_pond', 't_stream', 't_beach', 't_sea', 't_moon', 't_master', 't_enh10', 't_enh15', 't_enh20', 't_pet_ruby', 't_pet_dot', 't_pet_nurung', 't_pet_kkam', 't_pet_churi', 't_s1', 't_s2', 't_s3', 't_s4', 't_s5', 't_s6', 't_smaster', 't_ebvip', 't_jackpot', 't_cup', 't_bounty', 't_host', 't_a_pearl', 't_a_moon', 't_a_tea', 't_a_star', 't_a_cloud', 't_a_sea', 't_fest', 't_medal', 't_regular', 't_vf1', 't_vf2',
    't_sh1', 't_sh10', 't_sh30', 't_myth',
    ...['fish', 'sch', 'cra', 'tam', 'mer'].flatMap(j => [1, 2, 3].map(r => 't_j' + j + r))]
};
/* 치장 3.0 (2026-11-05): 명품 찌 · 낚싯대 · 세트 · 섬 전용 — index.html COS와 같은 id */
LOOK_IDS.bob.push(["b_cherry", "b_icecream", "b_strawberry", "b_donut", "b_clover", "b_frog", "b_penguin", "b_bunny", "b_sushi", "b_moon", "b_bell", "b_lantern", "b_rubber", "b_crystal", "b_jelly", "b_cloud", "b_ghost", "b_heart2", "b_music", "b_planet", "b_lotus", "b_snowglobe", "b_whale", "b_phoenix", "b_gem", "b_clock", "b_dragon", "b_angel", "b_sun", "b_galaxy", "b_crown", "b_rainbowp", "b_hourglass", "b_starheart", "b_acorn", "b_maple2", "b_pepero", "b_snowman", "b_gift", "b_lucky", "i_fogbob", "i_clambob", "i_lanternfish", "i_dragonbob"]);
LOOK_IDS.rod.push(["r_bone", "r_neon", "r_heart", "r_wand", "r_sakura2", "r_ice", "r_trident", "r_thunder", "r_saber", "r_aurora", "r_dragon", "r_gold2", "r_cosmos", "r_maple", "r_candy", "i_rodcoral", "i_rodfog"]);
LOOK_IDS.hat.push(["h_wizard", "h_coral", "h_dragon", "h_angel", "h_dark", "h_tricorn", "h_royal", "h_snap", "h_headset", "h_maid", "h_tophat", "h_sheep", "h_starpin", "h_beret", "h_santa", "h_rudolph", "i_keepcap", "i_seahelm"]);
LOOK_IDS.o.push(["o_wizard", "o_mermaid", "o_dragon", "o_angel", "o_dark", "o_navy", "o_royal", "o_zip", "o_varsity", "o_leather", "o_maid", "o_butler", "o_trench", "o_santa", "o_snow", "i_keeper", "i_seadragon"]);
LOOK_IDS.bk.push(["k_wizard", "k_shell", "k_dragon", "k_seraph", "k_dark", "k_navy", "k_royal", "k_guitar", "k_neon", "k_fishbag", "k_moon", "k_maple", "k_snow", "i_lantern", "i_seawing"]);
LOOK_IDS.fa.push(["f_monocle", "f_heart", "f_bandaid", "f_goggle", "f_freckle"]);
const ENH_TITLE_NEED = { t_enh10: 10, t_enh15: 15, t_enh20: 20, t_enh25: 25, t_enh30: 30 };
LOOK_IDS.rod.push('r_music', 'r_cat', 'r_choco', 'r_jelly', 'r_snowflake', 'r_whale', 'r_phoenix', 'r_starlight');
LOOK_IDS.o.push('o_tux', 'o_wdress', 'o_warrior', 'o_hero', 'o_paladin', 'o_skyexp'); LOOK_IDS.hat.push('h_warhorn', 'h_herocirc', 'h_paladin', 'h_skygog'); LOOK_IDS.bk.push('k_warfur', 'k_hero', 'k_paladin', 'k_scout', 'k_gsword', 'k_shield'); LOOK_IDS.fa.push('f_warpaint', 'f_scar'); LOOK_IDS.ti.push('t_warrior', 't_hero', 't_paladin');
LOOK_IDS.o.push('o_moondress', 'o_sakura', 'o_darkarmor', 'o_hunter'); LOOK_IDS.hat.push('h_moonpin', 'h_sakura', 'h_darkhelm', 'h_hunterhood'); LOOK_IDS.bk.push('k_moonwing', 'k_bigribbon', 'k_darkcape', 'k_axe', 'k_quiver'); LOOK_IDS.fa.push('f_glitter', 'f_blush'); LOOK_IDS.ti.push('t_raid1'); LOOK_IDS.ti.push('t_moonfairy', 't_sakura', 't_darkknight', 't_hunter'); LOOK_IDS.hat.push('h_veil', 'h_fcrown'); LOOK_IDS.ti.push('t_wed', 't_wfchamp');
LOOK_IDS.ti.push('t_enh25', 't_enh30', ...['fish', 'sch', 'cra', 'tam', 'mer'].flatMap(j => [4, 5, 6].map(r => 't_j' + j + r)));
for (const j of ['fish', 'sch', 'cra', 'tam', 'mer']) { LOOK_IDS.rod.push('jr4_' + j, 'jr6_' + j); LOOK_IDS.bob.push('jb5_' + j); }   // 강화 칭호는 서버 기록으로 확인
const FREE = new Set(['straw', 'nohat', 'tee', 'bamboo', 'basicbob', '']);
const HAIR_N = 22, HAIR_FREE = 8, HS_N = 16;   // index.html HAIRS · HSTYLES와 같아야 해요
let LOOK_FLAT = 0; function lookFlat() { if (LOOK_FLAT) return; LOOK_FLAT = 1; for (const k in LOOK_IDS) LOOK_IDS[k] = LOOK_IDS[k].flat(); }   // 예전에 배열째 넣은 id들을 펼쳐요
function cleanLook(l, save, color) {
  lookFlat();
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
  { const cup = (save && save.cup) || {}; o.gs = Math.max(cup[o.o] | 0, cup[o.hat] | 0, cup[o.bk] | 0, cup[o.fa] | 0); }   // 치장 별 (입은 것 중 가장 높은 별)
  o.j = typeof l.j === 'string' && /^(fish|sch|cra|tam|mer)[0-3]$/.test(l.j) ? l.j : '';
  o.cp = typeof l.cp === 'string' && l.cp.length <= 40 && /^(cat|dog)[0-3]\|[^|<>]{1,8}\|\d{1,2}\|[a-z_]{0,12}$/.test(l.cp) ? l.cp : '';   // 🐾 반려동물 (종류·털색|이름|레벨|장식)   // 직업 배지 (아이콘 + 등급 별)
  return o;
}

/* 가방 검증: 받은 저장을 서버가 가진 기록과 비교해요
   1) rev가 서버보다 옛것 → 무시 (교환 전 가방으로 되돌려 물고기를 복사하는 것을 막음)
   2) 물고기는 '잡은 만큼'만 늘 수 있음 (늘어난 마릿수 ≤ 도감 마릿수가 늘어난 만큼)
   3) 도감 마릿수는 줄지 않고, 실제 낚시가 가능한 빠르기까지만 늘어남
   4) 골드는 판(줄어든) 물고기 값만큼만 늘어남 */
/* 낚시터 문: 연 사람만 들어가요. 새로 연 문은 그 값만큼 골드가 줄어야 해요 (index.html ZONES의 gate와 같아야 해요) */
const GATE_PRICE = { 2: 3000, 3: 15000, 4: 60000, 5: 200000 };
const GATE_SD = {};   // 앞 낚시터 손맛 조건 (예: { 2: 12 }). 지금은 골드만 내면 열려요 · index.html GATE_SD와 같아야 해요
/* 이번 저장까지 '직접 낚은' 종 수: 서버가 이미 아는 손맛 + 이번에 도감이 늘어난 종만 (checkSdex와 같은 기준) */
function sdCountZone(old, neu, z) { const os = (old && old.sdex) || {}, ns = (neu && neu.sdex) || {}, od = (old && old.dex) || {}, nd = (neu && neu.dex) || {}; let n = 0;
  for (const id of zoneFishIds(z)) { const was = (os[id] | 0) > 0, now = (ns[id] | 0) > 0 && ((nd[id] ? nd[id].n | 0 : 0) > (od[id] ? od[id].n | 0 : 0)); if (was || now) n++; } return n; }   // 6번 안개 섬은 문 대신 물결호 (마을에 배가 있어야 해요)
function zonesOf(s) { return Array.isArray(s && s.zones) ? s.zones : [1]; }
/* 안개 조각 · 섬 장비: 조각은 서버만 늘려요 (shardRoll · 선물 · 운영자). 등불 · 섬 장비는 줄어든 조각만큼만 오를 수 있어요
   index.html의 IG_UP.shard · LAMP.it(shard)와 같아야 해요 */
const IG_SH = [2, 5, 10, 16], LAMP_SH = [1, 3, 6, 10, 16], IG_KEYS = ['rod', 'bob', 'lure', 'reel'];
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
  let gateCost = 0; for (const z of nz) if (oz.indexOf(z) < 0) { gateCost += GATE_PRICE[z] || 0; if (GATE_SD[z] && sdCountZone(old, neu, z - 1) < GATE_SD[z]) return '앞 낚시터에서 직접 낚은 물고기가 모자라요'; }
  if (nz.indexOf(6) >= 0 && oz.indexOf(6) < 0 && !vBoat) return '물결호가 없는데 섬에 갔어요';
  const g0 = Number(old.gold) || 0, g1 = neu.gold;
  if (!Number.isFinite(g1) || g1 < 0) return '골드가 이상해요';
  // 판매가 보너스(도감 · 단골 2배 · 상인 · 요리 · 정복 · 시세)를 다 겹쳐도 넘지 않게 넉넉히 4배
  // (예전엔 return이 주석 안에 들어가 있어서 이 검사가 꺼져 있었어요)
  if (g1 - g0 + gateCost > soldValue * 8 * enhSell(old.enh && old.enh.lv) + 50) return gateCost ? '문 값을 내지 않고 낚시터가 열렸어요' : '판 것보다 골드가 많이 늘었어요';
  const nav = navCost(old.nav, neu.nav); if (nav < 0) return '섬 장비 기록이 이상해요';
  const sh0 = itemsOf(old).shard | 0, sh1 = itemsOf(neu).shard | 0;
  if (sh1 > sh0 - nav) return nav ? '안개 조각이 모자란데 섬 장비가 올랐어요' : '안개 조각이 저절로 늘었어요';
  return null;
}
/* ---------- 낚싯대 강화 룰렛 (게임의 ENH와 똑같은 규칙 — 결과는 서버가 정해요) ---------- */
const ENH = {
  MAX: 30,   // 강화 4.0 (2026-11-05)
  // 강화 2.0 (2026-11-04): 확률은 높게, 대신 단계마다 별을 여러 개 모아야 올라가요. 안전은 실패해도 별을 안 잃고 K번 연속 실패하면 다음은 확정.
  // 도전은 골드 없이 성공 시 별 3개(대성공 6개), +5부터 실패하면 별 1개를 잃어요. index.html ENH와 같아야 해요
  P: [.95, .90, .85, .80, .75, .70, .65, .60, .55, .50, .46, .43, .40, .37, .34, .31, .29, .27, .25, .23, .21, .20, .19, .18, .17, .16, .15, .14, .13, .12],
  S: [1, 1, 2, 3, 4, 6, 9, 13, 18, 24, 16, 20, 25, 31, 38, 61, 72, 84, 98, 114, 130, 150, 170, 190, 215, 240, 270, 300, 340, 380],   // 강화 3.0 (2026-11-04): +11부터 별을 줄였어요
  cost: L => (L >= 17 ? Math.round(Math.min(30, 7 * Math.pow(1.5, L - 17)) * ENH.cost0(L) / 1000) * 1000 : ENH.cost0(L)),   // 2026-11-09: +17부터 안전 강화 골드를 크게 (7배 → 최대 30배)
  cost0: L => L < 10 ? Math.round(50 * Math.pow(1.28, L) / 10) * 10 : L < 20 ? Math.round(3000 * Math.pow(1.32, L - 10) / 100) * 100 : Math.round(3000 * Math.pow(1.32, L - 10) * Math.pow(1.4, L - 19) / 1000) * 1000,   // +10부터는 골드를 꽤 써요
  DAILY: 3, FISH_CAP: 40, FISH_PER: 25, IDLE_MIN: 40, IDLE_CAP: 30,   /* 2026-11-09: 오래 켜 두면 하루 최대 30장 */ PIECE_CAP: 20, PIECE_PER: 5, TK_MAX: 999,
  PTS: [1, 2, 5, 15, 40]
};
ENH.K = ENH.P.map(p => Math.max(2, Math.round(1.8 / p)));   // 안전: 이만큼 연속 실패하면 다음은 확정
const fishRar = id => isIsy(id) ? ISY_ZR[id - ISY_FIRST][1] : isGet(id) ? GET_ZR[id - GET_FIRST][1] : isV2(id) || isIsx(id) ? rar2(id) : isBoss(id) ? 4 : isPty2(id) ? PTY2_RAR[id - PTY2_FIRST] : id < 100 ? rarOf(id % 20) : id < FISH_N ? rarOf((id - 100) % 20) : id === BOSS_ID || isMyth(id) ? 4 : id >= MK_FIRST ? MK_RAR[id - MK_FIRST] | 0 : id >= PTY_FIRST ? PTY_RAR[id - PTY_FIRST] | 0 : id >= ISLE_FIRST ? rarOf(id - ISLE_FIRST) : (SEASON_FISH[id - FISH_N] || [0])[0];
/* 전설을 잡은 낚시터 (길잡이 보너스) */
function legZones(save) { const d = (save && save.dex) || {}, out = []; for (const k in d) { const id = +k; if (!(d[k] && d[k].n > 0) || fishRar(id) !== 4) continue; const z = id < FISH_N ? (id < 100 ? Math.floor(id / 20) : Math.floor((id - 100) / 20)) + 1 : id >= ISLE_FIRST && id < PTY_FIRST ? 6 : 0; if (z && out.indexOf(z) < 0) out.push(z); } return out; }
const enhDefault = () => ({ lv: 0, max: 0, tk: 0, star: 0, fl: 0, sure: 0, day: '', fp: 0, ft: 0, it: 0, idle: 0, pc: 0, pcd: 0, lit: 0, st: 0 });
const streakBonus = st => st >= 7 ? 3 : st >= 3 ? 1 : 0;   // 연속 출석: 3일째부터 +1, 7일째부터 +3
const CATCH_GAP = 5, CATCH_TK = 3;   // 따라잡기: 광장 동상 주인보다 5단계 이상 낮으면 출석 강화권 +2
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function enhOf(save) { if (!save) return null; save.enh = Object.assign(enhDefault(), save.enh && typeof save.enh === 'object' ? save.enh : {}); return save.enh; }
function enhDaily(e, out) {
  const d = kstDay(); if (e.day === d) return;
  const y = new Date(Date.now() + 9 * 3600e3 - 864e5).toISOString().slice(0, 10);
  e.st = e.day === y ? Math.min(999, (e.st | 0) + 1) : 1;
  e.day = d; e.ft = 0; e.it = 0; e.idle = 0; e.pcd = 0;
  const gap = champ ? (champ.lv | 0) - (e.lv | 0) : 0, cu = gap >= 10 ? 6 : gap >= CATCH_GAP ? CATCH_TK : 0;   // 따라잡기: 5단계 뒤 +3 · 10단계 뒤 +6
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
/* 강화 3.0: 판매가 단계마다 +25% (index.html enhSell과 같아요) · 안전 강화 골드는 가 본 가장 먼 낚시터가 가까울수록 싸게 */
const enhSell = lv => 1 + .25 * (lv | 0);
const zoneDisc = s => { const z = Math.max(1, ...zonesOf(s).filter(x => x <= 5)); return { 1: .2, 2: .35, 3: .5, 4: .7 }[z] || 1; };
/* 다시 왔어요: 마지막 접속에서 3시간 넘게 지나 다시 오면 강화권 +2 (하루 3번) */
function enhSession(e, out) { const now = Date.now(), d = kstDay(); if (!e.ses || e.ses.d !== d) e.ses = { d, n: 0 };
  if (e.lg && now - e.lg >= 3 * 3600e3 && e.ses.n < 3) { e.ses.n++; e.tk = Math.min(ENH.TK_MAX, e.tk + 2); out.push('다시 왔어요! 강화권 +2 (오늘 ' + e.ses.n + '/3)'); } e.lg = now; }
function enhRoll(e, mode, gold, disc) {
  const L = e.lv; if (L >= ENH.MAX) return { err: '이미 최고 단계예요' };
  if (e.tk < 1) return { err: '강화권이 없어요' };
  const cost = mode === 'safe' ? Math.round(ENH.cost(L) * (1 - (disc || 0))) : 0; if ((Number(gold) || 0) < cost) return { err: '골드가 모자라요' };
  e.tk--; e.star = e.star | 0; e.fl = e.fl | 0;
  const ticket = (e.sure | 0) > 0; if (ticket) e.sure--;   // 도토리 확정권
  const cat = (e.cat | 0) > 0 ? .15 + .1 * (e.catk | 0) : 0; if (cat) e.cat--;   // 공방 장인 강화 촉매
  const sure = ticket || (mode === 'safe' && e.fl >= ENH.K[L]), ok = sure || Math.random() < ENH.P[L] + cat;
  let k, ds = 0;
  if (ticket) { ds = Math.max(1, ENH.S[L] - (e.star | 0)); k = 'sure'; e.fl = 0; }   // 도토리 확정권: 별을 다 채워서 바로 다음 단계
  else if (ok) { ds = mode === 'safe' ? 1 : (Math.random() < .1 ? 6 : 3); k = ds >= 6 ? 'jack' : 'up'; e.fl = 0; }
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
const placeOf = id => isIsy(id) ? ISY_ZR[id - ISY_FIRST][0] : isGet(id) ? GET_ZR[id - GET_FIRST][0] : isV2(id) || isIsx(id) ? zone2(id) : isBoss(id) || isPty2(id) ? 7 : isMyth(id) ? MYTH_Z[id - MYTH_FIRST] : id < FISH_N ? fishZone(id) : id < ISLE_FIRST ? (SEASON_FISH[id - FISH_N] || [0, 0])[1] : id < PTY_FIRST ? 6 : id < MK_FIRST ? 7 : 8;
/* 교환 규칙 (2026-11-04): 자유롭게. 물고기 · 아이템 · 골드를 섞어도, 한쪽만 줘도(선물) 돼요.
   안개 조각만 못 주고받아요 (섬은 모두 같이 시작). 손맛 도감 · 낚시터 문은 직접 낚아야만 올라서 주고받아도 대신 해 줄 수 없어요 */
function tradeRule(a, b) {
  const all = [a || {}, b || {}];
  if (all.some(o => (o['i:shard'] | 0) > 0)) return '안개 조각은 주고받을 수 없어요';
  if (!all.some(o => Object.keys(o).some(k => o[k] > 0))) return '올린 것이 없어요';
  return null;
}
const ITEM_NPC = { knack: 3000, flesh: 80, scale: 2500, note: 3000, shell: 300, weed: 300, pearl: 4000, feather: 3000, thread: 6000, sail: 30000, toy: 4000, map: 40000, b_dough: 150, b_shine: 1500, b_legend_n: 150000, b_legend: 150000, soup: 900, grill: 900, snack: 600, charm: 5000, b_shine_p: 6000, charm_p: 15000, b_legend_p: 400000 };   // index.html ITEMS의 npc와 같아야 해요
const postOk = p => !!(p.give || p.want);
/* ---------- 직업 2.0: 의뢰판 · 이름 붙은 생산물 · 오늘의 일 · 명장 축복 ---------- */
const MAKER = { knack: 'any', b_shine_p: 'cra', charm_p: 'cra', b_legend_p: 'cra', flesh: 'cra', b_dough: 'cra', soup: 'cra', grill: 'cra', b_shine: 'cra', snack: 'cra', charm: 'cra', b_legend: 'cra', note: 'sch', map: 'sch', shell: 'tam', weed: 'tam', pearl: 'tam', feather: 'tam', scale: 'fish', thread: 'mer', sail: 'mer', toy: 'mer' };   // index.html MAKER와 같아야 해요
const ITEM_NAME = { knack: '솜씨 재료', b_shine_p: '명품 반짝 미끼', charm_p: '명품 행운 부적', b_legend_p: '명품 전설 미끼', flesh: '생선살', b_dough: '반죽 미끼', soup: '생선 수프', grill: '소금구이', b_shine: '반짝 미끼', snack: '펫 간식', charm: '행운 부적', b_legend: '전설 미끼', note: '연구 노트', map: '항로 지도', shell: '조개껍데기', weed: '해초', pearl: '진주', feather: '반짝 깃털', scale: '대물 비늘', thread: '반짝 실', sail: '수입 돛', toy: '펫 장난감' };
const JOB_NAME = { fish: '물결 낚시꾼', sch: '도감 박사', cra: '공방 장인', tam: '동물 친구', mer: '떠돌이 상인' };
const jobOf = s => (s && s.job && MAKER_JOBS.includes(s.job.id)) ? s.job.id : '';
const MAKER_JOBS = ['fish', 'sch', 'cra', 'tam', 'mer'];
const REQ_DAYS = 3, REQ_MAX = 3, JR_MASTER = 4000;
const reqsOf = s => Array.isArray(s.req) ? s.req : (s.req = []);
/* 마을(NPC) 의뢰: 날짜로 정해져요. 직업마다 2개, 사람마다 하루 한 번씩 해결 */
const NPC_POOL = { cra: [['b_dough', 3], ['soup', 2], ['grill', 2], ['b_shine', 2], ['snack', 2]], sch: [['knack', 2], ['map', 1]], tam: [['shell', 3], ['weed', 3], ['knack', 2]], mer: [['knack', 2], ['toy', 1]], fish: [['knack', 2], ['f', 2]] };
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
const hasReqItem = (s, item, n) => item.startsWith('f:') ? has(s, +item.slice(2), n) : (itemsOf(s)[mk(item)] | 0) >= n;
/* 직업 4.0 (2026-11-05): 조사 쪽지 · 장인 명품 상자 — index.html ITEMS와 같아요 */
const MP_IDS = ["mp_b_dragon", "mp_b_angel", "mp_b_sun", "mp_b_galaxy", "mp_b_crown", "mp_b_rainbowp", "mp_b_hourglass", "mp_b_starheart", "mp_r_aurora", "mp_r_dragon", "mp_r_gold2", "mp_r_cosmos"];
ITEM_IDS.push('clue', ...MP_IDS); ITEM_IDS.push('snow', 'flake');
ITEM_IDS.push('log', 'plank', 'wplank', 'dye', 'cloth', 'honey', 'honey_lav', 'honey_rb', 'wildhoney', 'pie', 'apple', 'peach', 'orange', 'cherry', 'fl_tulip', 'fl_sun', 'fl_cosmos', 'fl_lav', 'fl_rose', 'fl_hydr', 'fl_lily', 'fl_rb', 'sap_oak', 'sap_pine', 'sap_apple', 'sap_peach', 'sap_orange', 'sap_cherry');   // 자연 1.0 (index.html ITEMS와 같아요)
LOOK_IDS.bob.push('b_bfly'); LOOK_IDS.ti.push('t_bug1', 't_bug2', 't_ark'); LOOK_IDS.ti.push('t_ruby30', 't_litter30', 't_hunt1', 't_hunt2', 't_fs1', 't_fs2', 't_fs3', 't_fs4', 't_fs5', 't_npc1', 't_npc2', 't_npc3');
Object.assign(ITEM_NPC, { snow: 100, flake: 30000, clue: 20000, fl_tulip: 140000, fl_cosmos: 180000, fl_sun: 270000, fl_lav: 450000, fl_rose: 900000, fl_hydr: 1350000, fl_lily: 2200000, fl_rb: 6000000,   /* 2026-11-09: 꽃이 돈이 되게 */ apple: 3000, peach: 4000, orange: 3500, cherry: 8000, honey: 800, wildhoney: 6000, log: 300, plank: 400, wplank: 2500, sap_oak: 1000000, sap_pine: 1000000, sap_apple: 2500000, sap_peach: 4000000, sap_orange: 4000000, sap_cherry: 7500000 }, {"mp_b_dragon": 12500000, "mp_b_angel": 14000000, "mp_b_sun": 15000000, "mp_b_galaxy": 17500000, "mp_b_crown": 20000000, "mp_b_rainbowp": 22500000, "mp_b_hourglass": 50000000, "mp_b_starheart": 75000000, "mp_r_aurora": 12500000, "mp_r_dragon": 15000000, "mp_r_gold2": 25000000, "mp_r_cosmos": 60000000});
Object.assign(MAKER, { clue: 'sch' }, {"mp_b_dragon": "cra", "mp_b_angel": "cra", "mp_b_sun": "cra", "mp_b_galaxy": "cra", "mp_b_crown": "cra", "mp_b_rainbowp": "cra", "mp_b_hourglass": "cra", "mp_b_starheart": "cra", "mp_r_aurora": "cra", "mp_r_dragon": "cra", "mp_r_gold2": "cra", "mp_r_cosmos": "cra"});
Object.assign(ITEM_NAME, { clue: '조사 쪽지' }, {"mp_b_dragon": "용의 알 찌 상자", "mp_b_angel": "천사 찌 상자", "mp_b_sun": "태양 찌 상자", "mp_b_galaxy": "은하수 찌 상자", "mp_b_crown": "왕관 찌 상자", "mp_b_rainbowp": "무지개 진주 찌 상자", "mp_b_hourglass": "시간의 모래시계 찌 상자", "mp_b_starheart": "별의 심장 찌 상자", "mp_r_aurora": "오로라 낚싯대 상자", "mp_r_dragon": "용염 낚싯대 상자", "mp_r_gold2": "순금 용왕 낚싯대 상자", "mp_r_cosmos": "우주의 낚싯대 상자"});
LOOK_IDS.bob.push('jb_fish1','jb_fish3','jb_sch1','jb_sch3','jb_cra1','jb_cra3','jb_tam1','jb_tam3','jb_mer1','jb_mer3','b_trust'); LOOK_IDS.rod.push('jr_fish','jr_sch','jr_cra','jr_tam','jr_mer'); LOOK_IDS.bk.push('k_trust'); LOOK_IDS.ti.push('t_trust1','t_trust2');
const TRUST_SHOP = { t_trust1: 10, t_trust2: 30, b_trust: 40, k_trust: 80 };   // index.html TRUST_SHOP과 같아요
const reqDelta = (item, n) => item.startsWith('f:') ? { [+item.slice(2)]: n } : { ['i:' + mk(item)]: n };
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
  return { t: 'rq_list', list: list.sort((a, b) => b.at - a.at), npc: npcReqs(), ndone: nr, trust: (me.save && me.save.med && me.save.med.n) | 0 };
}
async function findReq(id) { for (const key of rosterCache.keys()) { const sv = await loadSave(key); if (sv && Array.isArray(sv.req) && sv.req.some(q => q.id === id)) return key; } return null; }
/* 손맛 도감: 내가 직접 낚은 물고기만 (교환 · 선물로 받은 건 안 올라가요). 저장에서 늘어난 도감 마릿수만큼만 늘 수 있어요 */
const SZRW_TK = [15, 20, 25, 30, 40, 30];   // 강화 3.0 기준 (예전 3~8)   // index.html SZRW와 같아야 해요
const SZ_COS = { 1: ['t_s1', 's_rod1'], 2: ['t_s2', 's_rod2'], 3: ['t_s3', 's_rod3'], 4: ['t_s4', 's_rod4'], 5: ['t_s5', 's_rod5'], 6: ['t_s6', 'fogcoat'] };
const SZ_ALL = ['t_smaster', 'masterjacket'], SZ_ALL_TK = 50;
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
const GIFT_PLACES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11];   // 배낚시(7)는 귀항 보상이 따로 있어요
const GIFT_COS = ['cap', 'bucket', 'beanie', 'ribbon', 'flower', 'catear', 'frog', 'stripe', 'apron', 'overall', 'raincoat', 'hoodie', 'star'];
function giftOf(s) { const d = kstDay(); let g = s.gift; if (!g || typeof g !== 'object' || g.d !== d || !Array.isArray(g.z)) g = s.gift = { d, z: [] }; return g; }
const GIFT_DAY = 0;   // 2026-11-05: 선물은 「오늘의 마을 일」 보상으로 옮겼어요 · 예전 값 3   // 하루 선물은 아무 낚시터에서나 3번 (7곳을 매일 도는 숙제가 되지 않게) · index.html GIFT_DAY와 같아요
function giftRoll(s, e, delta, cos, out, z) {
  const r = Math.random();
  if (r < .04) {   // 옷 (다 가졌으면 강화권)
    const own = (s.cos && s.cos.own) || [], pool = GIFT_COS.filter(id => !own.includes(id));
    if (pool.length) { const id = pool[(Math.random() * pool.length) | 0]; cos.push(id); out.push('새 옷!'); return; }
  }
  if (r < .12) { e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('강화권 +1'); return; }
  if (r < .45) { e.pc += 2; out.push('반짝 조각 +2'); while (e.pc >= ENH.PIECE_PER) { e.pc -= ENH.PIECE_PER; e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.push('조각으로 강화권 +1'); } return; }
  const m = z === 6 ? ['shard', 2] : Math.random() < .06 ? ['knack', 2] : [['flesh', 4], ['shell', 2], ['weed', 2]][(Math.random() * 3) | 0];
  delta['i:' + m[0]] = (delta['i:' + m[0]] | 0) + m[1];   // 재료 이름은 화면이 delta로 보여 줘요
}
/* 안개 조각: 섬 물고기를 직접 낚으면 (손맛 도감이 늘어난 만큼) 희귀할수록 잘. 하루 SHARD_DAY개까지 — index.html shardDrop과 같은 규칙 */
const SHARD_DAY = 120, SHARD_CH = [.15, .25, .6, 1, 1];   // 2026-11-05: 한 주 상한 (몰아서 낚아도 돼요)
const shardDay = () => SHARD_DAY + (arkSt() >= 3 ? 20 : 0);   // ⛵ 돛단 물결호: +20
function shardRoll(s, oldSd) {
  const w = wkId(); if (!s.shd || typeof s.shd !== 'object' || s.shd.w !== w) s.shd = { w, n: 0 };
  const nsd = (s.sdex && typeof s.sdex === 'object') ? s.sdex : {}; let got = 0;
  for (let id of [...Array(PTY_FIRST - ISLE_FIRST).keys()].map(i => ISLE_FIRST + i).concat([...Array(120).keys()].map(i => ISX_FIRST + i), [...Array(ISY_ZR.length).keys()].map(i => ISY_FIRST + i))) {   // 섬 새 낚시터 물고기도 조각을 줘요
    let dn = Math.max(0, (nsd[id] | 0) - (oldSd[id] | 0)); const r = fishRar(id);
    const SD = shardDay(); while (dn-- > 0 && s.shd.n < SD) if (Math.random() < SHARD_CH[r]) { const k = Math.min(r >= 4 ? 3 : 1, SD - s.shd.n); s.shd.n += k; got += k; }
  }
  return got;
}
const dayNum = d => Math.floor(Date.parse(d) / 864e5);
function vdayOf(s) { const t = kstDay(); let v = s.vday; if (!v || typeof v !== 'object' || !v.d) v = s.vday = { d: t, b: 1 }; const dd = dayNum(t) - dayNum(v.d); if (dd > 0) { v.b = Math.min(3, (v.b | 0) + dd); v.d = t; } return v; }
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
  for (const k of Object.keys(delta)) { const nk = mkKey(k); if (nk !== k) { delta[nk] = (delta[nk] | 0) + (delta[k] | 0); delete delta[k]; } }   // 옛 재료 이름 → 새 이름 (화면에도 새 이름으로 가요)
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
        if (row.save && row.save.mar && V && V.marEnd && V.marEnd[row.name] > (row.save.mar.d | 0)) { row.save.mar = null; delete V.marEnd[row.name]; vMark(); }   // 💔 상대가 헤어짐을 고른 경우
        const color = colorOf(key);
        const p = { id: nextId++, key, name: row.name, color, admin: ADMINS.has(key), x: 0, y: 0, d: 'down', m: 0, b: 0, here: false,
          save: row.save, look: cleanLook(row.save && row.save.cos && row.save.cos.look, row.save, color), tr: null, sayT: 0, emoT: 0 };
        players.set(ws, p);
        send(ws, { t: 'login_ok', id: p.id, name: p.name, color: p.color, save: row.save, isNew, admin: p.admin });
        // 지금 있는 친구들 알려 주기 / 내가 왔다고 알리기 (외형 포함)
        for (const [ows, op] of players) if (ows !== ws) send(ws, { t: 'join', id: op.id, name: op.name, color: op.color, x: op.x, y: op.y, d: op.d, here: op.here, look: op.look });
        broadcast({ t: 'join', id: p.id, name: p.name, color: p.color, look: p.look }, ws);
        if (p.save) curMigrate(p.save);
        if (p.save) { const e = enhOf(p.save), out = []; enhDaily(e, out); enhSession(e, out); { const l0 = e.lv | 0; e.star = e.star | 0; while (e.lv < ENH.MAX && e.star >= ENH.S[e.lv]) { e.star -= ENH.S[e.lv]; e.lv++; } e.max = Math.max(e.max | 0, e.lv); if (e.lv > l0) out.push('🎉 강화 3.0! 모아 둔 별로 +' + l0 + ' → +' + e.lv); } rankSet(key, p.name, e, p.look); sendEnh(ws, p, { note: out }); if (out.length) queueSave(key, p.save); }
        send(ws, { t: 'champ', c: champPub() });
        rosterSet(key, p.name, p.save); rosterSend(true);
        if (p.save) withLock(key, async () => { stampMigrate(ws, p.save); queueSave(key, p.save); await welcomeBack(ws, p); }).catch(e => console.error('welcome', e.message));
        send(ws, { t: 'pt', p: ptPub(), today: ptToday(p.save) }); if (p.save) send(ws, { t: 'vday', b: vdayOf(p.save).b });
        send(ws, { t: 'ev', list: evList() }); send(ws, vPub()); send(ws, { t: 'traps', list: trapPub() }); send(ws, dkPub()); if (V && V.snowmen) send(ws, { t: 'snowmen', list: Object.values(V.snowmen) }); if (V && Array.isArray(V.lan)) send(ws, { t: 'lans', list: V.lan.filter(l => Date.now() - l.at < 864e5) }); if (p.save) send(ws, { t: 'med', med: medPub(p.save), wkc: p.save.wkc || null, medw: p.save.medw || null }); togCheck();
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
        m.data.boat = me.save && me.save.boat ? me.save.boat : 0;
        m.data.arkd = me.save ? me.save.arkd | 0 : 0;   // 물결호에 실은 수 (방주 칭호)   // 물결호를 만든 기록도 서버 것만
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
        m.data.eb = me.save && me.save.eb ? me.save.eb : null;   // 은비랜드 칩 (서버만)
        m.data.trust = 0;   // 신뢰는 도토리로 합쳤어요
        for (const k of ['npcd', 'mar', 'rpg', 'wfc', 'hunt', 'acm', 'vday', 'blessT', 'med', 'evtk', 'wkc', 'medw', 'shiny', 'aq', 'aql', 'aqlg', 'lsd', 'mnt', 'sdtk', 'shtk', 'shb', 'stv', 'skc', 'aqx', 'aqd', 'aqon', 'cup', 'home', 'hml', 'hmlg']) m.data[k] = me.save && me.save[k] ? me.save[k] : null;   // 도토리 · 행사 강화권 · 주간 보상 받은 기록
        if (!m.data.lsd) m.data.lsd = kstDay();
        if (!me.save) m.data.stv = 1;   // 새 친구는 도장 정산이 필요 없어요   // 처음 저장한 날부터 '돌아온 친구 선물' 계산
        const oldSd = (me.save && me.save.sdex) || {};
        const sFixed = checkSdex(me.save, m.data, oldDex, newDex);   // 손맛 도감은 실제로 낚은 만큼만
        m.data.cosg = me.save && Array.isArray(me.save.cosg) ? me.save.cosg : [];   // 서버가 준 옷: 화면 저장에서 빠져도 다시 넣어요
        if (m.data.cosg.length) { const c = m.data.cos && typeof m.data.cos === 'object' ? m.data.cos : (m.data.cos = {}); c.own = Array.isArray(c.own) ? c.own : []; for (const id of m.data.cosg) if (!c.own.includes(id)) c.own.push(id); }
        const e = enhOf(m.data), out = [];
        enhDaily(e, out);
        if (!first) { let pts = 0, cnt = 0; for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0); if (dn > 0) { pts += dn * ENH.PTS[fishRar(+k)]; cnt += dn; } } if (pts) enhAddPoints(e, pts, out); if (cnt) wkAdd('fish', cnt); }
        foldItems(m.data); me.save = m.data; lastSaveAt.set(me.key, now); rosterSet(me.key, me.name, m.data); shipSnap(me, m.data);
        if (first) togCheck();
        if (sFixed) send(ws, { t: 'sdex', sdex: m.data.sdex });   // 손맛 도감을 서버 기록에 맞춰요
        if (!first) { shinyRoll(ws, me, m.data, oldSd); mythCheck(me, m.data, oldSd); dayStar(me, m.data, oldSd); mentorCheck(me, m.data, oldSd); starCatch(ws, m.data, oldSd); stampCheck(ws, m.data, oldSd); recCheck(ws, me, oldDex, m.data, oldSd); }
        if (!first) {   // 섬 물고기를 직접 낚았으면 안개 조각
          const sh = shardRoll(m.data, oldSd);
          if (sh) { const rev = applyInv(m.data, { 'i:shard': sh }); send(ws, { t: 'delta', d: { 'i:shard': sh }, rev, shd: m.data.shd, why: '🔹 섬 물고기를 직접 낚았어요 (이번 주 ' + m.data.shd.n + '/' + shardDay() + ')' }); }
        }
        if (!first) {   // 장소마다 오늘 첫 낚시 선물
          const g = giftOf(m.data), places = [];
          for (const k in newDex) { const dn = (newDex[k].n | 0) - (oldDex[k] ? oldDex[k].n | 0 : 0), z = placeOf(+k); if (dn > 0 && GIFT_PLACES.includes(z) && !g.z.includes(z) && !places.includes(z) && g.z.length + places.length < GIFT_DAY) places.push(z); }
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
    // 배낚시 중에 껐다 켜도 배에서 내리지 않아요 (다시 들어오면 갑판으로). 출항 전 대기 중이면 내려요
    if (party && party.members.includes(p.key)) { if (party.state === 'sea') ptSoon(); else ptRemove(p.key); }
    togCheck();
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
    case 'skill': withLock(me.key, async () => { const s = me.save; if (!s) return; const k = String(m.k || ''), D = SKILLS[k]; if (!D) return;
      if (jobOf(s) !== D.job || !jobRank(s, D.job, D.node)) return send(ws, { t: 'skill_err', text: '이 기술은 ' + JOB_NAME[D.job] + '만 쓸 수 있어요' });
      const now = Date.now(), c = objOf(s, 'skc'), r = jrOf(s, D.job);
      if (D.daily) { if (c[k] === kstDay()) return send(ws, { t: 'skill_err', text: '오늘은 이미 썼어요. 내일 다시!', k, used: true }); c[k] = kstDay(); }
      else { const next = (c[k] | 0); if (now < next) return send(ws, { t: 'skill_err', text: Math.ceil((next - now) / 60000) + '분 뒤에 다시 쓸 수 있어요', k, next });
        c[k] = now + D.cd(s) * 60e3 * (r >= 3 ? .75 : 1); }   // 명장이면 쿨타임 25% 짧게
      const until = now + (D.dur ? D.dur(s) * 60e3 : 0), out = { t: 'skill_ok', k, until, next: D.daily ? 0 : c[k] };
      if (k === 'boom') { V.boom = { by: me.name, until }; vMark(); vSend(); broadcast({ t: 'news', text: '🔮 ' + me.name + ' 님의 대박 예보! ' + Math.round((until - now) / 60000) + '분 동안 마을 모두 희귀 이상 2배!' }); }
      if (k === 'shx') me.shx = until;
      if (k === 'cat') { const e = enhOf(s); e.tk = Math.min(ENH.TK_MAX, e.tk + 1); out.enh = e; out.note = '🔨 장인의 손길: 강화권 +1'; }   // 2026-11-05: 촉매 대신 강화권
      queueSave(me.key, s); send(ws, out);
    }).catch(e => console.error('skill', e.message)); break;
    case 'ark_put': withLocks([me.key, '__ark'], async () => {
      const s = me.save; if (!s || !V) return; if (!vBoat) return send(ws, { t: 'news', text: '먼저 물결호를 만들어야 해요' });
      const A = arkOf(), need = ARK_NEED[A.st + 1], g = String(m.g || ''); if (!need || !need[g]) return;
      const allowed = ARK_GROUP[g] || [g], left = need[g] - (A.got[g] | 0); if (left <= 0) return send(ws, { t: 'news', text: '그 재료는 다 모였어요' });
      const d = {}; let n = 0;
      for (const [k, v] of Object.entries(m.items && typeof m.items === 'object' ? m.items : {})) { if (!allowed.includes(k)) continue; const t = Math.min(v | 0, left - n); if (t <= 0) continue; if (!hasKey(s, 'i:' + k, t)) return send(ws, { t: 'news', text: '가진 게 모자라요' }); d['i:' + k] = -t; n += t; }
      if (!n) return;
      await changeBag(me.key, d, '⛵ 물결호에 ' + n + '개 실었어요!');
      A.got[g] = (A.got[g] | 0) + n; A.dn[me.name] = (A.dn[me.name] | 0) + n; s.arkd = (s.arkd | 0) + n; queueSave(me.key, s);
      if (Object.keys(need).every(k => (A.got[k] | 0) >= need[k])) {
        A.st++; A.got = {}; broadcast({ t: 'news', text: '🎉⛵ 마을 모두의 힘으로 「' + ARK_NAME[A.st] + '」 완성!' });
        if (A.st >= 5) for (const key of rosterCache.keys()) { const sv = await loadSave(key); if (sv && (sv.arkd | 0) > 0) { const got = giveCos(sv, ['t_ark']); queueSave(key, sv); const l = liveByKey(key); if (l && got.length) send(l[0], { t: 'cos_got', ids: got }); } }
      }
      vMark(); vSend();
    }).catch(e => console.error('ark_put', e.message)); break;
    case 'ship_claim': withLock('__ship', async () => {
      const s = me.save; if (!s || !V) return; const L = shipsOf();
      if (shipIdx(me.key) >= 0) return send(ws, { t: 'ships', ships: shipPub() });
      let i = L.findIndex(x => !x); const now = Date.now();
      if (i < 0) i = L.findIndex(x => x && !liveByKey(x.key) && now - (x.t || 0) > SHIP_IDLE);
      if (i < 0) return send(ws, { t: 'news', text: '빈 꽃배가 없어요 · 7일 넘게 안 온 사람의 배가 비면 받을 수 있어요' });
      L[i] = { key: me.key, name: me.name, at: 'v', t: now, st: 0, gd: shipSnapOf(s) }; vMark();
      send(ws, { t: 'ship_ok', ships: shipPub() }); broadcast({ t: 'ships', ships: shipPub() }, ws);
      broadcast({ t: 'news', text: '🌷 ' + me.name + ' 님이 모두의 정원에 자리를 잡았어요!' });
    }).catch(e => console.error('ship_claim', e.message)); break;
    case 'ship_sail': {
      const i = shipIdx(me.key), at = m.at === 'i' ? 'i' : 'v'; if (i < 0) break; const x = V.ships[i]; if (x.at === at) break;
      if (at === 'i' && !vBoat) { send(ws, { t: 'news', text: '마을 물결호가 있어야 안개 섬 뱃길을 알아요' }); break; }
      const now = Date.now(); if (now - (x.st || 0) < SHIP_SAIL_MS) { send(ws, { t: 'news', text: '⛵ 돛을 다시 펴려면 ' + Math.ceil((SHIP_SAIL_MS - (now - x.st)) / 60000) + '분 기다려요' }); break; }
      x.at = at; x.st = now; vMark();
      send(ws, { t: 'ship_sail', at, ships: shipPub() }); broadcast({ t: 'ships', ships: shipPub() }, ws);
      broadcast({ t: 'news', text: at === 'i' ? '🌫️⛵ ' + me.name + ' 님의 꽃배가 꽃을 싣고 안개 섬으로 떠났어요' : '🏘️⛵ ' + me.name + ' 님의 꽃배가 마을 꽃배 부두로 돌아왔어요' });
      break;
    }
    case 'rank_get': { const k = String(m.k || ''), r = rankOf(k, me); if (r) send(ws, Object.assign({ t: 'rank', k }, r)); break; }
    case 'trust_buy': withLock(me.key, async () => {
      const s = me.save, id = String(m.id || ''), cost = TRUST_SHOP[id]; if (!s || !cost) return;   // 옛 화면용: 이제 도토리로 사요
      const own = (s.cos && s.cos.own) || []; if (own.includes(id)) return send(ws, { t: 'rq_err', msg: '이미 가지고 있어요' });
      const md = s.med || (s.med = { n: 0, tot: 0, d: kstDay(), t: 0 }); if ((md.n | 0) < cost) return send(ws, { t: 'rq_err', msg: '도토리가 모자라요 (' + cost + ')' });
      md.n -= cost; const got = giveCos(s, [id]); queueSave(me.key, s); send(ws, { t: 'cos_got', ids: got }); send(ws, { t: 'med', med: medPub(s), why: '🌰 도토리 교환 완료!' });
    }).catch(e => console.error('trust_buy', e.message)); break;
    case 'mstar': withLock(me.key, async () => {   // 명장 ★: 명장(4000) 다음부터 2000마다 · 강화권 +3 · 안개 조각 +2
      const s = me.save, job = jobOf(s); if (!s || !job) return; const x = s.job.xp && s.job.xp[job] | 0, st = x >= 4000 ? Math.floor((x - 4000) / 2000) : 0;
      const mst = s.mst && typeof s.mst === 'object' ? s.mst : (s.mst = {}), got = mst[job] | 0; if (st <= got) return; const n = Math.min(20, st - got); mst[job] = st;
      const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + 3 * n); out.push('⭐ 명장 ★' + st + '! 강화권 +' + 3 * n + ' · 안개 조각 +' + 2 * n);
      await changeBag(me.key, { 'i:shard': 2 * n }, null); queueSave(me.key, s); sendEnh(ws, me, { note: out }); send(ws, { t: 'mst', mst });
      broadcast({ t: 'news', text: '⭐ ' + me.name + ' 님이 「명장 ★' + st + ' ' + JOB_NAME[job] + '」에 올랐어요!' }, ws);
    }).catch(e => console.error('mstar', e.message)); break;
    case 'brag': {   // 유니크 이상 치장을 사면 마을에 자랑 (가진 것만 · 같은 건 한 번만)
      const id = String(m.id || ''), own = (me.save && me.save.cos && me.save.cos.own) || [], c = BRAG[id]; if (!c || !own.includes(id)) return;
      const b = me.bragged || (me.bragged = new Set()); if (b.has(id)) return; b.add(id);
      broadcast({ t: 'news', text: c[0] + ' ' + me.name + ' 님이 ' + c[1] + ' 「' + c[2] + '」을(를) 손에 넣었어요!' }); break;
    }
    case 'aq_buy': case 'aq_on': case 'cos_up': case 'pv_buy': case 'pv_list': spendMsg(ws, me, m); break;
    case 'home_get': case 'home_list': case 'home_like': case 'home_buy': case 'home_set': homeMsg(ws, me, m); break;
    case 'sh_sell': withLock(me.key, async () => {   // 가방 반짝 칸의 반짝 물고기 팔기: 보통의 10배 × 낚싯대 판매가
      const s = me.save, id = m.id | 0; if (!s || !validFish(id)) return; const b = objOf(s, 'shb'); if (!((b[id] | 0) > 0)) return send(ws, { t: 'news', text: '가방에 그 반짝 물고기가 없어요' });
      b[id]--; const g = Math.round(fishPrice(id) * 25 * enhSell(s.enh && s.enh.lv));   // 반짝은 25배 await changeBag(me.key, { g }, null); send(ws, { t: 'shb', shb: b, sold: id, g });
    }).catch(e => console.error('sh_sell', e.message)); break;
    case 'hold': {   // 잡은 물고기를 머리 위로 번쩍 (친구들 화면에도) · 놓치면 털썩
      const now = Date.now(); if (now - (me.holdT || 0) < 700) return; me.holdT = now;
      if (m.miss) { broadcast({ t: 'hold', id: me.id, miss: 1 }, ws); break; }
      const f = m.f | 0; if (!validFish(f)) return; const c = ['small', 'mid', 'big', 'giant'].includes(m.c) ? m.c : 'mid';
      broadcast({ t: 'hold', id: me.id, f, len: Math.max(1, Math.min(9999, m.len | 0)), c, sh: !!m.sh, nw: !!m.nw, pf: !!m.pf, bt: !!m.bt, x2: Math.min(3, m.x2 | 0), wl: !!m.wl, vr: Array.isArray(m.vr) ? [m.vr[0] | 0, String(m.vr[1] || '').slice(0, 12)] : null, ln: String(m.ln || '').replace(/[<>]/g, '').slice(0, 40) }, ws); break;
    }
    case 'wow': {   // 친구가 든 물고기에 '우와!'
      const now = Date.now(); if (now - (me.wowT || 0) < 1200) return; me.wowT = now; const l = liveById(m.id); if (!l || l[1].key === me.key) return;
      broadcast({ t: 'wow', id: me.id, to: l[1].id, name: me.name }, ws); break;
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
      if (!give && !want) return send(ws, { t: 'bd_err', msg: '줄 물고기나 받을 물고기를 골라 주세요' });
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
        const t = keyKind(k), n = Math.min(t === 'g' ? 1e9 : 9999, Math.floor(Number(src[k]) || 0)); if (!t || n <= 0) continue;
        const cap = t === 'g' ? Math.floor(Number(me.save && me.save.gold) || 0) : t === 'i' ? itemsOf(me.save)[k.slice(2)] | 0 : invOf(me.save)[+k] | 0;
        const v = Math.min(n, cap); if (v > 0) it[k] = v;
      }
      if (Object.keys(it).length > 30) return;
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
        const r = enhRoll(e, mode, (Number(me.save.gold) || 0), 1 - (1 - .1 * jobRank(me.save, 'mer', 'enh')) * zoneDisc(me.save));
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
      const s = me.save, item = String(m.item || ''), n = Math.max(1, Math.min(20, m.n | 0)), pay = Math.max(0, Math.min(1e8, m.pay | 0));
      if (!s || !MAKER[item]) return send(ws, { t: 'rq_err', msg: '의뢰할 수 없는 물건이에요' });
      if ((Number(s.gold) || 0) < pay) return send(ws, { t: 'rq_err', msg: '골드가 모자라요' });
      if (reqsOf(s).length >= REQ_MAX) return send(ws, { t: 'rq_err', msg: '의뢰는 ' + REQ_MAX + '개까지 올릴 수 있어요' });
      if (pay) await changeBag(me.key, { g: -pay }, null);
      reqsOf(me.save).push({ id: crypto.randomUUID(), item, n, pay, at: Date.now() }); queueSave(me.key, me.save);
      send(ws, { t: 'rq_ok', text: '📜 의뢰를 올렸어요' + (pay ? ' · 의뢰비 ' + pay + '골드는 교환소가 맡아 둬요' : '') });
      for (const [w, p] of players) { if (w === ws) continue; const mk = jobOf(p.save) === MAKER[item];
        send(w, { t: 'news', text: mk ? '🔥 ' + JOB_NAME[MAKER[item]] + ' 님, 마을이 찾아요! ' + me.name + ' 님이 ' + ITEM_NAME[item] + ' ×' + n + '을(를) 찾아요' + (pay ? ' (의뢰비 ' + pay.toLocaleString() + '골드)' : '') : '📜 ' + me.name + ' 님이 ' + ITEM_NAME[item] + ' ×' + n + '을(를) 구해요' + (pay ? ' · ' + pay.toLocaleString() + '골드' : '') }); }
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
        const q = r[i], pro = jobOf(me.save) === MAKER[q.item];   // 직업 4.0: 가진 사람 누구나 · 그 직업이면 숙련도 +60 · 신뢰 2배
        if (!hasReqItem(me.save, q.item, q.n)) return send(ws, { t: 'rq_err', msg: '가진 게 모자라요' });
        r.splice(i, 1); queueSave(owner, os);
        await changeBag(me.key, Object.assign(reqDelta(q.item, -q.n), q.pay ? { g: q.pay } : {}), '📜 의뢰 해결!' + (q.pay ? ' 의뢰비 +' + q.pay + '골드' : ''));
        await changeBag(owner, reqDelta(q.item, q.n), '📜 ' + me.name + ' 님이 의뢰한 ' + ITEM_NAME[q.item] + ' ×' + q.n + '을(를) 보내 줬어요!');
        if (!liveByKey(owner)) addMail(owner, me.name + ' 님이 의뢰한 ' + ITEM_NAME[q.item] + ' ×' + q.n + '을(를) 보내 줬어요!');
        await tagMaker(owner, q.item, me.name, q.n);
        const ms = me.save, ac = (pro ? 2 : 1) * Math.max(1, Math.min(5, Math.ceil(q.n / 2))); await medAdd(me.key, ac, null, true); queueSave(me.key, ms);
        send(ws, { t: 'rq_ok', solved: true, text: '📜 ' + ((rosterCache.get(owner) || {}).name || '') + ' 님의 부탁을 해결했어요! 🌰 도토리 +' + ac + (pro ? ' · 숙련도 +60' : '') });
        if (pro) send(ws, { t: 'jxp', job: MAKER[q.item], n: jrOf(me.save, MAKER[q.item]) >= 4 ? 120 : 60 });
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
    case 'rec_list': recInit().then(() => send(ws, { t: 'rec', rec: (V && V.rec) || {}, myth: (V && V.myth) || {} })).catch(() => { }); break;
    case 'aq_set': case 'aq_list': case 'aq_get': case 'aq_like': aqMsg(ws, me, m); break;
    case 'vil': case 'wk_claim': case 'med_buy': case 'ev_rsv': case 'ev_rsv_del': case 'vf_put': vilMsg(ws, me, m); break;
    case 'adq_send': {   // 📮 운영자에게 쓰기 (의견 · 환불 요청)
      if (!V) break; V.adq = Array.isArray(V.adq) ? V.adq : []; const mine = V.adq.filter(x => x.key === me.key && !x.st); if (mine.length >= 3) { send(ws, { t: 'news', text: '아직 답을 기다리는 편지가 3통 있어요' }); break; }
      const kind = m.kind === 'refund' ? 'refund' : 'note', text = cleanText(m.text || '', 200); if (!text && kind === 'note') break;
      const cos = kind === 'refund' ? String(m.cos || '').slice(0, 30) : '', g = kind === 'refund' ? Math.max(0, Math.min(1e9, m.g | 0)) : 0;
      if (kind === 'refund' && !(me.save && me.save.cos && Array.isArray(me.save.cos.own) && me.save.cos.own.includes(cos))) { send(ws, { t: 'news', text: '가지고 있는 치장만 환불을 요청할 수 있어요' }); break; }
      V.adq.push({ id: crypto.randomBytes(4).toString('hex'), key: me.key, name: me.name, kind, cos, cn: String(m.cn || '').slice(0, 30), g, text, at: Date.now(), st: '' }); if (V.adq.length > 100) V.adq.splice(0, V.adq.length - 100); vMark();
      send(ws, { t: 'news', text: '📮 운영자에게 편지를 보냈어요' }); for (const [w2, p2] of players) if (p2.admin) send(w2, { t: 'news', text: '📮 ' + me.name + ' 님의 편지가 왔어요 (운영자 도구)' });
      break; }
    case 'egg': withLock(me.key, async () => {   // 🥚 숨은 보상 (2026-11-09): 루비 '한 바퀴 더' 30일 연속 · 고양이 화장실 30번
      const s = me.save; if (!s) return; const eg = s.egg && typeof s.egg === 'object' ? s.egg : (s.egg = {}); const k = m.k; if (eg[k]) return;
      if (k === 'ruby30' && ((s.wkx && s.wkx.n) | 0) >= 30) { eg[k] = Date.now(); giveCos(s, ['t_ruby30']); queueSave(me.key, s); await flushSave(me.key); await changeBag(me.key, { g: 100000000 }, '🐕 루비가 숨겨 둔 보물'); send(ws, { t: 'egg_ok', k, cos: ['t_ruby30'] }); broadcast({ t: 'news', text: '🐕💎 ' + me.name + ' 님이 30일 동안 루비와 한 바퀴 더 걸었어요… 루비가 숨겨 둔 보물을 찾았대요!' }); }
      else if (k === 'litter30' && (s.litN | 0) >= 30) { eg[k] = Date.now(); giveCos(s, ['t_litter30']); queueSave(me.key, s); await flushSave(me.key); await changeBag(me.key, { g: 20000000, 'i:knack': 30 }, '🐈 고양이들의 감사 선물'); send(ws, { t: 'egg_ok', k, cos: ['t_litter30'] }); broadcast({ t: 'news', text: '🐈✨ ' + me.name + ' 님이 고양이 화장실을 30번 치웠어요. 고양이들이 몰래 모은 선물을 내놨대요!' }); }
    }); break;
    case 'lan_put': {   // 🏮 소원 등불 (3차-2): 하루 동안 · 한 사람 하나 · 최대 40개
      if (!V) break; const text = cleanText(m.text || '', 24); if (!text) break; const now = Date.now();
      V.lan = (Array.isArray(V.lan) ? V.lan : []).filter(l => now - l.at < 864e5 && l.n !== me.name); V.lan.push({ n: me.name, t: text, at: now }); if (V.lan.length > 40) V.lan.shift(); vMark();
      broadcast({ t: 'lans', list: V.lan }); broadcast({ t: 'news', text: '🏮 ' + me.name + ' 님이 고래 만 하늘에 소원 등불을 띄웠어요' }, ws); break; }
    case 'sm_set': {   // ⛄ 소복마을 눈사람 (3차-3): 한 사람에 하나 · 모두에게 보여요
      if (!V) break; V.snowmen = V.snowmen && typeof V.snowmen === 'object' ? V.snowmen : {}; const x = m.x | 0, y = m.y | 0, st = Math.max(0, Math.min(2, m.st | 0));
      const parts = Array.isArray(m.parts) ? m.parts.filter(p => ['nose', 'arms', 'scarf', 'hat', 'star'].includes(p)).slice(0, 5) : [];
      if (Object.entries(V.snowmen).some(([k, s]) => k !== me.key && s.x === x && s.y === y)) break;
      V.snowmen[me.key] = { n: me.name, x, y, st, parts, at: Date.now() }; vMark(); broadcast({ t: 'snowmen', list: Object.values(V.snowmen) }); break; }
    case 'ski_done': broadcast({ t: 'news', text: '🎿 ' + me.name + ' 님이 스키복을 완성했어요! 이제 소복섬에서도 씽씽' }, ws); break;
    /* ----- 💒 결혼 · 축하 ----- */
    case 'cel': { const now = Date.now(); if (now - (me.celT || 0) < 800) break; me.celT = now; const k = String(m.k || ''); if (!['fw', 'big', 'sp', 'pt', 'cf', 'bub', 'bal', 'lan'].includes(k)) break; broadcast({ t: 'cel', k, x: m.x | 0, y: m.y | 0, id: me.id }, ws); break; }
    case 'mar_req': case 'mar_ans': case 'mar_w': case 'mar_go': case 'mar_end': case 'wed_join': case 'wed_msg': case 'wed_list': case 'wed_done': marMsg(ws, me, m); break;
    case 'wf_get': case 'wf_catch': case 'wf_claim': case 'gift_send': case 'gift_list': case 'gift_take': withLock(me.key, async () => socMsg(ws, me, m)).catch(e => console.error('soc', e.message)); break;
    case 'bt_send': case 'bt_try': btMsg(ws, me, m); break;
    case 'gd_water': { if (!V) break; const L = shipsOf(), x = L[m.i | 0]; if (!x || x.key === me.key) break; V.gw = V.gw || {}; const day = kstDay(), gk = me.key + '>' + x.key; if (V.gw[gk] === day) break; V.gw[gk] = day; const ks = Object.keys(V.gw); if (ks.length > 300) delete V.gw[ks[0]];
      const live = liveByKey(x.key); if (live) send(live[0], { t: 'gd_watered', by: [me.name] }); else { V.gwq = V.gwq || {}; (V.gwq[x.key] = V.gwq[x.key] || []).push(me.name); V.gwq[x.key] = V.gwq[x.key].slice(-8); } vMark(); break; }   // 💧 친구 정원 물 주기 (하루 한 번)
    case 'gd_q': { if (V && V.gwq && V.gwq[me.key]) { send(ws, { t: 'gd_watered', by: V.gwq[me.key] }); delete V.gwq[me.key]; vMark(); } break; }
    case 'raid_hit': raidHit(ws, me, m); break;
    case 'raid_get': if (V) { send(ws, Object.assign({ t: 'raid' }, raidPub())); raidClaim(ws, me); } break;
    case 'hs_get': send(ws, { t: 'hs', list: hsPub() }); break;
    case 'hs_cast': hsCast(ws, me, m); break;
    case 'hpos': { const f = m.f | 0; me.hp_ = f < 0 ? null : { f: Math.min(20, f), x: m.x | 0, y: m.y | 0, at: Date.now() }; broadcast({ t: 'hpos', n: me.name, f: f < 0 ? -1 : Math.min(20, f), x: m.x | 0, y: m.y | 0, lv: m.lv | 0, hp: Math.max(0, m.hp | 0), mh: Math.max(1, m.mh | 0), pg: Math.max(0, Math.min(100, m.pg | 0)), cp: Math.max(0, m.cp | 0), d: ['down', 'up', 'left', 'right'].includes(m.d) ? m.d : 'down', mv: m.mv ? 1 : 0, sw: m.sw ? 1 : 0, wt: cleanText(m.wt, 6) }, ws); break; }   // ⚔️ 같은 사냥터 친구 보기   // ⚔️ 같은 사냥터 친구 보기
    case 'npc_done': withLock(me.key, async () => {   // 👵🍰⛄ NPC 부탁 (3차-5): 단계마다 한 번만
      const s = me.save; if (!s) return; const N = { grand: [3e6, 8e6, 3e7, 't_npc1'], sugar: [5e6, 1e7, 5e7, 't_npc2'], sobok: [5e6, 1.5e7, 8e7, 't_npc3'] }[m.id]; const st = m.st | 0; if (!N || st < 0 || st > 2) return;
      const d = s.npcd && typeof s.npcd === 'object' ? s.npcd : (s.npcd = {}); if ((d[m.id] | 0) > st) return; d[m.id] = st + 1;
      const cos = st === 2 ? giveCos(s, [N[3]]) : []; queueSave(me.key, s); await flushSave(me.key); await changeBag(me.key, { g: N[st] }, '💝 부탁을 들어준 답례'); send(ws, { t: 'npc_ok', cos });
      if (st === 2) broadcast({ t: 'news', text: '💝 ' + me.name + ' 님이 ' + ({ grand: '파도 할멈', sugar: '디저트 요정 슈가', sobok: '소복옹' }[m.id]) + '의 마지막 부탁까지 들어줬어요!' });
    }); break;
    case 'fdrop': case 'it_scr': case 'it_dis': case 'sc_buy': withLock(me.key, async () => rpgMsg(ws, me, m)).catch(e => console.error('rpg', e.message)); break;
    case 'hunt_buy': case 'hunt_kill': case 'hunt_pot': case 'hunt_die': case 'hunt_eq': case 'hunt_ex': case 'hunt_star': withLock(me.key, async () => {   // ⚔️ 사냥터 (3차-4): 장비는 은비랜드 칩으로만 · 처치하면 칩 · 아주 가끔 상점에 없는 것
      const s = me.save; if (!s) return; const h = s.hunt && typeof s.hunt === 'object' ? s.hunt : (s.hunt = { w: 0, a: 0, b: 0, sw: 0 }); const e = ebOf(s);
      h.inv = Array.isArray(h.inv) ? h.inv : [];
      if (m.t === 'hunt_eq') { const i = m.i | 0, it = h.inv[i]; if (!it) return; if (!RPG_SLOTS.includes(it.t)) return; const ek = 'eq' + it.t; const lv = (s.hu && s.hu.lv) | 0 || 1; if (h[ek] !== i && itReq(it) > lv) return send(ws, { t: 'news', text: '🔒 용사 Lv' + itReq(it) + '부터 낄 수 있어요 (지금 Lv' + lv + ')' }); h[ek] = h[ek] === i ? null : i; queueSave(me.key, s); return send(ws, { t: 'hunt', hunt: h, c: e.c }); }
      if (m.t === 'hunt_ex') { if ((h.dr | 0) < 20) return; h.dr -= 20; queueSave(me.key, s); await giveTk(me.key, 1, '💤 꿈조각 20개 → 낚시 강화권 1장'); return send(ws, { t: 'hunt', hunt: h, c: e.c, note: '강화권 1장으로 바꿨어요!' }); }
      if (m.t === 'hunt_star') {   // ⭐ 사냥터 별점: 처음 깨면 칩 · 처음 별 3개면 칩 + 10% 주문서
        const fi = Math.max(0, Math.min(9, m.fi | 0)), st = Math.max(1, Math.min(3, m.s | 0)); h.star = h.star && typeof h.star === 'object' ? h.star : {}; const prev = h.star[fi] | 0; if (st <= prev) return;
        const now = Date.now(); if (now - (me.hsT || 0) < 60000) return; me.hsT = now; h.star[fi] = st; let c = 0, note = '';
        if (!prev) { c += 5e4 * (fi + 1); note = '🌟 첫 정화 보상 · 칩 ' + (5e4 * (fi + 1)).toLocaleString(); }
        if (st === 3) { c += 2e5 * (fi + 1); const SC = scrMig(h), id = Math.random() < .5 ? 'w10' : 'a10'; SC[id] = (SC[id] | 0) + 1; note = '⭐⭐⭐ 첫 별 셋! 칩 ' + c.toLocaleString() + ' + ' + (id[0] === 'w' ? '무기' : '방어구') + ' 주문서 10% 🌟'; }
        e.c = (e.c | 0) + c; queueSave(me.key, s); return send(ws, { t: 'hunt', hunt: h, c: e.c, note });
      }
      if (m.t === 'hunt_pot') { if ((h.pot | 0) > 0) { h.pot--; queueSave(me.key, s); } return; }
      if (m.t === 'hunt_die') { const lost = Math.floor((e.c | 0) * .03); e.c -= lost; queueSave(me.key, s); return send(ws, { t: 'hunt', hunt: h, c: e.c }); }
      if (h.w || h.a || h.b) { let ref = 0; for (const k of ['w', 'a', 'b']) { for (let i = 1; i <= (h[k] | 0); i++) ref += HUNT_PRICE[k][i] | 0; h[k] = 0; } e.c = (e.c | 0) + ref; queueSave(me.key, s); send(ws, { t: 'news', text: '💪 단련이 없어지고 기본 능력치로 바뀌었어요 · 칩 ' + ref.toLocaleString() + '개를 돌려드렸어요' }); }   // 단련 폐지 → 전액 환불
      if (m.t === 'hunt_buy' && m.k !== 'pot' && m.k !== 'ex') return;
      if (m.t === 'hunt_buy' && m.k === 'pot') { if ((e.c | 0) < HPOT_PRICE) return send(ws, { t: 'news', text: '칩이 모자라요' }); e.c -= HPOT_PRICE; h.pot = (h.pot | 0) + 10; queueSave(me.key, s); return send(ws, { t: 'hunt', hunt: h, c: e.c, note: '🧪 힐링포션 10개!' }); }
      if (m.t === 'hunt_buy') {
        const k = m.k, P = HUNT_PRICE[k]; if (!P) return; const nx = (h[k] | 0) + 1; if (nx >= P.length) return; const c = P[nx];
        if ((e.c | 0) < c) return send(ws, { t: 'news', text: '칩이 모자라요 (은비랜드에서 골드를 칩으로 바꿔요)' });
        e.c -= c; h[k] = nx; queueSave(me.key, s); return send(ws, { t: 'hunt', hunt: h, c: e.c, note: '장비를 샀어요!' });
      }
      const now = Date.now(); if (now - (me.hkT || 0) < 250) return; me.hkT = now; const r = Math.max(0, Math.min(4, m.rar | 0)), tier = Math.max(0, Math.min(10, m.t | 0)), red = !!m.red;
      const el = !!m.el; let bo = !!m.boss; if (bo) { if (now - (me.hbT || 0) < 40000) bo = false; else me.hbT = now; }   // 우두머리 처치는 40초에 한 번까지 (조작 방지) const RS = rpgSum(h, (s.hu && s.hu.lv) | 0 || 1);
      /* 🤝 함께 사냥: 같은 사냥터 · 가까이(약 16칸) 있는 친구 수 → 칩 · 드랍 보너스 (서버가 직접 세요) */
      let pt = 0; const H0 = me.hp_; if (H0 && now - H0.at < 3000) for (const [, q] of players) { const Q = q.hp_; if (q !== me && Q && Q.f === H0.f && now - Q.at < 3000 && Math.hypot(Q.x - H0.x, Q.y - H0.y) < 260) pt++; } pt = Math.min(3, pt); const pb = 1 + pt * .2;
      let c = Math.round(pb * [100, 250, 600, 1500, 5000][r] * (1 + tier * .5) * (red ? 3 : 1) * (el ? 3 : 1) * (bo ? 25 : 1) * (1 + Math.min(200, RS.chip * 2) / 100)); e.c = (e.c | 0) + c; const got = []; if (Math.random() < (bo ? .5 : el ? .08 : .015) * pb) { const SC = scrMig(h), id = rollScr(); SC[id] = (SC[id] | 0) + 1; got.push('scr:' + id); } 
      if (!h.sw && r >= 2 && Math.random() < (bo ? .05 : .003 * (r + 1))) { h.sw = 1; got.push('sw'); broadcast({ t: 'news', text: '⚔️✨ ' + me.name + ' 님이 사냥터에서 「전설의 낚싯바늘 검」을 주웠어요!! (상점에 없어요)' }); }
      const own = (s.cos && s.cos.own) || [];
      if (!own.includes('t_hunt1') && Math.random() < .004) got.push(...giveCos(s, ['t_hunt1']));
      if (r >= 4 && !own.includes('t_hunt2') && Math.random() < .05) got.push(...giveCos(s, ['t_hunt2']));
      if (got.some(x => x.startsWith('t_'))) send(ws, { t: 'cos_got', ids: got.filter(x => x.startsWith('t_')) });
      h.dr = (h.dr | 0) + Math.round([1, 1, 2, 3, 5][r] * (bo ? 10 : el ? 2 : 1) * (1 + Math.min(200, RS.dr * 2) / 100));
      let item = null; if (Math.random() < (bo ? 1 : el ? .3 : .05 + r * .02) * (1 + Math.min(100, RS.luk) / 100) * pb) { const gw = tier >= 10 ? (bo ? [0, 10, 35, 30, 19, 5, 1, .12, .015] : [20, 35, 25, 13, 6, .9, .1, .004, .0004]) : bo ? [10, 30, 35, 18, 6.7, .3, 0, .01, 0] : [60, 25, 10, 4, .95, .05, 0, 0, 0];
        item = mkItem(tier, rollG(gw)); invPut(h, item); if (item.g >= 4) broadcast({ t: 'news', text: '🎁 ' + me.name + ' 님이 꿈방울에서 ' + RPG_GN[item.g] + ' ' + RPG_SN[item.t] + '을(를) 주웠어요!' }); }
      queueSave(me.key, s); send(ws, { t: 'hunt', hunt: h, c: e.c, gain: c, drop: got, item, pt });
    }); break;
    case 'trap_list': case 'trap_set': case 'trap_claim': case 'trap_take': case 'trap_peek': case 'trap_note': case 'trap_skin': case 'trap_bait': trapMsg(ws, me, m); break;
    /* ----- 은비랜드 ----- */
    case 'eb_info': case 'eb_buy': case 'eb_shop': case 'eb_slot': case 'eb_race': case 'eb_hilo': case 'eb_wheel': case 'eb_vip': ebMsg(ws, me, m); break;
    /* ----- 오늘의 일 세 가지 다 하면 강화권 1장 (하루 한 번) ----- */
    case 'jtask_all': case 'vday_claim': withLock(me.key, async () => {   // 🏘️ 오늘의 마을 일 (2026-11-05): 세 가지 중 두 가지 → 강화권 3 · 도토리 3 · 선물 하나 · 하루 한 몫, 3일치까지 쌓여요
      const s = me.save; if (!s) return; const v = vdayOf(s);
      if (v.b < 1) return send(ws, { t: 'vday', ok: 0, b: 0, msg: '오늘 몫은 이미 받았어요 · 내일 또 한 몫이 쌓여요 (3일치까지)' });
      v.b--; const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + 3); out.push('🏘️ 오늘의 마을 일 완료! 강화권 +3 · 🌰 도토리 +3');
      const delta = {}, cos = [], gout = []; giftRoll(s, e, delta, cos, gout, 0); const got = giveCos(s, cos);
      gout.forEach(t => { if (t !== '새 옷!') out.push('🎁 선물: ' + t); }); for (const k in delta) out.push('🎁 선물: ' + (ITEM_NAME[k.slice(2)] || k.slice(2)) + ' ×' + delta[k]);
      if (Object.keys(delta).length) await changeBag(me.key, delta, null);
      await medAdd(me.key, 3, null, true); queueSave(me.key, s); sendEnh(ws, me, { note: out }); if (got.length) send(ws, { t: 'cos_got', ids: got });
      send(ws, { t: 'vday', ok: 1, b: v.b });
    }).catch(e => console.error('vday', e.message)); break;
    case 'vday_get': if (me.save) send(ws, { t: 'vday', b: vdayOf(me.save).b }); break;
    /* ----- 명장 축복: 하루 한 번, 마을 모두에게 20분 행운 ----- */
    case 'bless': withLock(me.key, () => {
      const s = me.save, job = jobOf(s); if (!job) return; const x = (s.job.xp && s.job.xp[job]) | 0;
      if (x < JR_MASTER) return send(ws, { t: 'news', text: '명장 등급부터 할 수 있어요' });
      if (Date.now() - (s.blessT || 0) < 6 * 3600e3) return send(ws, { t: 'news', text: '축복은 6시간마다 할 수 있어요 (' + Math.ceil((6 * 3600e3 - (Date.now() - s.blessT)) / 60000) + '분 남음)' });
      s.blessT = Date.now(); s.blessd = kstDay(); queueSave(me.key, s);
      for (const [w, p] of players) send(w, { t: 'bless', by: me.name, job, mine: p === me });
    }); break;
    /* ----- 운영자 도구: 공지 · 선물(골드 · 강화권 · 아이템 · 물고기) · 직업 대기 풀기. 운영자 계정만 ----- */
    case 'adm': {
      if (!me.admin) return;
      const ok = text => send(ws, { t: 'adm_ok', text });
      if (m.op === 'notice') { const text = cleanText(m.text, 80); if (text) { broadcast({ t: 'news', text: '📢 운영자: ' + text }); ok('공지를 보냈어요'); } return; }
      /* ----- 갇힘 · 이동 도구 (2026-11-05) ----- */
      if (m.op === 'who') {   // 접속자 위치 · 배낚시 여부
        const list = [...players.values()].map(p => { const tx = Math.floor(p.x / 16), ty = Math.floor(p.y / 16); return { name: p.name, tx, ty, where: ty >= 100 ? '배낚시 바다' : ty >= 60 ? '안개 섬' : '물결마을', pt: !!(party && party.members.includes(p.key)) }; });
        return send(ws, { t: 'adm_who', list, party: party ? { state: party.state, members: party.members.map(k => party.names[k]), hold: party.hold, need: party.need, left: Math.max(0, Math.round((party.end - Date.now()) / 1000)) } : null });
      }
      if (m.op === 'pt_end' || m.op === 'pt_clear') {   // 배낚시 강제 귀항(보상 줌) · 해산(보상 없음)
        if (!party) return ok('지금 배낚시가 없어요');
        console.log('운영자', me.name, m.op);
        if (m.op === 'pt_end' && party.state === 'sea') { ptEnd(); return ok('배낚시를 지금 귀항시켰어요 (보상 지급)'); }
        const mem = party.members.slice(); ptClear(); party = null;
        for (const k of mem) { const l = liveByKey(k); if (l) send(l[0], { t: 'pt', p: null, end: '⚓ 운영자가 배낚시를 마쳤어요' }); }
        ptSend(); return ok('배낚시를 해산했어요');
      }
      if (m.op === 'goto' || m.op === 'summon' || m.op === 'kick') {
        const key2 = String(m.to || '').trim().toLowerCase(), l = liveByKey(key2); if (!l) return ok('지금 접속하지 않은 친구예요');
        const t = l[1];
        if (m.op === 'goto') { send(ws, { t: 'tp', x: t.x, y: t.y, why: t.name + ' 님 옆으로 왔어요' }); return ok(t.name + ' 님에게 갔어요'); }
        if (m.op === 'summon') {
          if (party && party.members.includes(key2) && !(me.y >= 1600)) ptRemove(key2);
          send(l[0], { t: 'tp', x: me.x, y: me.y, why: '🛠️ 운영자 ' + me.name + ' 님이 불렀어요' }); return ok(t.name + ' 님을 내 옆으로 불렀어요');
        }
        send(l[0], { t: 'news', text: '🛠️ 운영자가 연결을 새로 고쳐요. 다시 접속해 주세요' }); setTimeout(() => { try { l[0].close(4000, 'admin'); } catch (e) { } }, 300);
        console.log('운영자', me.name, '연결 끊기', t.name); return ok(t.name + ' 님 연결을 끊었어요');
      }
      /* ----- 운영자 시험 도구 · 편지함 (2026-11-09) ----- */
      if (m.op === 'adq_list') return send(ws, { t: 'adq', list: (V && V.adq || []).slice(-40) });
      if (m.op === 'traphurry') { const T = trapsOf(), t = T[me.key]; if (!t) return ok('놓아둔 통발이 없어요'); t.t0 -= Math.max(1, Math.min(48, m.h | 0)) * 3600e3; vMark(); trapSoon(); return ok('내 통발 시간을 ' + (m.h | 0) + '시간 당겼어요'); }
      if (m.op === 'adq_ok' || m.op === 'adq_no') {
        const q = (V && V.adq || []).find(x => x.id === m.id); if (!q || q.st) return ok('이미 처리했거나 없는 요청이에요');
        if (m.op === 'adq_no') { q.st = 'no'; vMark(); addMail(q.key, '운영자 답장: ' + (cleanText(m.why || '', 60) || '요청을 들어주지 못했어요')); const l = liveByKey(q.key); if (l) send(l[0], { t: 'news', text: '📮 운영자 답장이 왔어요 (교환소 소식함)' }); return send(ws, { t: 'adq', list: V.adq.slice(-40) }); }
        return withLock(q.key, async () => {
          const s = await loadSave(q.key); if (!s) return ok('저장이 없어요');
          if (q.kind === 'refund' && q.cos) {
            const own = s.cos && Array.isArray(s.cos.own) ? s.cos.own : []; if (!own.includes(q.cos)) { q.st = 'gone'; vMark(); return ok('그 치장을 이미 갖고 있지 않아요'); }
            s.cos.own = own.filter(x => x !== q.cos); const L = s.cos.look || {}; for (const k in L) if (L[k] === q.cos) L[k] = k === 'hat' ? 'nohat' : k === 'o' ? 'tee' : ''; if (Array.isArray(s.cosg)) s.cosg = s.cosg.filter(x => x !== q.cos);
            queueSave(q.key, s); await flushSave(q.key); await changeBag(q.key, { g: Math.max(0, Math.min(1e9, q.g | 0)) }, '📮 운영자 환불');
            const l = liveByKey(q.key); if (l) { l[1].save = s; send(l[0], { t: 'cos_back', id: q.cos }); }
          }
          q.st = 'ok'; vMark(); addMail(q.key, '운영자 답장: ' + (q.kind === 'refund' ? '환불해 드렸어요 (' + (q.g | 0).toLocaleString() + ' 골드)' : (cleanText(m.why || '', 60) || '잘 읽었어요! 고마워요')));
          const l = liveByKey(q.key); if (l) send(l[0], { t: 'news', text: '📮 운영자 답장이 왔어요' + (q.kind === 'refund' ? ' · 환불 완료!' : '') });
          send(ws, { t: 'adq', list: V.adq.slice(-40) });
        });
      }
      const key = String(m.to || '').trim().toLowerCase(); if (!key) return;
      const nm = (rosterCache.get(key) || {}).name || (liveByKey(key) || [0, {}])[1].name; if (!nm) return ok('그런 친구가 없어요');
      withLock(key, async () => {
        const l = liveByKey(key);
        if (m.op === 'rescue') {   // 마을로 빼내기: 배낚시에서 내리고 광장으로 (접속 안 했으면 다음 접속 때 광장에서 시작)
          if (party && party.members.includes(key)) ptRemove(key);
          if (l) send(l[0], { t: 'tp', to: 'spawn', why: '🛠️ 운영자가 마을로 데려다 줬어요' });
          const s0 = await loadSave(key); if (s0) { s0.px = 0; s0.py = 0; queueSave(key, s0); await flushSave(key); if (!l) addMail(key, '운영자가 마을 광장으로 데려다 줬어요'); }
          console.log('운영자', me.name, '빼내기', nm); return ok(nm + ' 님을 마을로 빼냈어요' + (l ? '' : ' (다음 접속 때 광장에서 시작)'));
        }
        const s = await loadSave(key); if (!s) return ok(nm + ' 님 저장이 아직 없어요');
        if (m.op === 'setlv') { const e = enhOf(s), n = Math.max(0, Math.min(ENH.MAX, m.n | 0)); e.lv = n; e.max = Math.max(e.max | 0, n); e.star = 0; e.fl = 0; queueSave(key, s); await flushSave(key); if (l) { l[1].save = s; sendEnh(l[0], l[1], { note: ['🛠️ 운영자: 낚싯대 +' + n] }); } return ok(nm + ' 님 낚싯대를 +' + n + '(으)로 맞췄어요'); }
        if (m.op === 'ptreset') { s.ptd = null; queueSave(key, s); await flushSave(key); if (l) { l[1].save = s; send(l[0], { t: 'pt', p: ptPub(), today: 0 }); } return ok(nm + ' 님 오늘 배낚시 횟수를 0으로 돌렸어요'); }
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
      const k = mkKey(m.k), need = BOAT_NEED[k]; if (!need) return;
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
    case 'pt_open': case 'pt_join': case 'pt_board': case 'pt_leave': case 'pt_go': case 'pt_catch': case 'pt_tap': case 'pt_miss': case 'pt_home': ptMsg(ws, me, m); break;
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
        rw.walk = 1; g = 300 + 100 * jobRank(s, 'tam', 'walk'); tk = 1 + jobRank(s, 'tam', 'walk'); label = '산책 보상';
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
      const l = liveById(m.id), v = m.v === 1 ? 1 : 0; if (!l || !v) return;   // 내리기는 없앴어요 (친구끼리 상처만 남아서)
      const [tws, T] = l; if (T.key === me.key) return;
      withLocks([me.key, T.key], () => {
        if (!me.save || !T.save) return send(ws, { t: 'news', text: '잠시 뒤에 다시 해 주세요' });
        const gv = me.save.popGv && typeof me.save.popGv === 'object' ? me.save.popGv : (me.save.popGv = {}), day = kstDay();
        if (gv[T.key] === day) return send(ws, { t: 'news', text: T.name + ' 님에게는 오늘 이미 하트를 줬어요' });
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
const AUC_MAT = [['knack', 4], ['knack', 6], ['toy', 1], ['charm', 2]];
const EV_TI = ['t_cup', 't_bounty', 't_host'], HOST_TI_N = 5;   // 대회 우승 · 현상금 사냥꾼 · 행사 5번 연 사람
const JR_X = [0, 300, 1200, 4000, 15000, 40000, 100000];   // 대명장 · 전설 · 신화 (index.html JR과 같아요)
const jrOf = (s, job) => { const x = s && s.job && s.job.xp ? s.job.xp[job] | 0 : 0; let r = 0; for (let i = 0; i < JR_X.length; i++) if (x >= JR_X[i]) r = i; return r; };
const evs = new Map(); let evSeq = 0, evT = 0;
const evLeft = e => Math.max(0, e.end - Date.now());
function evPub(e) {
  const o = { id: e.id, kind: e.kind, host: e.hostName, x: e.x, y: e.y, end: e.end, n: e.parts.size };
  if (e.kind === 'cup') o.top = [...e.board.values()].sort((a, b) => b.r - a.r).slice(0, 5).map(b => ({ name: b.name, r: b.r, fish: b.fish, len: b.len }));
  if (e.kind === 'bounty') { o.fish = e.fish; o.win = e.win || null; }
  o.fest = !!e.fest; o.mega = !!e.mega;
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
/* 2026-11-05 재화 정리: 신뢰 → 도토리 (1:1) · 강화 촉매 → 강화권 · 옛 재료 이름 접기. 한 사람에 한 번 */
function curMigrate(s) {
  foldItems(s); if (s.acm) return; s.acm = 1;
  const md = s.med && typeof s.med === 'object' ? s.med : (s.med = { n: 0, tot: 0, d: kstDay(), t: 0 }); md.n = (md.n | 0) + (s.trust | 0); s.trust = 0;
  const e = s.enh; if (e && (e.cat | 0) > 0) { e.tk = Math.min(ENH.TK_MAX, (e.tk | 0) + (e.cat | 0)); e.cat = 0; }
}
/* ---------- 축제 도토리 · 행사 강화권: 보상은 골드 대신 '하루 상한이 있는 것'으로 ----------
   도토리은 행사에 참여해야만 생겨요 (하루 MED_DAY개, 축제 시간엔 2배). 행사 강화권은 하루 EVTK_DAY장까지 */
const MED_DAY = 10, EVTK_DAY = 6, FEST_H = 21;   // 축제 시간: 밤 9시~10시 (한국 시간)
const kstH = () => new Date(Date.now() + 9 * 3600e3).getUTCHours();
const isFest = () => kstH() === FEST_H;
const medCap = () => MED_DAY + (vSt() >= 1 ? 2 : 0);
const medPub = s => { const md = (s && s.med) || {}; return { n: md.n | 0, tot: md.tot | 0, t: md.d === kstDay() ? md.t | 0 : 0, cap: medCap() }; };
async function medAdd(key, n, why, noCap) {   // 잠금 안에서 부르기
  const s = await loadSave(key); if (!s || n <= 0) return 0; const d = kstDay(), md = s.med && typeof s.med === 'object' ? s.med : (s.med = { n: 0, tot: 0, d, t: 0 });
  if (md.d !== d) { md.d = d; md.t = 0; }
  if (!noCap) { if (isFest()) n *= 2; n = Math.min(n, medCap() - (md.t | 0)); if (n <= 0) return 0; md.t = (md.t | 0) + n; }
  md.n = (md.n | 0) + n; md.tot = (md.tot | 0) + n; queueSave(key, s);
  const l = liveByKey(key); if (l) send(l[0], { t: 'med', med: medPub(s), why: why ? '🌰 ' + why + ' · 도토리 +' + n : null });
  return n;
}
async function evTk(key, n, note) {   // 행사에서 받는 강화권 (하루 상한) · 잠금 안에서
  const s = await loadSave(key); if (!s) return 0; const d = kstDay(), r = s.evtk && s.evtk.d === d ? s.evtk : (s.evtk = { d, n: 0 });
  n = Math.min(n, EVTK_DAY - r.n); if (n <= 0) return 0; r.n += n; await giveTk(key, n, note.replace('{n}', n)); return n;
}
const lockDo = (key, fn) => withLock(key, fn).catch(er => console.error('reward', er.message));
function evOpen(ws, me, m) {
  return withLock(me.key, async () => {
    const s = me.save, K = EV_KIND[m.kind], err = text => send(ws, { t: 'ev_err', text });
    if (!s || !K) return; if (jobOf(s) !== K.job) return err(JOB_NAME[K.job] + '만 열 수 있어요');
    if (s.evd === kstDay()) return err('행사는 하루에 한 번 열 수 있어요. 내일 또 열어요!');
    if ([...evs.values()].some(e => e.kind === m.kind)) return err('지금 다른 친구가 ' + K.name + '을(를) 열고 있어요');
    if (evs.size >= EV_MAX) return err('지금 행사가 ' + EV_MAX + '개 열려 있어요. 하나가 끝나면 열어 주세요');
    if (!me.here) return err('잠시 뒤에 다시 해 주세요');
    if (m.mega && !hasKey(s, 'g', MEGA_G)) return err('확성기는 ' + fmtN(MEGA_G) + '골드예요');
    const mins = (K.min + vEvExtra()) * (isFest() ? 1.5 : 1);
    const e = { id: 'e' + (++evSeq), kind: m.kind, host: me.key, hostName: me.name, x: me.x, y: me.y, at: Date.now(), end: Date.now() + mins * 60e3, parts: new Set(), timer: 0, mega: !!m.mega, fest: isFest() };
    if (m.kind === 'cup') { e.board = new Map(); e.last = new Map(); }
    if (m.kind === 'bounty') {
      const id = m.fish; if (!validFish(id) || isBoss(id) || (id >= FISH_N && id < ISLE_FIRST) || id >= PTY_FIRST) return err('현상수배할 수 없는 물고기예요');
      e.fish = id;
    }
    if (m.kind === 'stall') { const it = itemsOf(s); e.stock = {}; let tot = 0; for (const k of STALL_MENU) { e.stock[k] = it[k] | 0; tot += it[k] | 0; } if (!tot) return err('팔 음식이 없어요. 공방에서 수프 · 구이 · 간식 · 부적을 먼저 만들어 주세요'); e.sold = 0; e.buy = new Map(); }
    if (m.kind === 'play') { e.seen = new Set(); e.stay = new Map(); }
    if (m.kind === 'auc') {
      const r = n => Math.floor(Math.random() * n), ti = AUC_TI[r(AUC_TI.length)], mt = AUC_MAT[r(AUC_MAT.length)];
      e.lots = [{ k: 'cos', id: ti, n: 1, min: 3000 }, { k: 'i', id: mt[0], n: mt[1], min: Math.round((ITEM_NPC[mt[0]] || 1000) * mt[1] * .4 / 100) * 100 }, { k: 'i', id: 'b_legend', n: 1, min: 30000 }];
      for (const l of e.lots) { l.bid = 0; l.by = ''; l.byName = ''; }
      e.bidders = new Set();
    }
    if (e.mega) await changeBag(me.key, { g: -MEGA_G }, null);
    s.evd = kstDay(); s.evn = (s.evn | 0) + 1; queueSave(me.key, s);
    evs.set(e.id, e); e.timer = setTimeout(() => evEnd(e.id), e.end - Date.now());
    send(ws, { t: 'ev_ok', kind: m.kind });
    // 행사를 열면 오늘의 일도 끝 (강화권 +1, 하루 한 번)
    /* 2026-11-05: 행사를 열면 화면이 「오늘의 마을 일」을 다 채워요 (보상은 마을 일에서) */
    if (s.evn >= HOST_TI_N) { const got = giveCos(s, ['t_host']); if (got.length) send(ws, { t: 'cos_got', ids: got }); }
    if (V) { const n0 = V.rsv.length; V.rsv = V.rsv.filter(r => r.host !== me.key); if (V.rsv.length !== n0) vMark(); }
    wkAdd('open', 1);
    const where = me.y >= 60 * 16 ? '안개 섬' : (me.x >= 34 * 16 && me.y < 31 * 16) ? '축제 광장' : '마을';
    const how = { cup: '낚시만 하면 자동 참가!', bounty: '처음 낚는 사람에게 현상금 (강화권 · 도토리)!', stall: '지나가다 사 먹으면 30분 버프!', play: '근처에 있으면 짝꿍이 ♥ · 경험치', auc: '오늘만 나오는 물건을 골드로 겨뤄요' }[m.kind];
    const text = (e.mega ? '📣 ' : '') + K.ic + ' ' + me.name + ' 님(' + JOB_NAME[K.job] + ')이 ' + where + '에서 「' + K.name + '」을(를) 열었어요! ' + how + (e.fest ? ' 🎉 축제 시간이라 도토리 2배!' : '');
    broadcast({ t: 'news', text }); if (e.mega) broadcast({ t: 'ev_mega', text, kind: m.kind, host: me.name });
    evSoon(); rosterSoon(); vSoon();
  }).catch(e => console.error('ev_open', e.message));
}
const MEGA_G = 50000;   // 행사 확성기: 마을 전체에 크게 알리고, 끝날 때 참가자 도토리 +1
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
        await lockDo(me.key, async () => { await evTk(me.key, 2, '🎯 현상수배 해결! 강화권 +{n}'); await medAdd(me.key, 3, '현상수배 해결'); await giveCosTo(me.key, ['t_bounty']); });
        if (e.host !== me.key) { await lockDo(e.host, async () => { await evTk(e.host, 1, '🎯 ' + me.name + ' 님이 내 현상수배를 해결했어요! 강화권 +{n}'); await medAdd(e.host, 2, '내 현상수배가 해결됐어요'); }); helpAdd(e.host, me.name, '내 현상수배 덕분에 새 물고기를 낚았대요').catch(() => { }); }
        for (const p of [...players.values()]) if (p.key !== me.key && p.key !== e.host) await lockDo(p.key, () => medAdd(p.key, 1, '현상수배 해결 축하'));
        broadcast({ t: 'news', text: '🎯 현상수배 해결! ' + me.name + ' 님이 ' + e.hostName + ' 박사가 찾던 물고기를 낚았어요! 접속한 모두에게 축하 도토리 🌰' });
        wkAdd('bounty', 1); evEnd(e.id);
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
    const first = !e.buy.has(me.key);
    e.buy.set(me.key, (e.buy.get(me.key) | 0) + 1); e.parts.add(me.key); e.sold++;
    await changeBag(me.key, { g: -price, ['i:' + k]: 1 }, null);
    await changeBag(e.host, { g: price, ['i:' + k]: -1 }, null);
    e.stock[k] = itemsOf(await loadSave(e.host))[k] | 0;
    send(ws, { t: 'ev_ate', item: k, host: e.hostName });
    if (first) await medAdd(me.key, 1, '포장마차 손님');
    giveJxp(e.host, 'cra', 10, null).catch(() => { }); wkAdd('stall', 1);
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
    if (!e.bidders.has(me.key)) { e.bidders.add(me.key); await medAdd(me.key, 1, '반짝 장터 참여'); }
    if (prev) { const ps = await loadSave(prev); if (ps) holdDel(ps, e.id, m.lot | 0); await changeBag(prev, { g: prevG }, '🔔 반짝 장터: ' + me.name + ' 님이 더 높게 불러서 ' + prevG + '골드를 돌려받았어요'); if (!liveByKey(prev)) addMail(prev, '반짝 장터에서 ' + me.name + ' 님이 더 높게 불렀어요. ' + prevG + '골드는 돌려드렸어요'); }
    if (evLeft(e) < 60e3) { e.end = Date.now() + 60e3; clearTimeout(e.timer); e.timer = setTimeout(() => evEnd(e.id), 60e3); }   // 막판 입찰은 1분 연장
    send(ws, { t: 'ev_err', text: '🔔 ' + g + '골드에 입찰했어요!' }); evSoon();
  }).catch(er => console.error('ev_bid', er.message));
}
/* 펫 놀이터: 1분마다 근처 친구의 짝꿍이 ♥ · 경험치. 5분 넘게 놀면 도토리 */
function evTick() {
  for (const e of evs.values()) {
    if (e.kind !== 'play') continue;
    for (const [ws, p] of players) {
      if (!p.here || !p.save || Math.hypot(p.x - e.x, p.y - e.y) > PLAY_R) continue;
      send(ws, { t: 'ev_pet', host: e.hostName });
      if (p.key === e.host) continue;
      if (!e.seen.has(p.key)) { e.seen.add(p.key); e.parts.add(p.key); giveJxp(e.host, 'tam', 10, null).catch(() => { }); helpAdd(e.host, p.name, '펫 놀이터에서 짝꿍이 신나게 놀았어요').catch(() => { }); evSoon(); }
      const st = (e.stay.get(p.key) | 0) + 1; e.stay.set(p.key, st);
      if (st === 5) { lockDo(p.key, () => medAdd(p.key, 1, '펫 놀이터에서 신나게 놀았어요')); wkAdd('play', 1); }
    }
  }
}
setInterval(evTick, 60000);
async function evEnd(id) {
  const e = evs.get(id); if (!e) return; evs.delete(id); clearTimeout(e.timer); evSoon(); rosterSoon();
  const K = EV_KIND[e.kind], others = [...e.parts].filter(k => k !== e.host), n = others.length, crowd = (n + 1 >= 5 ? 2 : n + 1 >= 3 ? 1 : 0) + (e.mega && n ? 1 : 0);
  try {
    if (e.kind === 'cup') {
      const top = [...e.board.entries()].sort((a, b) => b[1].r - a[1].r);
      for (const [k] of top) await lockDo(k, async () => { await medAdd(k, 1, '월척 대회 참가'); const s = await loadSave(k); if (s) { const en = enhOf(s), out = []; enhDaily(en, out); enhAddPiece(en, 2, out); queueSave(k, s); const l = liveByKey(k); if (l) sendEnh(l[0], l[1], { note: out }); } });
      if (top.length >= 2) {
        for (let i = 0; i < Math.min(3, top.length); i++) { const [k] = top[i]; await lockDo(k, async () => {
          if (i === 0) { await evTk(k, 2, '🏆 월척 대회 우승! 강화권 +{n}'); await medAdd(k, 3, '월척 대회 우승'); await giveCosTo(k, ['t_cup']); }
          else { await evTk(k, 1, '🏆 월척 대회 ' + (i + 1) + '등! 강화권 +{n}'); await medAdd(k, 2, '월척 대회 ' + (i + 1) + '등'); } }); }
        broadcast({ t: 'news', text: '🏆 월척 대회 끝! 1등 ' + top[0][1].name + ' 님 (평균보다 ' + Math.round(top[0][1].r * 100) + '% 크기)' + (top[1] ? ' · 2등 ' + top[1][1].name : '') + (top[2] ? ' · 3등 ' + top[2][1].name : '') + ' · 참가 ' + top.length + '명' });
      } else broadcast({ t: 'news', text: '🏆 ' + e.hostName + ' 님의 월척 대회가 끝났어요. 다음엔 둘 이상 모이면 순위 상이 나와요!' });
      wkAdd('cup', top.length);
    }
    if (e.kind === 'bounty' && !e.win) broadcast({ t: 'news', text: '🎯 ' + e.hostName + ' 박사의 현상수배는 아무도 해결하지 못했어요…' });
    if (e.kind === 'stall') broadcast({ t: 'news', text: '🍢 ' + e.hostName + ' 님의 포장마차가 문을 닫았어요 · ' + e.sold + '그릇 · 손님 ' + n + '명' });
    if (e.kind === 'play') broadcast({ t: 'news', text: '🐾 ' + e.hostName + ' 님의 펫 놀이터가 끝났어요 · 놀러 온 친구 ' + n + '명' });
    if (e.kind === 'auc') {
      let sum = 0, sold = 0; const res = [];
      for (let i = 0; i < e.lots.length; i++) {
        const l = e.lots[i]; if (!l.by) continue; sum += l.bid; sold++; res.push(l.byName + ' ' + l.bid + '골드');
        await lockDo(l.by, async () => {
          const s = await loadSave(l.by); if (s) holdDel(s, e.id, i);
          if (l.k === 'cos') { await giveCosTo(l.by, [l.id]); addMail(l.by, '🔔 반짝 장터 낙찰! 새 칭호를 받았어요 (' + l.bid + '골드)'); }
          else await changeBag(l.by, { ['i:' + l.id]: l.n }, '🔔 반짝 장터 낙찰! ' + ITEM_NAME[l.id] + ' ×' + l.n + ' (' + l.bid + '골드)');
          helpAdd(e.host, l.byName, '반짝 장터에서 물건을 샀어요').catch(() => { });
        });
      }
      const fee = Math.floor(sum * .1);
      if (fee) await lockDo(e.host, () => changeBag(e.host, { g: fee }, '🔔 반짝 장터 수수료 +' + fee + '골드'));
      broadcast({ t: 'news', text: '🔔 ' + e.hostName + ' 님의 반짝 장터 끝! ' + (res.length ? '낙찰: ' + res.join(' · ') : '이번엔 낙찰이 없었어요') });
      wkAdd('auc', sold);
    }
    // 사람이 많이 모일수록 모두에게 도토리 더 (3명 +1 · 5명 +2 · 확성기 +1)
    if (crowd) for (const k of others) await lockDo(k, () => medAdd(k, crowd, '북적북적 보너스'));
    await lockDo(e.host, async () => {
      if (n >= 2) await evTk(e.host, 1, K.ic + ' 「' + K.name + '」 주최 보상! 강화권 +{n}');
      if (n) await medAdd(e.host, Math.min(5, n) + crowd, '「' + K.name + '」에 친구 ' + n + '명');
    });
    await giveJxp(e.host, K.job, 20 + Math.min(100, n * 10), n ? K.ic + ' 내 「' + K.name + '」에 친구 ' + n + '명이 함께했어요! 숙련도 +' + (20 + Math.min(100, n * 10)) : null);
  } catch (er) { console.error('ev_end', er.message); }
}

/* ---------- 은비랜드: 골드 → 칩 (한 방향) · 슬롯 · 거북이 경주 · 하이로우 · 경품 교환소 ----------
   결과는 전부 서버가 정해요. 칩은 골드로 되돌릴 수 없어서 골드가 빠져나가는 곳이에요 (게임 평균 환급 약 90%).
   칩을 쓰는 이유: 은비랜드에서만 파는 치장 · 칭호, VIP 등급과 매일 보너스, 마을 전체 잭팟. index.html EB와 같아야 해요 */
const EB = {
  RATE: 10, BUY_DAY: 20000, BETS: [10, 50, 100, 500, 1000, 5000, 10000],
  SLOT_W: [30, 24, 18, 12, 8, 4], SLOT3: [5, 10, 24, 60, 150, 0], SLOT2: [0, .4, .7, 1, 2, 4], JP_CUT: .03, JP_BASE: 2000,
  RACE_W: [.34, .26, .18, .13, .09], RACE_X: [2.6, 3.5, 5, 6.9, 10],
  /* 🎡 은비 룰렛 (2026-11-10): 20칸 = 빨강 9 · 파랑 9 · 황금 2 → 빨강/파랑 ×2 · 황금 ×9 (모두 환급 90%) · 거북이 경주 · 하이로우는 문 닫음 */
  WHEEL: ['g', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'g', 'b', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b'], WHEEL_X: { r: 2, b: 2, g: 9 },
  VIP: [[5000, '브론즈', 50], [30000, '실버', 200], [150000, '골드', 800], [600000, '다이아', 2000]],
  SHOP: { ebcrown: 40000, ebsuit: 60000, ebwings: 80000, hc20: 20000, hc21: 20000, t_ebvip: 30000 }
};
let ebJP = EB.JP_BASE;
/* 사냥 장비 칩 값 (index.html HUNT_PRICE와 같아요) */
const HUNT_PRICE = { w: [0, 3e5, 8e5, 1.5e6, 3e6, 6e6, 1.2e7, 2.5e7, 5e7, 1e8], a: [0, 3e5, 8e5, 1.5e6, 3e6, 6e6, 1.2e7, 2.5e7, 5e7, 1e8], b: [0, 8e5, 2.5e6, 6e6, 1.5e7, 4e7] }, HPOT_PRICE = 3e5;   // 2026-11-09: 사냥은 최상위 콘텐츠 (첫 단계 50만 칩부터)
const ebOf = s => { const e = s.eb && typeof s.eb === 'object' ? s.eb : (s.eb = { c: 0, d: '', buy: 0, wag: 0, best: 0, vd: '' }); if (e.d !== kstDay()) { e.d = kstDay(); e.buy = 0; e.loss = 0; e.cons = 0; } return e; };
/* 크게 잃은 날을 위한 마음 쓰기: 오늘 순손실 5,000칩마다 은비가 10%를 위로 칩으로 돌려주고, 30,000칩을 잃으면 그날은 쉬어 가요 */
const EB_CONS = 5000, EB_LOSS_CAP = Infinity;   // 2026-11-09: 하루 룰렛 한도 없음
const ebCap = s => 1e12;   // 2026-11-09: 칩 바꾸기 한도 없음 (사냥 장비는 칩으로만)   // VIP일수록 하루에 더 바꿀 수 있어요
const ebVip = wag => { let t = -1; EB.VIP.forEach((v, i) => { if (wag >= v[0]) t = i; }); return t; };
const ebPub = (s, me) => { const e = ebOf(s); return { t: 'eb', c: e.c | 0, buy: e.buy | 0, wag: e.wag | 0, best: e.best | 0, vip: ebVip(e.wag | 0), cap: ebCap(s), vd: e.vd === kstDay(), jp: Math.floor(ebJP), card: me.hiCard || 0 }; };
function ebPick(w) { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return w.length - 1; }
function ebMsg(ws, me, m) {
  withLock(me.key, async () => {
    const s = me.save; if (!s) return; const e = ebOf(s), err = text => send(ws, { t: 'eb_err', text }), done = extra => { queueSave(me.key, s); send(ws, Object.assign(ebPub(s, me), extra || {})); };
    if (m.t === 'eb_info') { if (!me.hiCard) me.hiCard = 1 + Math.floor(Math.random() * 13); return done(); }
    if (m.t === 'eb_vip') { const t = ebVip(e.wag | 0); if (t < 0) return err('VIP 브론즈부터 받을 수 있어요'); if (e.vd === kstDay()) return err('오늘 보너스는 이미 받았어요'); e.vd = kstDay(); const n = EB.VIP[t][2]; e.c += n; return done({ win: n, note: 'VIP ' + EB.VIP[t][1] + ' 오늘의 보너스 칩 +' + n }); }
    if (m.t === 'eb_buy') {
      const n = Math.floor(Number(m.n) || 0), cap = ebCap(s); if (n < 10 || n > cap) return;
      if ((e.buy | 0) + n > cap) return err('오늘은 ' + fmtN(cap - (e.buy | 0)) + '칩까지 바꿀 수 있어요');
      const g = n * EB.RATE; if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
      await changeBag(me.key, { g: -g }, null); e.buy = (e.buy | 0) + n; e.c = (e.c | 0) + n; return done({ note: '칩 ' + fmtN(n) + '개로 바꿨어요' });
    }
    if (m.t === 'eb_shop') {
      const id = String(m.id || ''), price = EB.SHOP[id]; if (!price) return; const own = (s.cos && s.cos.own) || [];
      if (own.includes(id)) return err('이미 가지고 있어요'); if ((e.c | 0) < price) return err('칩이 모자라요');
      e.c -= price; const got = giveCos(s, [id]); send(ws, { t: 'cos_got', ids: got }); return done({ note: '경품 교환 완료!' });
    }
    if (m.t === 'eb_race' || m.t === 'eb_hilo') return err('🐢🃏 그 게임은 문을 닫았어요 · 🎡 룰렛을 즐겨 봐요');
    { const now2 = Date.now(), gap = m.t === 'eb_wheel' ? 3600 : 2200; if (now2 - (me.ebSpinT || 0) < gap) return err('🎰 잠깐만요, 아직 돌아가는 중이에요'); me.ebSpinT = now2; }   // 🕰️ 연타 방지 (서버에서도)
    if (m.t === 'eb_wheel' && !['r', 'b', 'g'].includes(m.pick)) return;
    const bet = m.bet | 0; if (!EB.BETS.includes(bet)) return; if ((e.c | 0) < bet) return err('칩이 모자라요');
    if ((e.loss | 0) >= EB_LOSS_CAP) return err('🐰 은비: 오늘은 여기까지! 내일 다시 놀러 와요 (하루에 잃을 수 있는 칩을 다 썼어요)');
    e.c -= bet; e.wag = (e.wag | 0) + bet; const v0 = ebVip(e.wag - bet), v1 = ebVip(e.wag);
    let win = 0, extra = {};
    if (m.t === 'eb_slot') {
      ebJP += bet * EB.JP_CUT; vMark(); const r = [ebPick(EB.SLOT_W), ebPick(EB.SLOT_W), ebPick(EB.SLOT_W)];
      if (r[0] === r[1] && r[1] === r[2]) {
        if (r[0] === 5) { win = Math.floor(ebJP * Math.min(1, bet / 500)); ebJP = Math.max(EB.JP_BASE, ebJP - win); extra.jack = true; const got = giveCos(s, ['t_jackpot']); if (got.length) send(ws, { t: 'cos_got', ids: got }); broadcast({ t: 'news', text: '🎰 잭팟!! ' + me.name + ' 님이 은비랜드에서 ' + fmtN(win) + '칩을 터뜨렸어요!' }); }
        else win = Math.floor(bet * EB.SLOT3[r[0]]);
      } else { const c = {}; r.forEach(x => c[x] = (c[x] | 0) + 1); for (const x in c) if (c[x] === 2) win = Math.floor(bet * EB.SLOT2[x]); }
      extra.reels = r;
    } else if (m.t === 'eb_wheel') {
      const seg = (Math.random() * EB.WHEEL.length) | 0, col = EB.WHEEL[seg]; if (col === m.pick) win = Math.floor(bet * EB.WHEEL_X[col]); extra.wheel = { seg, pick: m.pick };
      if (col === 'g' && win && bet >= 500) broadcast({ t: 'news', text: '🎡✨ ' + me.name + ' 님이 은비 룰렛 황금 칸을 맞혔어요! +' + fmtN(win) + '칩' });
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
    e.loss = (e.loss | 0) + bet - win; const step = Math.floor(Math.max(0, e.loss) / EB_CONS);
    if (step > (e.cons | 0)) { const back = (step - (e.cons | 0)) * EB_CONS / 10; e.cons = step; e.c += back; extra.note = '🐰 은비의 위로 칩 +' + fmtN(back) + ' · 오늘은 운이 조금 없네요'; }
    ebRecord(me.name, m.t.slice(3), bet, win, !!extra.jack);
    if (win >= 5000 && !extra.jack) broadcast({ t: 'news', text: '🎰 ' + me.name + ' 님이 은비랜드에서 ' + fmtN(win) + '칩을 땄어요!' }, ws);
    if (v1 > v0) extra.note = '🎉 은비랜드 VIP ' + EB.VIP[v1][1] + ' 등급이 됐어요!';
    done(Object.assign(extra, { bet, win }));
  }).catch(er => console.error('eb', er.message));
}
const fmtN = n => Math.round(n).toLocaleString('ko-KR');
/* 🏆 순위 (2026-11-05): 도감 · 은비랜드 · 강화소 · 직업 어디서든 짧게. 은비랜드 최고 당첨 · 최근 대박은 마을 기록(__village)에 남아요 */
function ebRecord(name, game, bet, win, jack) {
  if (!V || !(win > 0)) return; const top = V.ebTop && typeof V.ebTop === 'object' ? V.ebTop : (V.ebTop = {});
  if (win > (top[name] | 0)) { top[name] = win; vMark(); }
  if (jack || win >= Math.max(20000, bet * 10)) { const L = Array.isArray(V.ebLog) ? V.ebLog : (V.ebLog = []); L.unshift({ n: name, g: game, w: win, b: bet, jk: jack ? 1 : 0, at: Date.now() }); L.length = Math.min(L.length, 15); vMark(); }
}
function rankOf(k, me) {
  const top = (arr) => { arr.sort((a, b) => b.v - a.v); const i = arr.findIndex(x => x.n === me.name); return { top: arr.slice(0, 10), me: i >= 0 ? { r: i + 1, v: arr[i].v } : null, total: arr.length }; };
  if (k === 'sd') return top([...rosterCache.values()].map(r => ({ n: r.name, v: r.sd | 0 })).filter(x => x.v > 0));
  const RV = { sh: r => r.sh | 0, gt: r => r.gt | 0, dex: r => (r.dex || []).length, hunt: r => r.hl | 0, vl: r => r.lv | 0, help: r => r.help | 0 };
  if (RV[k]) return top([...rosterCache.values()].map(r => ({ n: r.name, v: RV[k](r) })).filter(x => x.v > 0));
  if (k === 'enh') return top([...rankCache.values()].map(r => ({ n: r.name, v: r.lv | 0, m: r.max | 0 })).filter(x => x.v > 0));
  if (k === 'eb') return Object.assign(top(Object.entries((V && V.ebTop) || {}).map(([n, v]) => ({ n, v }))), { log: ((V && V.ebLog) || []).slice(0, 10) });
  if (k.startsWith('job:')) { const j = k.slice(4); if (!MAKER_JOBS.includes(j)) return null; return top([...rosterCache.values()].filter(r => r.job === j && (r.jx | 0) > 0).map(r => ({ n: r.name, v: r.jx | 0 }))); }
  return null;
}

/* ---------- 마을 공동 기록: 발전 기금 · 주간 마을 목표 · 행사 예약 · 잭팟 (DB의 '__village' 줄에 저장) ---------- */
const VKEY = '__village';
let V = null, vDirty = false, vT = 0;
const vDefault = () => ({ fund: { g: 0, st: 0 }, don: {}, wk: null, rsv: [], jp: 0 });
/* 발전 기금으로 짓는 축제 광장 시설 (순서대로). index.html VF와 같아야 해요 */
const VF = [
  { id: 'fountain', name: '분수', g: 5e6, eff: '행사 도토리 하루 상한 +2' },
  { id: 'stage', name: '축제 무대', g: 1e7, eff: '모든 행사 시간 +10분' },
  { id: 'carousel', name: '회전목마', g: 2e7, eff: '주간 마을 목표를 다 채우면 강화권 +1 더' },
  { id: 'tower', name: '등대 전망대', g: 3e7, eff: '함께 접속 보너스 행운 +5% → +10%' },
  /* 2026-11-11: 부자 마을의 큰 꿈 (골드 쓸 곳) */
  { id: 'wheel', name: '물결 대관람차', g: 1e8, eff: '낚시터의 물빛 포인트가 하나 더' },
  { id: 'garden', name: '별빛 온실', g: 2e8, eff: '냥이를 만나면 선물을 더 자주 · 하트 +2' },
  { id: 'fire', name: '불꽃놀이 탑', g: 3e8, eff: '매일 밤 9시 10분 동안 불꽃놀이 · 그동안 반짝 ×1.5' },
  { id: 'gate', name: '용사의 성문', g: 5e8, eff: '주간 레이드 보상 +50%' }];
const vSt = () => V ? V.fund.st | 0 : 0;
const fireOn = () => { if (vSt() < 7) return false; const d = new Date(Date.now() + 9 * 3600e3); return d.getUTCHours() === 21 && d.getUTCMinutes() < 10; };   // 🎆 불꽃놀이 탑
const vEvExtra = () => vSt() >= 2 ? 10 : 0;
const togLuck = () => vSt() >= 4 ? .10 : .05;
function vMark() { vDirty = true; }
/* ---------- 🏅 주간 낚시 대회 · 🎁 친구 선물 (2026-11-09) ---------- */
const WF_IDS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97];   // index.html과 같아요
const wfWeek = () => Math.floor((Date.now() + 9 * 3600e3 - Date.UTC(2026, 0, 5)) / (7 * 864e5)), wfId = w => WF_IDS[((w % WF_IDS.length) + WF_IDS.length) % WF_IDS.length];
function wfState() { const w = wfWeek(); V.wf = V.wf && typeof V.wf === 'object' ? V.wf : { w, top: {} }; V.wfHist = Array.isArray(V.wfHist) ? V.wfHist : [];
  if (V.wf.w !== w) { const tops = Object.entries(V.wf.top || {}).sort((a, b) => b[1] - a[1]); if (tops.length) V.wfHist.unshift({ w: V.wf.w, id: wfId(V.wf.w), n: tops[0][0], len: tops[0][1], top3: tops.slice(0, 3) }); if (V.wfHist.length > 30) V.wfHist.length = 30; V.wf = { w, top: {} }; vMark(); }
  return V.wf; }
const wfPub = () => { const S = wfState(); return { w: S.w, id: wfId(S.w), top: Object.entries(S.top).sort((a, b) => b[1] - a[1]).slice(0, 10), hist: V.wfHist.slice(0, 10), ends: Date.UTC(2026, 0, 5) + (S.w + 1) * 7 * 864e5 - 9 * 3600e3 }; };
async function socMsg(ws, me, m) {
  const s = me.save; if (!s || !V) return; const no = msg => send(ws, { t: 'news', text: msg }), now = Date.now();
  if (m.t === 'wf_get') return send(ws, Object.assign({ t: 'wf' }, wfPub()));
  if (m.t === 'wf_catch') { const S = wfState(), len = Math.max(1, Math.min(5000, m.len | 0)); if ((m.id | 0) !== wfId(S.w)) return; if (now - (me.wfT || 0) < 3000) return; me.wfT = now;
    const prev = S.top[me.name] | 0; if (len <= prev) return; const was = Object.entries(S.top).sort((a, b) => b[1] - a[1])[0]; S.top[me.name] = len; vMark();
    if (!was || len > was[1]) broadcast({ t: 'news', text: '🏅 주간 낚시 대회 1위가 바뀌었어요! ' + me.name + ' 님 ' + len + 'cm' });
    return send(ws, Object.assign({ t: 'wf', note: '🏅 주간 대회 기록 ' + len + 'cm 등록!' }, wfPub())); }
  if (m.t === 'wf_claim') { wfState(); const got = s.wfc && typeof s.wfc === 'object' ? s.wfc : (s.wfc = {}); const h = V.wfHist.find(x => x.n === me.name && !got[x.w]); if (!h) return no('받을 우승 상이 없어요');
    got[h.w] = 1; const cos = giveCos(s, ['t_wfchamp']); queueSave(me.key, s); await flushSave(me.key); await changeBag(me.key, { g: 30000000 }, '🏅 주간 낚시 대회 우승 상금'); if (cos.length) send(ws, { t: 'cos_got', ids: cos }); return send(ws, Object.assign({ t: 'wf' }, wfPub())); }
  V.gifts = V.gifts && typeof V.gifts === 'object' ? V.gifts : {};
  if (m.t === 'gift_list') return send(ws, { t: 'gifts', list: V.gifts[me.name] || [] });
  if (m.t === 'gift_send') {   // 골드 · 주문서만 보낼 수 있어요 (물고기는 각자 직접!)
    const to = cleanText(m.to, 12); if (!to || to === me.name) return no('받을 친구 이름을 적어 주세요'); const known = [...rosterCache.values()].some(r => r.name === to); if (!known) return no('그 이름의 주민을 찾지 못했어요');
    if (now - (me.gfT || 0) < 5000) return no('조금 있다가 다시 보내요'); const g = Math.max(0, Math.min(1e9, Math.floor(+m.g || 0))), sc = String(m.sc || ''), scN = Math.max(0, Math.min(50, m.n | 0)), note = cleanText(m.note, 40);
    const h = s.hunt || {}; const SC = h.scr || {}; if (!g && !(sc && scN)) return no('보낼 것을 골라요');
    if (g && (s.gold | 0) < g) return no('골드가 모자라요'); if (sc && scN && (!/^[wa](100|60|10)$/.test(sc) || (SC[sc] | 0) < scN)) return no('주문서가 모자라요');
    const box = V.gifts[to] = V.gifts[to] || []; if (box.length >= 30) return no(to + ' 님 우편함이 가득 찼어요'); me.gfT = now;
    if (sc && scN) { SC[sc] -= scN; queueSave(me.key, s); } if (g) await changeBag(me.key, { g: -g }, null);
    box.push({ id: now.toString(36) + Math.random().toString(36).slice(2, 5), from: me.name, g, sc: sc && scN ? sc : '', n: sc && scN ? scN : 0, note, at: now }); vMark();
    const L = liveByName(to); if (L) send(L[0], { t: 'gift_new', from: me.name }); return send(ws, { t: 'news', text: '🎁 ' + to + ' 님에게 선물을 보냈어요!' }); }
  if (m.t === 'gift_take') { const box = V.gifts[me.name] || [], i = box.findIndex(x => x.id === String(m.id || '')); if (i < 0) return; const x = box.splice(i, 1)[0]; vMark();
    if (x.sc && x.n) { const h = s.hunt && typeof s.hunt === 'object' ? s.hunt : (s.hunt = { w: 0, a: 0, b: 0, sw: 0 }); h.scr = h.scr || {}; h.scr[x.sc] = (h.scr[x.sc] | 0) + x.n; queueSave(me.key, s); send(ws, { t: 'rpg', hunt: h }); }
    if (x.g) { await flushSave(me.key); await changeBag(me.key, { g: x.g }, '🎁 ' + x.from + ' 님의 선물'); }
    return send(ws, { t: 'gifts', list: box, took: x }); }
}
/* ---------- 🗡️ 물결 RPG 장비 (2026-11-09): 8부위 · 7등급 · 랜덤 옵션 · 주문서 강화(리니지식 증발) · 재료 제작 · 낚시 드랍 ---------- */
const RPG_SLOTS = ['w', 'a', 'h', 'r', 'g', 's', 'c', 'n'], RPG_MAIN = { w: 'atk', a: 'def', h: 'hp', g: 'atk', s: 'spd', c: 'def', r: 'cri', n: 'luk' }, RPG_SUB = ['atk', 'def', 'hp', 'cri', 'spd', 'luk', 'chip', 'dr'];
const RPG_GN = ['일반', '고급', '희귀', '영웅', '전설', '신화', '태초', '무한', '창세'], RPG_SN = { w: '무기', a: '갑옷', h: '모자', r: '반지', g: '장갑', s: '신발', c: '망토', n: '목걸이' }, RPG_WT = ['ham', 'net', 'gun', 'wand', 'bow', 'bomb'];
const RPG_MATS = ['teddy', 'fluff', 'chick', 'donut', 'choco', 'shell', 'star', 'fogc', 'ice', 'ribbon'];
const rollG = w => { const tot = w.reduce((a, b) => a + b, 0); let x = Math.random() * tot; for (let g = 0; g < w.length; g++) { x -= w[g]; if (x <= 0) return g; } return 0; };
function mkItem(tier, g, sl) {
  tier = Math.max(0, Math.min(10, tier | 0)); g = Math.max(0, Math.min(8, g | 0)); sl = RPG_SLOTS.includes(sl) ? sl : ['w', 'w', 'w', 'a', 'a', 'h', 'r', 'g', 's', 'c', 'n'][(Math.random() * 11) | 0];
  const it = { t: sl, g, b: [1, 2, 3, 5, 8, 13, 21, 34, 55][g] + Math.floor(tier / 2) * (g >= 7 ? 2 : 1), n: tier, v: (Math.random() * 5) | 0, e: 0, o: [], rq: 0 }; it.rq = rqOf(tier, g);
  if (sl === 'w') it.wt = RPG_WT[(Math.random() * RPG_WT.length) | 0];
  const no = [0, 1, 1, 2, 2, 3, 4, 5, 6][g], pool = RPG_SUB.slice(); for (let i = 0; i < no; i++) { const k = pool.splice((Math.random() * pool.length) | 0, 1)[0]; it.o.push([k, Math.max(1, Math.round((1 + tier * .4) * (1 + g * .4) * (.4 + Math.random() * .6)))]); }
  return it;
}
const enhB = it => (it.e | 0) * Math.max(1, Math.ceil((it.b | 0) * .15)) + (it.up | 0);
/* 📜 메이플식 주문서: 무기 주문서(무기) · 방어구 주문서(그 외) · 100%(+1) 60%(+2) 10%(+5) × 장비 계열 · 장비마다 업그레이드 가능 횟수 */
const SCR_P = { 100: 1, 60: .6, 10: .1 }, SCR_G = { 100: 1, 60: 2, 10: 5 }, SCR_SLOTS = [5, 6, 7, 7, 8, 9, 10, 12, 15], SCR_PRICE = { 100: 3e5, 60: 8e5, 10: 1.5e6 };
const scrKind = it => it.t === 'w' ? 'w' : 'a', scrLeft = it => it.us === undefined ? SCR_SLOTS[it.g | 0] : it.us | 0;
function scrMig(h) { const S = h.scr && typeof h.scr === 'object' ? h.scr : (h.scr = {}); if (h.sc) { S.w100 = (S.w100 | 0) + (h.sc | 0); h.sc = 0; } if (h.bsc) { S.w60 = (S.w60 | 0) + (h.bsc | 0); h.bsc = 0; } if (h.mat) { let n = 0; for (const k in h.mat) n += h.mat[k] | 0; if (n) S.a100 = (S.a100 | 0) + Math.ceil(n / 3); delete h.mat; } return S; }
const rollScr = () => { const x = Math.random() * 100, p = x < 60 ? 100 : x < 92 ? 60 : 10; return (Math.random() < .45 ? 'w' : 'a') + p; };
const IT_REQ_G = [0, 1, 3, 6, 10, 15, 22, 30, 40], rqOf = (n, g) => 1 + (n | 0) * 4 + (IT_REQ_G[g | 0] | 0), itReq = it => it.rq != null ? it.rq | 0 : 1;   // 레벨 제한은 새로 나온 장비부터 (예전 장비는 제한 없음)   // 🎚️ 착용 레벨: 계열(n)·등급(g)이 높을수록 용사 레벨이 필요
/* 💪 전투력 (index.html cpCalc와 같아요) */
function cpOf(save) { if (!save || !save.hu) return 0; const lv = Math.max(1, save.hu.lv | 0), h = save.hunt && typeof save.hunt === 'object' ? save.hunt : {}, R = rpgSum(h, lv); const atk = 2 + lv + (h.sw ? 3 : 0) + R.atk, def = Math.floor(lv * .4) + R.def, hp = 30 + lv * 6 + R.hp * 4, cri = Math.min(1, .1 + R.cri * .02), spd = Math.min(60, R.spd * 1.5); return Math.round(atk * (1 + cri) * 10 + def * 15 + hp * 1.2 + spd * 4 + lv * 20); }
function rpgSum(h, lv) { const S = { atk: 0, def: 0, hp: 0, cri: 0, spd: 0, luk: 0, chip: 0, dr: 0 }; const inv = Array.isArray(h.inv) ? h.inv : []; for (const k of RPG_SLOTS) { const it = inv[h['eq' + k]]; if (!it || it.t !== k) continue; if (lv != null && itReq(it) > lv) continue; S[RPG_MAIN[k]] += (it.b | 0) + enhB(it); for (const o of it.o || []) if (S[o[0]] !== undefined) S[o[0]] += o[1] | 0; } return S; }
function invPut(h, item) { h.inv = Array.isArray(h.inv) ? h.inv : []; h.inv.push(item); if (h.inv.length <= 60) return; const eqs = RPG_SLOTS.map(k => h['eq' + k]); let lo = -1; h.inv.forEach((x2, i2) => { if (!eqs.includes(i2) && (lo < 0 || x2.g * 100 + x2.b < h.inv[lo].g * 100 + h.inv[lo].b)) lo = i2; }); if (lo >= 0) invDel(h, lo); }
function invDel(h, i) { h.inv.splice(i, 1); for (const k of RPG_SLOTS) { const ek = 'eq' + k; if (h[ek] === i) h[ek] = null; else if (h[ek] > i) h[ek]--; } }
const ZT = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 3, 6: 4, 7: 4, 8: 4, 9: 4, 10: 5, 11: 5, 12: 5, 13: 6, 14: 6, 15: 7, 16: 7, 17: 7, 18: 8, 19: 8, 20: 6, 21: 9 };
const RPG_RECIPES = { weap: [{ teddy: 5, ice: 6 }, 'w', 2], armor: [{ chick: 6, ice: 4, fluff: 6 }, 'a', 2], hat: [{ fluff: 10, teddy: 2 }, 'h', 2], glove: [{ chick: 5, fluff: 5 }, 'g', 1], boot: [{ shell: 6, ribbon: 3 }, 's', 1], cape: [{ fogc: 6, ribbon: 4 }, 'c', 2], ring: [{ donut: 3, choco: 8 }, 'r', 2], neck: [{ star: 15, shell: 5 }, 'n', 3], sc: [{ fogc: 4, fluff: 4 }, 'sc'], bsc: [{ star: 25, ribbon: 6, teddy: 3 }, 'bsc'] };
async function rpgMsg(ws, me, m) {
  const s = me.save; if (!s) return; const h = s.hunt && typeof s.hunt === 'object' ? s.hunt : (s.hunt = { w: 0, a: 0, b: 0, sw: 0 }); h.inv = Array.isArray(h.inv) ? h.inv : []; const mat = h.mat && typeof h.mat === 'object' ? h.mat : (h.mat = {}); const now = Date.now();
  const out = x => { queueSave(me.key, s); send(ws, Object.assign({ t: 'rpg', hunt: h }, x)); };
  if (m.t === 'fdrop') {   // 🎣 낚시하다 딸려 올라오는 것들
    if (now - (me.fdT || 0) < 2500) return; me.fdT = now; const r = Math.max(0, Math.min(4, m.rar | 0)), z = m.z | 0, tier = ZT[z] | 0, hsB = hsBoost(me, 'loot') ? 2 : 1, luk = (1 + Math.min(100, rpgSum(h, (s.hu && s.hu.lv) | 0 || 1).luk) / 100) * hsB, got = [];
    const SC = scrMig(h); if (Math.random() < (.07 + r * .015) * luk) { const id = rollScr(); SC[id] = (SC[id] | 0) + 1; got.push({ k: 'scr', id }); }
    if (Math.random() < (.02 + r * .008) * luk) { const it = mkItem(tier, rollG([55, 26, 12, 5, 1.6, .35, .05, .006, .0007])); invPut(h, it); got.push({ k: 'item', item: it }); if (it.g >= 7) broadcast({ t: 'news', text: '🌌🌌 ' + me.name + ' 님 낚싯줄에 전설 너머의 【' + RPG_GN[it.g] + '】 ' + RPG_SN[it.t] + '이(가)!!! 마을이 술렁여요' }); else if (it.g >= 4) broadcast({ t: 'news', text: '🎣🎁 ' + me.name + ' 님 낚싯줄에 ' + RPG_GN[it.g] + ' ' + RPG_SN[it.t] + '이(가) 걸려 올라왔어요!' }); }
    if (Math.random() < .002 * luk) { const own = (s.cos && s.cos.own) || [], pool = TRAP_SKINS.concat(TRAP_FLAGS).filter(id => id !== 'tp_bamboo' && id !== 'tf_none' && !own.includes(id)); if (pool.length) { const id = pool[(Math.random() * pool.length) | 0]; giveCos(s, [id]); got.push({ k: 'cos', id }); send(ws, { t: 'cos_got', ids: [id] }); broadcast({ t: 'news', text: '🎣✨ ' + me.name + ' 님이 낚시하다 통발 치장을 건졌어요!' }); } }
    if (!got.length) return; return out({ fd: got });
  }
  const i = m.i | 0, it = h.inv[i];
  if (m.t === 'it_dis') {   // 분해 → 꿈조각
    if (!it || RPG_SLOTS.some(k => h['eq' + k] === i)) return; const n = Math.round([1, 2, 4, 8, 16, 40, 120, 500, 2000][it.g] * (1 + (it.e | 0) * .2)); h.dr = (h.dr | 0) + n; let sc = 0; if (Math.random() < (it.g + 1) / 14) { const SC = scrMig(h), id = rollScr(); SC[id] = (SC[id] | 0) + 1; sc = id; }
    invDel(h, i); return out({ note: '🔨 분해했어요 · 꿈조각 +' + n + (sc ? ' · 📜 ' + (sc[0] === 'w' ? '무기' : '방어구') + ' 주문서 ' + sc.slice(1) + '% +1' : '') });
  }
  if (m.t === 'sc_buy') { const id = String(m.k || ''), p = +id.slice(1), n = Math.max(1, Math.min(10, m.n | 0)); if (!/^[wa](100|60|10)$/.test(id)) return; const e = ebOf(s), cost = SCR_PRICE[p] * n; if ((e.c | 0) < cost) return out({ note: '칩이 모자라요 (은비랜드에서 골드를 칩으로 바꿔요)' }); e.c -= cost; const SC = scrMig(h); SC[id] = (SC[id] | 0) + n; return out({ note: '📜 ' + (id[0] === 'w' ? '무기' : '방어구') + ' 주문서 ' + p + '% ×' + n + ' 샀어요', c: e.c }); }
  if (m.t === 'it_scr') {   // 📜 주문서 바르기: 성공·실패 모두 업그레이드 횟수 1 소모
    if (!it) return; const p = [100, 60, 10].includes(m.p | 0) ? m.p | 0 : 100, id = scrKind(it) + p, SC = scrMig(h); if ((SC[id] | 0) < 1) return out({ note: '그 주문서가 없어요' }); const left = scrLeft(it); if (left < 1) return out({ note: '업그레이드 가능 횟수를 다 썼어요' });
    SC[id]--; it.us = left - 1; const ok = Math.random() < SCR_P[p], gain = SCR_G[p] * (1 + Math.floor((it.n | 0) / 3));
    if (ok) { it.up = (it.up | 0) + gain; it.u = (it.u | 0) + 1; if (p === 10) broadcast({ t: 'news', text: '📜✨ ' + me.name + ' 님이 10% 주문서에 성공했어요! (' + RPG_GN[it.g] + ' ' + RPG_SN[it.t] + ')' }); }
    return out({ scr: { ok: ok ? 1 : 0, gain, p, left: it.us } });
  }
}
/* ---------- 💒 물결 예식장: 혼인 신고 · 10분 결혼식 · 영원한 방명록 · 반지로 곁에 가기 ---------- */
const WED_OUT = ['o_tux', 'o_wdress'], RING_IDS = ['ring_silver', 'ring_pearl', 'ring_dia', 'ring_star', 'ring_rainbow'], FAIRY_XY = [65 * 16 + 8, 4 * 16 + 12], WED_LEN = 600000;
let MARP = null, WLIVE = null;

/* ---------- ✨ 물빛 포인트 (2026-11-10): 낚시터 물 위에 가끔 빛나는 자리 · 모두에게 똑같이 보여요 ----------
   찌가 포인트(가운데 ±1칸)에 떨어지면 효과: shiny 반짝 ×2 · giant 거대 ×2 · loot 장비·주문서 ×2 · myth 귀한 물고기 · school 입질 빨라요 · legend 전부
   후보 자리는 지도에서 미리 뽑은 물 칸 (index.html 지도와 같아요) */
const HS_TILES = [[4,22,1],[6,22,1],[2,23,1],[4,23,1],[6,23,1],[8,23,1],[2,24,1],[4,24,1],[6,24,1],[8,24,1],[2,25,1],[4,25,1],[6,25,1],[8,25,1],[4,26,1],[6,26,1],[32,17,2],[32,18,2],[32,19,2],[31,20,2],[32,20,2],[32,21,2],[32,22,2],[32,23,2],[32,24,2],[32,25,2],[32,26,2],[32,27,2],[54,38,3],[22,40,3],[52,40,3],[24,41,3],[51,41,3],[21,42,3],[43,42,3],[69,42,3],[34,43,3],[56,43,3],[25,44,3],[47,44,3],[14,45,3],[45,45,3],[14,46,3],[69,46,3],[4,50,4],[61,50,4],[22,51,4],[12,52,4],[12,53,4],[19,54,4],[22,55,4],[9,57,4],[13,58,4],[112,59,4],[166,59,4],[112,60,4],[160,60,4],[179,60,4],[115,61,4],[157,61,4],[14,3,5],[18,3,5],[12,4,5],[16,4,5],[20,4,5],[8,5,5],[12,5,5],[16,5,5],[20,5,5],[24,5,5],[10,6,5],[14,6,5],[18,6,5],[22,6,5],[10,7,5],[14,7,5],[9,64,6],[54,64,6],[48,65,6],[40,66,6],[19,67,6],[57,67,6],[58,68,6],[61,69,6],[35,71,6],[31,73,6],[1,76,6],[2,79,6],[1,84,6],[32,87,6],[29,90,6],[39,95,6],[12,101,7],[104,101,7],[153,101,7],[182,101,7],[119,102,7],[171,102,7],[109,103,7],[167,103,7],[111,104,7],[175,104,7],[10,108,7],[6,111,7],[11,113,7],[27,115,7],[9,118,7],[14,122,7],[2,43,8],[7,43,8],[2,44,8],[7,44,8],[2,45,8],[7,45,8],[3,46,8],[4,46,8],[5,46,8],[6,46,8],[4,47,8],[5,47,8],[10,76,9],[11,76,9],[10,77,9],[11,77,9],[24,74,10],[24,75,10],[24,76,10],[24,77,10],[24,78,10],[24,79,10],[24,80,10],[25,81,10],[25,84,10],[25,85,10],[24,86,10],[24,87,10],[24,88,10],[24,89,10],[24,90,10],[24,91,10],[5,93,11],[25,93,11],[29,93,11],[8,94,11],[26,94,11],[8,95,11],[26,95,11],[10,96,11],[14,96,11],[18,96,11],[22,96,11],[9,97,11],[13,97,11],[17,97,11],[21,97,11],[10,98,11],[79,15,12],[169,15,12],[139,31,12],[74,32,12],[77,32,12],[109,32,12],[73,33,12],[76,33,12],[79,33,12],[169,33,12],[75,34,12],[78,34,12],[139,34,12],[74,35,12],[77,35,12],[109,35,12],[41,75,13],[43,75,13],[45,75,13],[39,76,13],[41,76,13],[43,76,13],[45,76,13],[47,76,13],[39,77,13],[41,77,13],[43,77,13],[45,77,13],[47,77,13],[41,78,13],[43,78,13],[45,78,13],[56,72,14],[56,73,14],[56,74,14],[56,75,14],[56,76,14],[57,77,14],[57,78,14],[57,79,14],[57,80,14],[57,81,14],[56,82,14],[56,83,14],[56,85,14],[56,86,14],[56,87,14],[56,88,14],[82,64,15],[66,73,15],[88,75,15],[87,77,15],[68,79,15],[65,81,15],[82,82,15],[83,83,15],[66,85,15],[87,86,15],[69,88,15],[69,90,15],[70,92,15],[56,95,15],[56,96,15],[53,97,15],[117,76,16],[114,77,16],[116,77,16],[118,77,16],[120,77,16],[113,78,16],[115,78,16],[117,78,16],[119,78,16],[121,78,16],[113,79,16],[115,79,16],[117,79,16],[119,79,16],[121,79,16],[114,80,16],[99,64,17],[113,64,17],[127,64,17],[104,65,17],[97,66,17],[135,66,17],[95,68,17],[97,69,17],[139,70,17],[139,72,17],[93,90,17],[137,92,17],[95,94,17],[133,95,17],[134,96,17],[131,97,17],[171,75,18],[168,76,18],[170,76,18],[172,76,18],[174,76,18],[167,77,18],[169,77,18],[171,77,18],[173,77,18],[175,77,18],[167,78,18],[169,78,18],[171,78,18],[173,78,18],[175,78,18],[168,79,18],[149,64,19],[163,64,19],[180,64,19],[154,65,19],[187,65,19],[184,66,19],[185,67,19],[189,68,19],[146,70,19],[144,72,19],[192,89,19],[191,92,19],[149,94,19],[189,95,19],[189,96,19],[185,97,19],[81,42,20],[85,42,20],[78,43,20],[90,43,20],[76,45,20],[74,47,20],[73,48,20],[73,49,20],[95,50,20],[95,52,20],[74,54,20],[75,55,20],[77,57,20],[80,58,20],[81,59,20],[85,59,20]];
const HS_KINDS = [['shiny', 22], ['giant', 22], ['loot', 22], ['myth', 12], ['school', 20], ['legend', 2]], HS_NAME = { shiny: '✨ 반짝 물결', giant: '🌊 거대한 그림자', loot: '🎁 보물 거품', myth: '🔮 신비한 소용돌이', school: '🐟 물고기 떼', legend: '🌈 전설의 포인트' }, HS_USES = 6;
let HS = [], hsSeq = 1;
const hsPub = () => HS.map(h => ({ id: h.id, x: h.x, y: h.y, z: h.z, k: h.k, until: h.until }));
function hsTick() {
  const now = Date.now(), before = HS.length; HS = HS.filter(h => h.until > now); let ch = HS.length !== before;
  const want = 3 + (players.size >= 6 ? 1 : 0) + (vSt() >= 5 ? 1 : 0);
  while (HS.length < want) {
    let t = null; for (let k = 0; k < 30; k++) { const c = HS_TILES[(Math.random() * HS_TILES.length) | 0]; if (!HS.some(h => h.z === c[2] || Math.hypot(h.x - c[0], h.y - c[1]) < 12)) { t = c; break; } } if (!t) break;
    let r = Math.random() * 100, k = 'school'; for (const [kk, w] of HS_KINDS) { r -= w; if (r <= 0) { k = kk; break; } }
    const h = { id: hsSeq++, x: t[0], y: t[1], z: t[2], k, until: now + (180 + Math.random() * 120) * 1000, used: {} }; HS.push(h); ch = true;
    if (k === 'legend') broadcast({ t: 'news', text: '🌈 어딘가 낚시터에 전설의 포인트가 떠올랐어요!! 무지개 기둥을 찾아요' });
  }
  if (ch) broadcast({ t: 'hs', list: hsPub() });
}
setInterval(hsTick, 15000); setTimeout(hsTick, 2000);
function hsCast(ws, me, m) {
  if (m.off) { me.hsOn = null; return; }
  const h = HS.find(q => q.id === (m.id | 0)), now = Date.now(); if (!h || h.until < now) return send(ws, { t: 'hs_no', text: '포인트가 사라졌어요' });
  if (Math.max(Math.abs((m.x | 0) - h.x), Math.abs((m.y | 0) - h.y)) > 1) return;
  const n = h.used[me.key] | 0; if (n >= HS_USES) return send(ws, { t: 'hs_no', text: '이 포인트는 ' + HS_USES + '번 다 썼어요 · 다른 포인트를 찾아봐요' });
  h.used[me.key] = n + 1; me.hsOn = { k: h.k, until: now + 90000 };
  send(ws, { t: 'hs_ok', id: h.id, k: h.k, left: HS_USES - n - 1 });
}
/* ---------- 🍾 유리병 편지 (2026-11-11): 바다에 띄우면 누군가의 낚싯줄에 걸려요 · 이름은 비밀 · 답장도 다시 띄울 수 있어요 ---------- */
const BT_NPC = ['오늘 바다가 유난히 반짝였어요. 당신도 봤나요?', '낚시가 잘 안 되는 날도 있어요. 그래도 물소리는 늘 좋아요.', '이 편지를 주운 사람에게 작은 행운이 깃들기를.', '노을이 질 때 부두에 앉아 있으면 마음이 조용해져요.', '언젠가 같은 물가에서 만나요. 그때 인사해 줘요.', '고양이가 제 배에 몰래 탔어요. 지금 옆에서 자고 있어요.', '첫 반짝을 낚았던 날을 아직도 기억해요.', '오늘 하루도 수고했어요. 정말로요.', '비 오는 날의 낚시도 꽤 좋아요. 빗소리가 찌를 대신 흔들어 줘요.', '바다 건너 누군가도 지금 찌를 바라보고 있겠죠?', '어제보다 조금 더 다정한 하루가 되길.', '이 병은 소복마을 바다를 지나왔대요. 조금 차가울지도 몰라요.'];
function btState() { V.bt = V.bt && typeof V.bt === 'object' ? V.bt : { pool: [], seq: 1, from: {} }; V.bt.pool = Array.isArray(V.bt.pool) ? V.bt.pool : []; V.bt.from = V.bt.from || {}; return V.bt; }
function btMsg(ws, me, m) {
  if (!V || !me.save) return; const B = btState(), now = Date.now(), s = me.save;
  if (m.t === 'bt_send') {
    const text = cleanText(m.text, 120); if (text.length < 2) return send(ws, { t: 'news', text: '편지가 너무 짧아요' });
    const day = kstDay(); s.btDay = s.btDay === day ? day : day; s.btN = s.btDayK === day ? (s.btN | 0) : 0; s.btDayK = day; if (s.btN >= 3) return send(ws, { t: 'news', text: '🍾 유리병은 하루에 3개까지 띄울 수 있어요' }); s.btN++;
    let to = null; if (m.re) { const f = B.from[m.re | 0]; if (f && f !== me.key) to = f; }
    const id = B.seq++; B.pool.push({ id, text, from: me.key, to, re: m.re ? 1 : 0, at: now }); B.from[id] = me.key; const ks = Object.keys(B.from); if (ks.length > 400) delete B.from[ks[0]]; if (B.pool.length > 120) B.pool.shift();
    queueSave(me.key, s); vMark(); return send(ws, { t: 'bt_sent', re: !!m.re });
  }
  if (now - (me.btT || 0) < 6 * 60e3) return; if (Math.random() > .18) return; me.btT = now;
  let i = B.pool.findIndex(b => b.to === me.key); if (i < 0) { const c = B.pool.map((b, j) => [b, j]).filter(([b]) => !b.to && b.from !== me.key); if (c.length) i = c[(Math.random() * c.length) | 0][1]; }
  if (i >= 0) { const b = B.pool.splice(i, 1)[0]; vMark(); return send(ws, { t: 'bt_got', id: b.id, text: b.text, re: b.re, at: b.at }); }
  if (Math.random() < .35) send(ws, { t: 'bt_got', id: 0, text: BT_NPC[(Math.random() * BT_NPC.length) | 0], re: 0, at: now, npc: 1 });
}
/* ---------- 🌑 주간 레이드 (2026-11-11): 모두가 같은 「악몽의 왕」 체력을 함께 깎아요 · 매주 월요일 새로 ----------
   몬스터 움직임은 각자 화면에서, 체력과 피해는 서버가 모아요 (1초에 낼 수 있는 피해는 서버가 장비로 계산해 막아요) */
const RAID_HP = +process.env.RAID_HP || 6e6, RAID_FI = 10;
function raidState() { const w = wfWeek(); if (!V.raid || V.raid.w !== w) { V.raid = { w, hp: RAID_HP, mhp: RAID_HP, dmg: {}, nm: {}, dead: 0, pend: (V.raid && V.raid.pend) || {} }; vMark(); } return V.raid; }
const raidPub = () => { const R = raidState(); return { w: R.w, hp: Math.max(0, Math.round(R.hp)), mhp: R.mhp, dead: R.dead, top: Object.entries(R.dmg).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, d]) => [R.nm[k] || k, Math.round(d)]), ends: Date.UTC(2026, 0, 5) + (R.w + 1) * 7 * 864e5 - 9 * 3600e3 }; };
let raidDirty = false; setInterval(() => { if (raidDirty && V) { raidDirty = false; broadcast(Object.assign({ t: 'raid' }, raidPub())); } }, 1500);
function raidHit(ws, me, m) {
  if (!V || !me.save) return; const R = raidState(); if (R.dead) return; const now = Date.now(), H = me.hp_; if (!H || H.f !== RAID_FI || now - H.at > 4000) return;
  const s = me.save, lv = Math.max(1, (s.hu && s.hu.lv) | 0), h = s.hunt && typeof s.hunt === 'object' ? s.hunt : {}, RS = rpgSum(h, lv), atk = 2 + lv + (h.sw ? 3 : 0) + RS.atk;
  const el = Math.min(5, Math.max(.5, (now - (me.rhT || now - 1000)) / 1000)); me.rhT = now; const cap = atk * 7 * el; let d = Math.max(0, Math.min(cap, Number(m.d) || 0)); if (!d) return;
  R.hp -= d; R.dmg[me.key] = (R.dmg[me.key] || 0) + d; R.nm[me.key] = me.name; raidDirty = true; vMark();
  if (R.hp <= 0) { R.hp = 0; R.dead = now; raidEnd(R); }
}
function raidEnd(R) {
  const tot = Object.values(R.dmg).reduce((a, b) => a + b, 0) || 1, top = Object.entries(R.dmg).sort((a, b) => b[1] - a[1]), boost = vSt() >= 8 ? 1.5 : 1;
  broadcast({ t: 'news', text: '🌅 악몽의 왕이 쓰러졌어요!! 함께한 ' + top.length + '명 모두에게 보상이 가요 · 가장 많이 싸운 사람: ' + (R.nm[top[0][0]] || '') });
  top.forEach(([k, d], i) => { const sh = d / tot; R.pend[k] = { c: Math.round((1e6 + 4e6 * sh) * boost), item: sh >= .02, scr: sh >= .05 ? 2 : 1, ti: i === 0, sh: Math.round(sh * 1000) / 10 }; const L = liveByKey(k); if (L) raidClaim(L[0], L[1]); });
  broadcast(Object.assign({ t: 'raid' }, raidPub())); vMark();
}
function raidClaim(ws, me) {
  const R = raidState(), p = R.pend[me.key]; if (!p) return; delete R.pend[me.key]; vMark();
  withLock(me.key, async () => { const s = me.save; if (!s) return; const h = s.hunt && typeof s.hunt === 'object' ? s.hunt : (s.hunt = { w: 0, a: 0, b: 0, sw: 0 }); h.inv = Array.isArray(h.inv) ? h.inv : []; const e = ebOf(s), lv = Math.max(1, (s.hu && s.hu.lv) | 0);
    e.c = (e.c | 0) + p.c; let it = null; if (p.item) { it = mkItem(Math.min(10, Math.max(1, Math.floor(lv / 4))), rollG([0, 5, 20, 35, 28, 9, 3, .3, .04])); invPut(h, it); }
    const SC = scrMig(h); SC.w10 = (SC.w10 | 0) + 1; if (p.scr > 1) SC.a10 = (SC.a10 | 0) + 1; if (p.ti) giveCos(s, ['t_raid1']); queueSave(me.key, s);
    send(ws, { t: 'hunt', hunt: h, c: e.c, note: '🌅 레이드 보상 (기여 ' + p.sh + '%) · 칩 ' + p.c.toLocaleString() + (it ? ' · 【' + RPG_GN[it.g] + '】 장비' : '') + ' · 10% 주문서 ' + p.scr + '장' + (p.ti ? ' · 칭호 「악몽을 끝낸 자」' : '') });
  }).catch(e => console.error('raid', e.message));
}
const hsBoost = (me, k) => !!(me.hsOn && Date.now() < me.hsOn.until && (me.hsOn.k === k || me.hsOn.k === 'legend'));
const liveByName = n => { for (const [ws, p] of players) if (p.name === n) return [ws, p]; return null; };
const nearFairy = p => Math.hypot(p.x - FAIRY_XY[0], p.y - FAIRY_XY[1]) < 110;
const ownRing = s => { const own = (s && s.cos && s.cos.own) || []; return RING_IDS.filter(r => own.includes(r)).pop() || ''; };
const wedPub = () => ({ list: ((V && V.wed) || []).slice(0, 60), live: WLIVE && Date.now() - WLIVE.at < WED_LEN ? WLIVE : null });
function marMsg(ws, me, m) {
  const s = me.save; if (!s || !V) return; const no = msg => send(ws, { t: 'news', text: msg }); const now = Date.now(); V.wed = Array.isArray(V.wed) ? V.wed : [];
  if (m.t === 'wed_list') return send(ws, Object.assign({ t: 'wed_list' }, wedPub()));
  if (m.t === 'mar_req') {
    if (s.mar) return no('이미 결혼했어요 💍'); if (WLIVE && now - WLIVE.at < WED_LEN) return no('지금 다른 부부의 결혼식이 열리고 있어요. 끝나면 신고해요');
    const P = liveByName(cleanText(m.p, 12)), Wn = liveByName(cleanText(m.w, 12));
    if (!P || P[1] === me) return no('결혼할 상대가 지금 마을에 없어요'); if (!Wn || Wn[1] === me || Wn[1] === P[1]) return no('증인이 지금 마을에 없어요 (신랑 · 신부가 아닌 다른 사람)');
    const ps = P[1].save; if (!ps) return; if (ps.mar) return no(P[1].name + ' 님은 이미 결혼했어요');
    if (!WED_OUT.includes(me.look && me.look.o) || !WED_OUT.includes(P[1].look && P[1].look.o)) return no('두 사람 모두 턱시도나 웨딩드레스를 입어야 해요');
    if (!ownRing(s) || !ownRing(ps)) return no('두 사람 모두 결혼반지가 있어야 해요 (부티크)');
    if (![me, P[1], Wn[1]].every(nearFairy)) return no('신랑 · 신부 · 증인 모두 요정 리본 곁에 모여야 해요');
    MARP = { a: me.key, an: me.name, b: P[1].key, bn: P[1].name, w: Wn[1].key, wn: Wn[1].name, okB: false, at: now };
    send(P[0], { t: 'mar_ask', a: me.name, b: P[1].name, wn: Wn[1].name }); return no('💌 ' + P[1].name + ' 님에게 청혼했어요! 두근두근…');
  }
  if (m.t === 'mar_ans' || m.t === 'mar_w') {
    const q = MARP; if (!q || now - q.at > 180000) return; const isB = m.t === 'mar_ans' && q.b === me.key, isW = m.t === 'mar_w' && q.w === me.key && q.okB; if (!isB && !isW) return;
    const A = liveByName(q.an), B = liveByName(q.bn), Wt = liveByName(q.wn);
    if (!m.ok) { MARP = null; if (A) send(A[0], { t: 'news', text: isB ? '💔 ' + q.bn + ' 님이 아직은 아니래요…' : '증인 ' + q.wn + ' 님이 거절했어요. 다른 증인을 찾아봐요' }); return; }
    if (isB) { q.okB = true; q.at = now; if (Wt) send(Wt[0], { t: 'mar_ask', w: 1, a: q.an, b: q.bn }); if (A) send(A[0], { t: 'news', text: '💞 ' + q.bn + ' 님이 청혼을 받아줬어요! 이제 증인의 서명만 남았어요' }); return; }
    if (!A || !B || !A[1].save || !B[1].save || A[1].save.mar || B[1].save.mar) { MARP = null; return no('신랑이나 신부가 자리에 없어요'); }
    MARP = null; const ra = ownRing(A[1].save), rb = ownRing(B[1].save);
    A[1].save.mar = { p: q.bn, d: now, w: q.wn, ring: ra }; B[1].save.mar = { p: q.an, d: now, w: q.wn, ring: rb };
    queueSave(q.a, A[1].save); queueSave(q.b, B[1].save); send(A[0], { t: 'mar', mar: A[1].save.mar }); send(B[0], { t: 'mar', mar: B[1].save.mar });
    const rec = { id: 'w' + now.toString(36), a: q.an, b: q.bn, w: q.wn, at: now + 3000, g: [q.wn], m: [] }; V.wed.unshift(rec); if (V.wed.length > 300) V.wed.length = 300; vMark();
    WLIVE = { id: rec.id, a: rec.a, b: rec.b, w: rec.w, at: rec.at }; broadcast({ t: 'wed_live', w: WLIVE }); broadcast({ t: 'news', text: '💒 ' + q.an + ' ♥ ' + q.bn + ' 님이 결혼했어요! 증인 ' + q.wn + ' · 지금 북쪽 물결 예식장에서 결혼식이 열려요 🎉' });
    return;
  }
  if (m.t === 'mar_go') {
    const mr = s.mar; if (!mr) return; if (!ownRing(s)) return no('결혼반지가 있어야 해요'); const left = 300000 - (now - (mr.t | 0)); if (left > 0) return no('💍 반지의 힘이 다시 차오르는 중이에요 (' + Math.ceil(left / 60000) + '분)');
    const P = liveByName(mr.p); if (!P || !P[1].here) return no(mr.p + ' 님이 지금 마을에 없어요'); mr.t = now; queueSave(me.key, s);
    send(P[0], { t: 'news', text: '💍 ' + me.name + ' 님이 반지의 힘으로 곁에 왔어요!' }); return send(ws, { t: 'mar_go', x: P[1].x, y: P[1].y, p: mr.p });
  }
  if (m.t === 'mar_end') {
    const mr = s.mar; if (!mr) return; s.mar = null; queueSave(me.key, s); send(ws, { t: 'mar', mar: null, note: '각자의 길을 걷기로 했어요. 결혼 기록은 방명록에 남아 있어요' });
    const P = liveByName(mr.p); if (P && P[1].save && P[1].save.mar && P[1].save.mar.p === me.name) { P[1].save.mar = null; queueSave(P[1].key, P[1].save); send(P[0], { t: 'mar', mar: null, note: '💔 ' + me.name + ' 님이 각자의 길을 걷기로 했어요' }); }
    else { V.marEnd = V.marEnd || {}; V.marEnd[mr.p] = now; }
    const rec = V.wed.find(r => !r.end && ((r.a === me.name && r.b === mr.p) || (r.b === me.name && r.a === mr.p))); if (rec) rec.end = now; vMark(); return;
  }
  const rec = V.wed.find(r => r.id === String(m.id || '')) || (m.t === 'wed_done' && WLIVE && V.wed.find(r => r.id === WLIVE.id));
  if (!rec) return;
  if (m.t === 'wed_join') { if (!WLIVE || WLIVE.id !== rec.id) return; rec.g = rec.g || []; if (!rec.g.includes(me.name) && me.name !== rec.a && me.name !== rec.b && rec.g.length < 200) { rec.g.push(me.name); vMark(); } return; }
  if (m.t === 'wed_msg') { const text = cleanText(m.text, 60); if (!text) return; if (now - (me.wmT || 0) < 10000) return no('조금 있다가 또 남겨요'); me.wmT = now; rec.m = rec.m || []; rec.m.push({ n: me.name, t: text, at: now }); if (rec.m.length > 300) rec.m.shift(); vMark(); return send(ws, Object.assign({ t: 'wed_list' }, wedPub())); }
  if (m.t === 'wed_done') { if (me.name !== rec.a && me.name !== rec.b) return; if (now - rec.at < WED_LEN - 30000) return; const got = giveCos(s, ['t_wed']); queueSave(me.key, s); if (got.length) send(ws, { t: 'cos_got', ids: got }); if (WLIVE && WLIVE.id === rec.id && now - WLIVE.at >= WED_LEN - 30000) WLIVE = null; return; }
}
async function vLoad() {
  try { let r = await db.get(VKEY); if (!r) { await db.create(VKEY, '마을', hashCode(crypto.randomBytes(12).toString('hex'))); r = { save: null }; }
    V = Object.assign(vDefault(), r.save || {}); if (V.jp) ebJP = Math.max(EB.JP_BASE, V.jp); }
  catch (e) { console.error('마을 기록을 읽지 못했어요', e.message); V = vDefault(); }
  wkEnsure(); vSend(); console.log('마을 기록 · 시설 ' + vSt() + '단계 · 기금 ' + V.fund.g);
}
async function vFlush() { if (!V) return; vDirty = false; V.jp = Math.floor(ebJP); try { await db.save(VKEY, V); } catch (e) { console.error('마을 저장', e.message); } }
setInterval(() => { if (vDirty) vFlush(); }, 10000);
const kstHM = ms => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);
/* ⛵ 물결호 키우기 (자연 1.0): 마을 모두가 재료를 실어 단계를 올려요 · 마을 기록(__village)에 저장 · index.html ARK와 같아요 */
const ARK_NEED = [null, null, { plank: 300, log: 200 }, { cloth: 30, plank: 200 }, { plank: 400, honey: 60, fruit: 80 }, { plank: 600, cloth: 40, wildhoney: 80, honey_rb: 5, flower: 100, fruit: 120 }];   // index.html ARK와 같아요 (2026-11-05 꽃 · 나무가 귀해져서 줄였어요)
const ARK_GROUP = { fruit: ['apple', 'peach', 'orange', 'cherry'], flower: ['fl_tulip', 'fl_sun', 'fl_cosmos', 'fl_lav', 'fl_rose', 'fl_hydr', 'fl_lily', 'fl_rb'] };
const ARK_NAME = ['', '물결호', '튼튼한 물결호', '돛단 물결호', '물결 범선', '물결 방주'];
const arkOf = () => { if (!V) return { st: 1, got: {}, dn: {} }; const a = V.ark && typeof V.ark === 'object' ? V.ark : (V.ark = { st: 1, got: {}, dn: {} }); a.st = Math.max(1, Math.min(5, a.st | 0)); a.got = a.got || {}; a.dn = a.dn || {}; for (const k in a.got) if (MERGE[k]) { a.got[MERGE[k]] = (a.got[MERGE[k]] | 0) + a.got[k]; delete a.got[k]; } return a; };
const arkSt = () => arkOf().st;
/* 🌷⛵ 꽃배 (2026-11-05): 한 사람에 한 척 · 8척 · 마을 꽃배 부두 ↔ 안개 섬 부두 (index.html SHIP_N과 같아요)
   7일 넘게 안 온 사람의 배는 빈 배가 돼요 (그 사람 꽃은 저장에 그대로) */
const SHIP_N = 8, SHIP_IDLE = 7 * 864e5, SHIP_SAIL_MS = 5 * 60e3;
const shipsOf = () => { if (!V) return []; if (!Array.isArray(V.ships)) V.ships = []; while (V.ships.length < SHIP_N) V.ships.push(null); return V.ships; };
const shipSnapOf = s => {
  const g = s && s.gd, p = {}, o = {}; if (!g || typeof g !== 'object') return { n: 6, p, o, bd: 'wood' };
  for (const k in (g.p && typeof g.p === 'object' ? g.p : {})) { const v = g.p[k]; if (v && typeof v.f === 'string' && +k >= 0 && +k < 40) p[k] = { f: v.f.slice(0, 8), t0: +v.t0 || 0 }; }
  for (const k in (g.o && typeof g.o === 'object' ? g.o : {})) { const v = g.o[k]; if (v && typeof v.k === 'string' && +k >= 0 && +k < 12) { o[k] = { k: v.k.slice(0, 8), t0: +v.t0 || 0, fr: +v.fr || 0 }; if (Number.isInteger(v.x) && Number.isInteger(v.y) && v.x >= 0 && v.x < 24 && v.y >= 0 && v.y < 13) { o[k].x = v.x; o[k].y = v.y; } } }
  const dc = (Array.isArray(g.dc) ? g.dc : []).filter(d => d && typeof d.k === 'string' && Number.isInteger(d.x) && Number.isInteger(d.y) && d.x > 0 && d.x < 23 && d.y > 0 && d.y < 12).slice(0, 20).map(d => ({ k: d.k.slice(0, 10), x: d.x, y: d.y }));
  return { n: Math.max(6, Math.min(40, g.n | 0)), p, o, bd: typeof g.bd === 'string' ? g.bd.slice(0, 8) : 'wood', dc };
};
const shipPub = () => shipsOf().map(x => x ? { name: x.name, at: x.at, gd: x.gd } : null);
const shipIdx = key => shipsOf().findIndex(x => x && x.key === key);
let shipT = 0;
function shipSoon() { if (shipT) return; shipT = setTimeout(() => { shipT = 0; broadcast({ t: 'ships', ships: shipPub() }); }, 800); }
function shipSnap(me, s) { if (!V) return; const i = shipIdx(me.key); if (i < 0) return; const x = V.ships[i], gd = shipSnapOf(s); x.t = Date.now(); if (JSON.stringify(gd) !== JSON.stringify(x.gd)) { x.gd = gd; shipSoon(); } vMark(); }
const arkPub = () => { const a = arkOf(); return { st: a.st, got: a.got, dn: Object.entries(a.dn).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([n, v]) => ({ n, v })) }; };
function vPub() {
  if (!V) return { t: 'vil' };
  const st = vSt(), don = Object.entries(V.don).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, g]) => ({ name, g }));
  return { t: 'vil', ark: arkPub(), ships: shipPub(), fund: { g: V.fund.g, st, need: VF[st] ? VF[st].g : 0 }, don, wk: V.wk, rsv: V.rsv.map(r => ({ kind: r.kind, host: r.hostName, at: r.at })), fest: isFest(), festH: FEST_H, tog: { n: tog.n, on: tog.on, p: togLuck() }, boom: V.boom && V.boom.until > Date.now() ? V.boom : null, shop: medShop(), medCap: medCap() };
}
function vSend() { broadcast(vPub()); }
function vSoon() { if (vT) return; vT = setTimeout(() => { vT = 0; vSend(); }, 500); }
/* 주간 마을 목표: 월요일마다 새로 3개. 다 같이 채우고, 보상은 각자 받아요 (접속하지 않은 날이 있어도 그 주 안에 받으면 돼요) */
const WK_POOL = [['open', 10, '행사 10번 열기'], ['cup', 12, '월척 대회에 연인원 12명 참가'], ['bounty', 3, '현상수배 3번 해결'], ['stall', 15, '포장마차 15그릇 팔기'],
  ['play', 8, '펫 놀이터에서 연인원 8명이 5분 넘게 놀기'], ['auc', 4, '반짝 장터에서 4번 낙찰'], ['fish', 3000, '마을 전체 물고기 3,000마리 낚기'], ['tog', 600, '3명 이상 함께 접속한 시간 10시간']];
const wkId = () => { const t = new Date(Date.now() + 9 * 3600e3), dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow); return t.toISOString().slice(0, 10); };
const wkNum = () => Math.floor(Date.parse(wkId()) / (7 * 864e5));
function wkEnsure() {
  if (!V) return; const id = wkId(); if (V.wk && V.wk.id === id) return;
  const pool = WK_POOL.slice(), goals = []; let x = (wkNum() * 2654435761) >>> 0;
  while (goals.length < 3) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const g = pool.splice(x % pool.length, 1)[0]; goals.push({ k: g[0], n: g[1], t: g[2], p: 0 }); }
  V.wk = { id, goals }; vMark(); vSoon();
}
function wkAdd(k, n) {
  if (!V || !n) return; wkEnsure(); let ch = false;
  for (const g of V.wk.goals) if (g.k === k && g.p < g.n) { g.p = Math.min(g.n, g.p + n); ch = true; if (g.p >= g.n) broadcast({ t: 'news', text: '🏘️ 주간 마을 목표 달성! 「' + g.t + '」 · 마을 행사 → 주간 목표에서 보상을 받아요' }); }
  if (ch) { vMark(); vSoon(); }
}
/* 함께 접속: 3명 이상이면 마을 모두 행운 +5% (등대 전망대가 있으면 +10%) */
let tog = { n: 0, on: false };
function togCheck() { const n = [...players.values()].filter(p => p.save).length, on = n >= 3; if (n !== tog.n || on !== tog.on) { const was = tog.on; tog = { n, on }; if (on && !was) broadcast({ t: 'news', text: '👥 ' + n + '명이 함께 접속했어요! 함께 접속 보너스 · 행운 +' + Math.round(togLuck() * 100) + '%' }); vSoon(); } }
/* 축제 시간 · 예약 알림 · 함께 접속 시간 (1분마다) */
let festWas = null;
setInterval(() => {
  togCheck(); if (tog.on) wkAdd('tog', 1);
  const f = isFest(); if (festWas !== null && f !== festWas) { broadcast({ t: 'news', text: f ? '🎉 축제 시간이 시작됐어요! (밤 ' + FEST_H + '시~' + (FEST_H + 1) + '시) 행사 도토리 2배 · 행사 시간 1.5배' : '🎉 오늘의 축제 시간이 끝났어요. 내일 밤 ' + FEST_H + '시에 또 만나요!' }); vSoon(); } festWas = f;
  if (V && V.rsv.length) { const now = Date.now(); let ch = false;
    for (const r of V.rsv) {
      const K = EV_KIND[r.kind];
      if (!r.w && r.at - now <= 10 * 60e3) { r.w = 1; ch = true; broadcast({ t: 'news', text: '⏰ 10분 뒤 ' + r.hostName + ' 님의 「' + K.name + '」! (' + kstHM(r.at) + ')' }); }
      if (r.w === 1 && now >= r.at) { r.w = 2; ch = true; broadcast({ t: 'news', text: '⏰ 지금 ' + r.hostName + ' 님의 「' + K.name + '」 시간이에요!' }); const l = liveByKey(r.host); if (l) send(l[0], { t: 'ev_rsv_now', kind: r.kind }); }
    }
    const n0 = V.rsv.length; V.rsv = V.rsv.filter(r => now < r.at + 30 * 60e3); if (ch || V.rsv.length !== n0) { vMark(); vSoon(); } }
  wkEnsure();
}, 60000);
/* 도토리 상점: 늘 있는 것 + 주마다 바뀌는 3개. 확정권은 주 1장 (index.html MED_SHOP과 같아야 해요) */
const MED_CORE = [['tf_silver', 10], ['tf_gold', 25], ['t_fest', 15], ['sure', 8], ['t_trust1', 10], ['t_trust2', 30], ['b_trust', 40], ['k_trust', 80]];   // 2026-11-05: 신뢰 상점도 도토리 상점으로
const MED_ROT = [['laurel', 15], ['ft_petal', 20], ['ft_star', 20], ['ft_drop', 20], ['flagback', 30], ['tf_rainbow', 40], ['t_medal', 20], ['t_regular', 10]];
const medShop = () => { const n = wkNum(), out = MED_CORE.slice(); for (let i = 0; i < 3; i++) out.push(MED_ROT[(n * 3 + i) % MED_ROT.length]); return out; };

/* ===== 🪤 통발 3.0 (2026-11-09): 낚시터 물가에 직접 놓는 통발 · 누구나 들여다볼 수 있어요 · 마을 기록(__village)에 저장
   안에 든 물고기는 (seed, 놓은 시각, 빠르기, 칸 수, 미끼)로 모든 화면이 똑같이 계산해요 (index.html trapRoll과 같아요) ===== */
const TRAP_ZONES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19], TRAP_PER_ZONE = 6, TRAP_BX = [1, 1.5, 2.5, 3.5, 5];
const TRAP_SKINS = ['tp_bamboo', 'tp_rattan', 'tp_shell', 'tp_sakura', 'tp_coral', 'tp_chest', 'tp_moon', 'tp_gold', 'tp_strawcake', 'tp_choco', 'tp_macaron', 'tp_donut', 'tp_icecream', 'tp_cookie', 'tp_candy', 'tp_pudding', 'tp_apple', 'tp_orange', 'tp_lemon', 'tp_grape', 'tp_melon', 'tp_peach', 'tp_cat', 'tp_bear', 'tp_bunny', 'tp_frog', 'tp_panda', 'tp_chick', 'tp_santa', 'tp_tree', 'tp_gift', 'tp_snow', 'tp_ice', 'tp_ginger', 'tp_rose', 'tp_tulip', 'tp_sunflower', 'tp_lavender', 'tp_lotus', 'tp_cherry2', 'tp_hibiscus', 'tp_star', 'tp_aurora', 'tp_crystal', 'tp_dragon', 'tp_cloud', 'tp_music', 'tp_galaxy', 'tp_rainbow'], TRAP_FLAGS = ['tf_none', 'tfl_red', 'tfl_stripe', 'tfl_star', 'tfl_lamp', 'tfl_rainbow', 'tfl_heart', 'tfl_balloon', 'tfl_pinwheel', 'tfl_moon', 'tfl_bell', 'tfl_cane', 'tfl_sun', 'tfl_koi', 'tfl_crown', 'tfl_lantern2', 'tfl_cloud', 'tfl_spark', 'tfl_ribbon'];
const trapsOf = () => { if (!V) return {}; if (!V.traps || typeof V.traps !== 'object') V.traps = {}; return V.traps; };
const trapPub = () => Object.entries(trapsOf()).map(([k, t]) => ({ n: t.n, z: t.z, x: t.x, y: t.y, t0: t.t0, seed: t.seed, min: t.min, cap: t.cap, bx: t.bx, sk: t.sk, fl: t.fl, at: t.at, vis: t.vis || {}, notes: t.notes || [] }));
let trapT = 0;
function trapSoon() { if (trapT) return; trapT = setTimeout(() => { trapT = 0; broadcast({ t: 'traps', list: trapPub() }); }, 300); }
const ownsCos = (s, id) => !!(s && s.cos && Array.isArray(s.cos.own) && s.cos.own.includes(id));
function trapParams(m) { return { min: Math.max(8, Math.min(60, +m.min || 40)), cap: Math.max(1, Math.min(60, m.cap | 0 || 10)), bx: TRAP_BX.includes(+m.bx) ? +m.bx : 1 }; }
function trapMsg(ws, me, m) {
  if (!V) return; const T = trapsOf(), now = Date.now(), s = me.save, mine = T[me.key];
  const err = text => send(ws, { t: 'news', text });
  if (m.t === 'trap_list') return send(ws, { t: 'traps', list: trapPub() });
  if (m.t === 'trap_set') {
    if (mine) return err('통발은 한 사람에 하나예요. 먼저 놓아둔 통발을 거둬요');
    const z = m.z | 0, x = m.x | 0, y = m.y | 0; if (!TRAP_ZONES.includes(z) || x < 0 || y < 0 || x > 400 || y > 400) return err('여기에는 통발을 놓을 수 없어요');
    const all = Object.values(T); if (all.filter(t => t.z === z).length >= TRAP_PER_ZONE) return err('이 낚시터엔 통발이 꽉 찼어요 (' + TRAP_PER_ZONE + '개)');
    if (all.some(t => Math.abs(t.x - x) <= 1 && Math.abs(t.y - y) <= 1)) return err('바로 옆에 다른 통발이 있어요. 조금 떨어진 곳에 놓아요');
    const sk = TRAP_SKINS.includes(m.sk) && (m.sk === 'tp_bamboo' || ownsCos(s, m.sk)) ? m.sk : 'tp_bamboo', fl = TRAP_FLAGS.includes(m.fl) && (m.fl === 'tf_none' || ownsCos(s, m.fl)) ? m.fl : 'tf_none';
    T[me.key] = Object.assign({ n: me.name, z, x, y, t0: now, at: now, seed: crypto.randomBytes(4).readUInt32LE(0), sk, fl, vis: {}, notes: [] }, trapParams(m));
    vMark(); trapSoon(); return send(ws, { t: 'trap_ok', what: 'set' });
  }
  if (m.t === 'trap_claim' || m.t === 'trap_take') {
    if (!mine) return err('놓아둔 통발이 없어요');
    const snap = JSON.parse(JSON.stringify(mine));
    if (m.t === 'trap_take') delete T[me.key];
    else Object.assign(mine, { t0: now, seed: crypto.randomBytes(4).readUInt32LE(0), vis: {}, notes: [] }, trapParams(m));
    vMark(); trapSoon(); return send(ws, { t: 'trap_got', tr: snap, at: now, take: m.t === 'trap_take' });
  }
  if (m.t === 'trap_peek' || m.t === 'trap_note') {
    const key = Object.keys(T).find(k => T[k].n === m.n); if (!key || key === me.key) return; const t = T[key];
    if (m.t === 'trap_peek') { t.vis = t.vis || {}; if (Object.keys(t.vis).length < 30 || t.vis[me.name]) t.vis[me.name] = Math.min(99, (t.vis[me.name] | 0) + 1); }
    else { const text = String(m.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 20); if (!text) return; t.notes = (t.notes || []).filter(x => x.n !== me.name); t.notes.push({ n: me.name, t: text, at: now }); if (t.notes.length > 12) t.notes.shift(); }
    vMark(); trapSoon(); return;
  }
  if (m.t === 'trap_skin') {
    if (!mine) return; if (TRAP_SKINS.includes(m.sk) && (m.sk === 'tp_bamboo' || ownsCos(s, m.sk))) mine.sk = m.sk; if (TRAP_FLAGS.includes(m.fl) && (m.fl === 'tf_none' || ownsCos(s, m.fl))) mine.fl = m.fl;
    vMark(); trapSoon(); return;
  }
  if (m.t === 'trap_bait') { if (!mine) return; mine.bx = TRAP_BX.includes(+m.bx) ? +m.bx : 1; vMark(); trapSoon(); return; }
}
function vilMsg(ws, me, m) {
  const err = text => send(ws, { t: 'ev_err', text });
  if (m.t === 'vil') { send(ws, vPub()); if (me.save) send(ws, { t: 'med', med: medPub(me.save), wkc: me.save.wkc || null, medw: me.save.medw || null }); return; }
  if (m.t === 'wk_claim') return withLock(me.key, async () => {
    const s = me.save; if (!s || !V) return; wkEnsure(); const w = V.wk, c = s.wkc && s.wkc.id === w.id ? s.wkc : (s.wkc = { id: w.id, got: [] }), i = m.i === 'all' ? 'all' : m.i | 0;
    if (c.got.includes(i)) return err('이미 받았어요');
    if (i === 'all') { if (!w.goals.every(g => g.p >= g.n)) return err('세 가지를 다 채우면 받아요'); c.got.push('all'); const tk = 2 + (vSt() >= 3 ? 1 : 0); await giveTk(me.key, tk, '🏘️ 주간 마을 목표 모두 달성! 강화권 +' + tk); await medAdd(me.key, 5, '주간 목표 모두 달성', true); }
    else { const g = w.goals[i]; if (!g || g.p < g.n) return err('아직 다 못 채웠어요'); c.got.push(i); await giveTk(me.key, 1, '🏘️ 「' + g.t + '」 달성! 강화권 +1'); await medAdd(me.key, 2, '주간 목표 달성', true); }
    queueSave(me.key, s); send(ws, { t: 'med', med: medPub(s), wkc: c });
  }).catch(er => console.error('wk_claim', er.message));
  if (m.t === 'med_buy') return withLock(me.key, async () => {
    const s = me.save, it = medShop().find(x => x[0] === m.id); if (!s || !it) return err('이번 주에는 없는 물건이에요');
    const md = s.med || (s.med = { n: 0, tot: 0, d: kstDay(), t: 0 }); if ((md.n | 0) < it[1]) return err('도토리가 모자라요');
    if (it[0] === 'sure') {
      const w = s.medw && s.medw.id === wkId() ? s.medw : (s.medw = { id: wkId(), sure: 0 }); if (w.sure >= 1) return err('확정권은 일주일에 1장이에요');
      w.sure++; md.n -= it[1]; const en = enhOf(s); en.sure = (en.sure | 0) + 1; sendEnh(ws, me, { note: ['🌰 강화 확정권 +1 · 다음 강화 한 번이면 바로 다음 단계!'] });
    } else { const own = (s.cos && s.cos.own) || []; if (own.includes(it[0])) return err('이미 가지고 있어요'); md.n -= it[1]; const got = giveCos(s, [it[0]]); send(ws, { t: 'cos_got', ids: got }); }
    queueSave(me.key, s); send(ws, { t: 'med', med: medPub(s), why: '🌰 도토리 교환 완료!', medw: s.medw || null });
  }).catch(er => console.error('med_buy', er.message));
  if (m.t === 'ev_rsv') {
    const K = EV_KIND[m.kind], s = me.save, at = Number(m.at) || 0, now = Date.now(); if (!s || !K || !V) return;
    if (jobOf(s) !== K.job) return err(JOB_NAME[K.job] + '만 예약할 수 있어요');
    if (at < now + 5 * 60e3 || at > now + 24 * 3600e3) return err('5분 뒤부터 24시간 안으로 예약해 주세요');
    V.rsv = V.rsv.filter(r => r.host !== me.key); V.rsv.push({ kind: m.kind, host: me.key, hostName: me.name, at, w: 0 }); V.rsv.sort((a, b) => a.at - b.at); vMark(); vSoon();
    return broadcast({ t: 'news', text: '⏰ ' + me.name + ' 님이 ' + kstHM(at) + '에 「' + K.name + '」을(를) 예약했어요! 시간 되면 알려 드릴게요' });
  }
  if (m.t === 'ev_rsv_del') { if (V) { V.rsv = V.rsv.filter(r => r.host !== me.key); vMark(); vSoon(); } return; }
  if (m.t === 'vf_put') return withLock(me.key, async () => {
    const s = me.save, g = Math.floor(Number(m.g) || 0); if (!s || !V || g < 10000) return;
    if (vSt() >= VF.length) return err('모든 시설을 다 지었어요!'); if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
    await changeBag(me.key, { g: -g }, null); V.fund.g += g; V.don[me.name] = (V.don[me.name] || 0) + g;
    const tot = V.don[me.name], ti = []; if (tot >= 1e6) ti.push('t_vf1'); if (tot >= 1e7) ti.push('t_vf2'); if (ti.length) { const got = giveCos(s, ti); if (got.length) send(ws, { t: 'cos_got', ids: got }); }
    while (vSt() < VF.length && V.fund.g >= VF[vSt()].g) { V.fund.g -= VF[vSt()].g; V.fund.st++; const f = VF[V.fund.st - 1]; broadcast({ t: 'news', text: '🏗️ 마을 발전 기금으로 축제 광장에 「' + f.name + '」이(가) 생겼어요! ' + f.eff }); }
    if (vSt() >= VF.length) V.fund.g = 0;
    if (g >= 1e6) broadcast({ t: 'news', text: '💝 ' + me.name + ' 님이 마을 발전 기금에 ' + fmtN(g) + '골드를 기부했어요!' }, ws);
    queueSave(me.key, s); send(ws, { t: 'ev_err', text: '💝 ' + fmtN(g) + '골드를 기부했어요. 고마워요!' }); vMark(); vFlush(); vSend();
  }).catch(er => console.error('vf_put', er.message));
}

/* ---------- 반짝 개체 · 신화 · 마을 기록 · 수족관 (2026-11-04) ---------- */
/* 반짝 개체: 직접 낚은(손맛) 물고기마다 서버가 굴려요. 반짝 도감은 끝이 없는 꿈 (누가 먼저 잡아도 내 반짝은 내 것) */
const SHINY_P = r => r >= 4 ? 1 / 150 : 1 / 300, SHINY_TI = [[1, 't_sh1'], [5, 'sb_pearl'], [10, 't_sh10'], [10, 'sb_prism'], [20, 'sb_rainbow'], [30, 't_sh30'], [30, 'sb_star']];
/* 도장 보상 (index.html STAMP_TK와 같아요): 🎣 손맛 · ✨ 반짝 도장을 그 물고기에서 처음 찍으면 강화권 */
const STAMP_TK = { sd: [1, 2, 3, 5, 5], sh: [5, 10, 20, 40, 40] }, STAMP_MYTH = { sd: 10, sh: 80 };
const stampTk = (id, k) => isMyth(id) ? STAMP_MYTH[k] : STAMP_TK[k][fishRar(id)] | 0;
const objOf = (s, k) => s[k] && typeof s[k] === 'object' ? s[k] : (s[k] = {});
function stampGive(ws, s, k, ids, rate, label) {   // 아직 보상 안 받은 도장만 · rate: 예전 기록 정산은 절반
  const done = objOf(s, k === 'sd' ? 'sdtk' : 'shtk'); let n = 0, cnt = 0;
  const sr = rate >= 1 ? 1 + .2 * jobRank(s, 'sch', 'stamp') : 1;   // 도감 박사 '도장 학자'
  for (const id of ids) { if (done[id] || !validFish(id)) continue; done[id] = 1; n += Math.ceil(stampTk(id, k) * rate * sr); cnt++; }
  if (!n) return 0; const e = enhOf(s); e.tk = Math.min(ENH.TK_MAX, e.tk + n);
  if (ws) send(ws, { t: 'enh', enh: e, note: [label.replace('{c}', cnt).replace('{n}', n)] }); return n;
}
function stampCheck(ws, s, oldSd) {
  const nsd = s.sdex || {}, fresh = []; for (const k in nsd) if ((nsd[k] | 0) > 0 && !((oldSd[k] | 0) > 0)) fresh.push(+k);
  if (fresh.length) stampGive(ws, s, 'sd', fresh, 1, fresh.length === 1 ? '🎣 손맛 도장! 강화권 +{n}' : '🎣 손맛 도장 {c}개! 강화권 +{n}');
}
/* 도장 정산 (한 번): 예전 손맛 기록은 절반, 반짝은 전부. 반짝 물고기도 가방 반짝 칸에 넣어 줘요 */
function stampMigrate(ws, s) {
  if (s.stv) return; s.stv = 1; const sd = Object.keys(s.sdex || {}).filter(k => (s.sdex[k] | 0) > 0).map(Number), sh = Object.keys(s.shiny || {}).filter(k => (s.shiny[k] | 0) > 0).map(Number);
  const b = objOf(s, 'shb'); for (const id of sh) if (!b[id]) b[id] = s.shiny[id] | 0;
  const a = stampGive(null, s, 'sd', sd, .5, ''), c = stampGive(null, s, 'sh', sh, 1, '');
  if (a + c) send(ws, { t: 'enh', enh: enhOf(s), note: ['📖 도감이 도장 3개로 바뀌었어요! 지금까지 찍은 도장 보상: 강화권 +' + (a + c) + (a ? ' (예전 손맛은 절반)' : '')] });
  if (sh.length) send(ws, { t: 'shb', shb: b });
}
function shinyRoll(ws, me, s, oldSd) {
  const nsd = s.sdex || {}, sh = s.shiny && typeof s.shiny === 'object' ? s.shiny : (s.shiny = {}), got = [], first = [];
  for (const k in nsd) { const id = +k; if (isGet(id)) continue; let dn = Math.max(0, (nsd[k] | 0) - (oldSd[k] | 0)); const p = (isMyth(id) ? 1 / 60 : SHINY_P(fishRar(id))) * (((s.enh && s.enh.lv) | 0) >= 18 ? 2 : 1) * (((s.enh && s.enh.lv) | 0) >= 28 ? 1.5 : 1) * (me.shx && Date.now() < me.shx ? 3 : 1) * (hsBoost(me, 'shiny') ? 2 : 1) * (fireOn() ? 1.5 : 1); while (dn-- > 0) if (Math.random() < p) { if (!(sh[id] | 0)) first.push(id); sh[id] = (sh[id] | 0) + 1; got.push(id); } }
  if (!got.length) return;
  const b = objOf(s, 'shb'); for (const id of got) b[id] = (b[id] | 0) + 1;
  const tk = first.length ? stampGive(null, s, 'sh', first, 1, '') : 0;
  const kinds = Object.keys(sh).filter(k => sh[k] > 0).length, ti = SHINY_TI.filter(t => kinds >= t[0]).map(t => t[1]), cos = giveCos(s, ti);
  for (const id of got) { send(ws, { t: 'shiny', id, n: sh[id], kinds, cos, shb: b, tk: first.includes(id) ? stampTk(id, 'sh') : 0, enh: s.enh }); broadcast({ t: 'shiny_news', who: me.name, id }, ws); dayAdd(me.key, me.name, 49); }
  const r = rosterCache.get(me.key); if (r) { r.sh = kinds; rosterSoon(); }
}
/* ---------- 헤비 · 라이트 격차 줄이기 ----------
   1) 돌아온 친구 선물: 하루 이상 못 왔으면 못 온 날만큼(최대 3일) 골드 · 강화권 · '휴식 행운'을 모아 둬요. 마을에서 뒤처진 친구일수록 더 많이
   2) 선배 보너스: 손맛 도감이 두 배 이상 많은 친구가 옆(8칸)에 있을 때 후배가 새 물고기를 낚으면 선배에게 도토리 (하루 10개까지)
   3) 마을의 응원: 화면에서 손맛 도감이 마을 1등의 절반이 안 되면 행운 ↑ (index.html cheerLuck) */
const WB_GOLD = [3000, 8000, 20000, 50000, 120000, 200000], WB_DAYS = 3, WB_TK = 2, WB_REST = 25, MENTOR_DAY = 10;
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function villageTopSd() { let m = 0; for (const r of rosterCache.values()) m = Math.max(m, r.sd | 0); return m; }
async function welcomeBack(ws, p) {
  const s = p.save, d = kstDay(), last = s.lsd; s.lsd = d; queueSave(p.key, s);
  if (!last || last >= d) return;
  const away = Math.min(WB_DAYS, dayGap(last, d) - 1); if (away < 1) return;
  const top = villageTopSd(), mine = sdN(s), behind = top > 0 && mine < top * .5 ? 1.5 : 1;
  const zs = zonesOf(s), z = Math.max(...zs.filter(x => x <= 6), 1), g = Math.round(WB_GOLD[z - 1] * away * behind / 100) * 100, tk = Math.round(WB_TK * away * behind), rest = Math.round(WB_REST * away * behind);
  await changeBag(p.key, { g }, null); await giveTk(p.key, tk, null);
  send(ws, { t: 'welcome', away, g, tk, rest, behind: behind > 1 });
}
function mentorCheck(me, s, oldSd) {
  const nsd = s.sdex || {}; let fresh = 0; for (const k in nsd) if ((nsd[k] | 0) > 0 && !((oldSd[k] | 0) > 0)) fresh++; if (!fresh) return;
  const mine = sdN(s);
  for (const [ws2, o] of players) { if (o === me || !o.save || o.key === me.key) continue; if (Math.hypot((o.x | 0) - (me.x | 0), (o.y | 0) - (me.y | 0)) > 128) continue;
    if (sdN(o.save) < Math.max(10, mine * 2)) continue;
    lockDo(o.key, async () => { const sv = o.save, d = kstDay(), r = sv.mnt && sv.mnt.d === d ? sv.mnt : (sv.mnt = { d, n: 0 }); if (r.n >= MENTOR_DAY) return; const n = Math.min(fresh, MENTOR_DAY - r.n); r.n += n;
      await medAdd(o.key, n, '옆에 있던 ' + me.name + ' 님이 새 물고기를 낚았어요 (선배 보너스)', true); }).catch(() => { });
    const l = liveByKey(me.key); if (l) send(l[0], { t: 'news', text: '🤝 ' + o.name + ' 님 옆에서 새 물고기! 선배에게 도토리가 갔어요' });
  }
}
/* ---------- 직업 3.0: 누르는 기술 (index.html SK와 같아요). 쿨타임은 서버가 save.skc에 지켜요 ---------- */
const SKILLS = {
  focus: { job: 'fish', node: 'focus', dur: () => 10, cd: s => 180 - 45 * jobRank(s, 'fish', 'focus2') },
  legend: { job: 'fish', node: 'cap', daily: true },
  boom: { job: 'sch', node: 'fc', dur: s => 30 + 5 * jobRank(s, 'sch', 'note'), cd: () => 240 },
  shx: { job: 'sch', node: 'cap', dur: () => 30, cd: () => 360 },
  cat: { job: 'cra', node: 'cat', cd: s => 120 - 30 * jobRank(s, 'cra', 'cat2') },
  auto: { job: 'tam', node: 'auto', dur: s => 10 + 5 * jobRank(s, 'tam', 'sit'), cd: () => 180 },
  gold: { job: 'mer', node: 'gold', dur: s => 10 + 5 * jobRank(s, 'mer', 'cons'), cd: () => 240 } };
/* 낚시꾼 패시브 '강화의 손맛': 직접 낚을 때 강화 별 (하루 10개) */
function starCatch(ws, s, oldSd) { const r = jobRank(s, 'fish', 'star'); if (!r) return; const nsd = s.sdex || {}; let dn = 0; for (const k in nsd) dn += Math.max(0, (nsd[k] | 0) - (oldSd[k] | 0)); if (!dn) return;
  const e = enhOf(s), d = kstDay(); if (!e.sfd || e.sfd.d !== d) e.sfd = { d, n: 0 }; let got = 0; while (dn-- > 0 && e.sfd.n < 10) if (Math.random() < .03 * r) { got++; e.sfd.n++; }
  if (!got || e.lv >= ENH.MAX) return; e.star = (e.star | 0) + got; while (e.lv < ENH.MAX && e.star >= ENH.S[e.lv]) { e.star -= ENH.S[e.lv]; e.lv++; } e.max = Math.max(e.max | 0, e.lv);
  send(ws, { t: 'enh', enh: e, note: ['🎣 강화의 손맛! 강화 별 +' + got + ' (오늘 ' + e.sfd.n + '/10)'] }); }
/* 오늘의 주인공 집계 (메모리만): 오늘 직접 낚은 마릿수 */
function dayStar(me, s, oldSd) { dayAdd(me.key, me.name, dayPts(me, s, oldSd)); const nsd = s.sdex || {}; let dn = 0; for (const k in nsd) dn += Math.max(0, (nsd[k] | 0) - (oldSd[k] | 0)); if (!dn) return; const d = kstDay(); if (!me.tday || me.tday.d !== d) me.tday = { d, n: 0 }; me.tday.n += dn; rosterSoon(); }
/* 신화: 조건이 겹칠 때만 나오는 낚시터의 주인. 잡으면 마을 뉴스 · 칭호 · 마을 최초 기록 */
function mythCheck(me, s, oldSd) {
  const nsd = s.sdex || {};
  for (let i = 0; i < MYTH_Z.length; i++) { const id = MYTH_FIRST + i; if ((nsd[id] | 0) > (oldSd[id] | 0)) {
    const first = V && !(V.myth && V.myth[id]); if (V && first) { V.myth = V.myth || {}; V.myth[id] = me.name; vMark(); }
    giveCos(s, ['t_myth']); broadcast({ t: 'myth_news', who: me.name, id, first });
  } }
}
/* 마을 기록: 물고기마다 마을에서 가장 큰 기록 (도감 최대 크기) */
async function recList() {
  const out = {};
  for (const key of rosterCache.keys()) { const sv = await loadSave(key); if (!sv || !sv.dex) continue; const nm = (rosterCache.get(key) || {}).name || key;
    for (const k in sv.dex) { const b = sv.dex[k] && sv.dex[k].best | 0; if (b > 0 && validFish(+k) && (!out[k] || b > out[k][0])) out[k] = [b, nm]; } }
  return out;
}
/* 마을 신기록: 물고기마다 마을 1등 크기 (V.rec = { id: [cm, 이름] }). 직접 낚아서 남의 기록을 깨면 마을 전체에 소식 */
let recReady = null;
function recInit() { if (!recReady) recReady = recList().then(r => { if (!V) return; V.rec = V.rec || {}; for (const k in r) if (!V.rec[k] || r[k][0] > V.rec[k][0]) V.rec[k] = r[k]; vMark(); }).catch(() => { recReady = null; }); return recReady; }
function recCheck(ws, me, oldDex, s, oldSd) {
  const nd = s.dex || {}, nsd = s.sdex || {}, cand = [];
  for (const k in nd) { const id = +k, nb = nd[k] && nd[k].best | 0, ob = oldDex[k] ? oldDex[k].best | 0 : 0; if (nb > ob && nb < 20000 && validFish(id) && (nsd[k] | 0) > (oldSd[k] | 0)) cand.push([id, nb]); }
  if (!cand.length) return;
  recInit().then(() => { if (!V) return; V.rec = V.rec || {};
    for (const [id, len] of cand) { const cur = V.rec[id]; if (cur && len <= cur[0]) continue; V.rec[id] = [len, me.name]; vMark();
      if (cur && cur[1] !== me.name) { send(ws, { t: 'vrec', id, len, prev: cur }); broadcast({ t: 'vrec_news', who: me.name, id, len, prev: cur }, ws); } } });
}
/* 수족관: 내가 만난 물고기 8마리까지 넣어 두고 친구가 구경 · 하루 한 번 좋아요 */
const AQ_MAX = 8;
function aqClean(s, slots) {
  const dex = s.dex || {}, sh = s.shiny || {}, out = [];
  for (const x of Array.isArray(slots) ? slots.slice(0, aqMax(s)) : []) { const id = x && x.id; if (!validFish(id) || !(dex[id] && dex[id].n > 0)) continue; out.push({ id, sh: !!(x.sh && sh[id] > 0 && ((s.shb || {})[id] | 0) > 0), len: Math.max(1, Math.min(dex[id].best | 0 || 1, x.len | 0 || dex[id].best | 0)) }); }
  return out;
}
/* ---------- 골드 쓰는 곳 2.0 (2026-11-04): 수족관 확장 · 치장 별 · 주간 한정 · 안개 섬 고급 치장 (index.html과 같은 숫자) ---------- */
const AQX_N = [8, 12, 16, 24], AQX_G = [1e6, 5e6, 2e7];
const AQ_DECO = { coral: 3e5, shellbed: 2e5, weed2: 2.5e5, chest: 5e5, castle: 8e5, bubbler: 4e5, sand_pink: 3e5, sand_night: 6e5, light_sun: 1e6, light_moon: 1.5e6 };
const aqMax = s => AQX_N[Math.min(3, s.aqx | 0)];
/* 치장 별 ★1~5: 입은 것이 반짝반짝 (모두에게 보여요). ★5는 반짝 물고기 1마리도 같이 */
const CUP_BASE = { o: 1e5, hat: 6e4, bk: 1.5e5, fa: 4e4, bob: 4e4 }, CUP_MUL = [1, 3, 8, 20, 50];
const cosSlot = id => { lookFlat(); for (const k of ['o', 'hat', 'bk', 'fa', 'bob']) if (LOOK_IDS[k].includes(id)) return k; return ''; };
const cupCost = (id, cur) => { const k = cosSlot(id); return k && cur < 5 ? Math.round(CUP_BASE[k] * CUP_MUL[cur] * (id.startsWith('pv_') ? 2 : 1)) : 0; };
/* 한정 치장: 이미 있는 옷의 특별한 색 (주간 상점 · 안개 섬) */
const PV_WEEK = [['o', 'pondrobe', 'gold'], ['o', 'starcloak', 'ember'], ['o', 'suit', 'gold'], ['o', 'pd_snow', 'crystal'], ['o', 'knight', 'gold'], ['o', 'idol', 'rainbow'], ['o', 'hanbok_p', 'pearl'], ['o', 'witchrobe', 'night'], ['o', 'sailor', 'pearl'],
  ['hat', 'crown', 'rainbow'], ['hat', 'tiara', 'crystal'], ['hat', 'mooncrown', 'ember'], ['hat', 'captain', 'gold'], ['hat', 'witchhat', 'night'], ['hat', 'halo', 'rainbow'],
  ['bk', 'angelwings', 'gold'], ['bk', 'fairywings', 'rainbow'], ['bk', 'dracape', 'ember'], ['bk', 'kingcape', 'night'], ['bk', 'butterfly', 'crystal']];
const PV_ISLE = [['o','fogcoat','fog',2e6,40],['o','deepsea','coral',2e6,40],['o','lifejacket','coral',2e6,40],['hat','pirate','fog',1.5e6,30],['hat','whalehat','coral',1.5e6,30],['bk','xcape_n','fog',3e6,60],
 ['o','sailor','seafoam',3e6,40],['o','pd_sea','abyss',6e6,60],['o','starcloak','fog',6e6,60],['o','idol','seafoam',5e6,50],['o','hanbok_b','abyss',5e6,50],['o','knight','abyss',8e6,80],['o','o_navy','lighthouse',8e6,80],['o','o_mermaid','abyss',9e6,90],
 ['hat','captain','lighthouse',3e6,30],['hat','jelly','abyss',3e6,30],['hat','halo','seafoam',4e6,40],['hat','crown','fog',5e6,50],['hat','mooncrown','abyss',5e6,50],['hat','h_coral','lighthouse',6e6,60],
 ['bk','dracape','lighthouse',8e6,80],['bk','butterfly','abyss',9e6,90],['bk','kingcape','abyss',10e6,100],['bk','fairywings','seafoam',10e6,100],['bk','angelwings','fog',12e6,120],['bk','k_shell','abyss',12e6,120]];   // index.html PV_ISLE와 같아요
/* 섬 전용 신상 (index.html ISLE_ITEMS와 같아요): [id, 골드, 안개 조각] */
const BRAG = {"r_choco": ["💎", "유니크", "초코 분수 낚싯대"], "r_jelly": ["💎", "유니크", "말랑 젤리 낚싯대"], "r_snowflake": ["💎", "유니크", "눈꽃 요정 낚싯대"], "r_whale": ["👑", "레전더리", "고래 숨결 낚싯대"], "r_phoenix": ["🌌", "미스틱", "불사조 낚싯대"], "r_starlight": ["🌌", "미스틱", "별똥별 낚싯대"], "b_music": ["💎", "유니크", "음표 찌"], "b_planet": ["💎", "유니크", "토성 찌"], "b_lotus": ["💎", "유니크", "연꽃 등불 찌"], "b_snowglobe": ["💎", "유니크", "스노우볼 찌"], "b_whale": ["💎", "유니크", "아기 고래 찌"], "b_phoenix": ["💎", "유니크", "불사조 깃털 찌"], "b_gem": ["💎", "유니크", "루비 하트 찌"], "b_clock": ["💎", "유니크", "시계탑 찌"], "b_dragon": ["🌟", "레전더리", "용의 알 찌"], "b_angel": ["🌟", "레전더리", "천사 찌"], "b_sun": ["🌟", "레전더리", "태양 찌"], "b_galaxy": ["🌟", "레전더리", "은하수 찌"], "b_crown": ["🌟", "레전더리", "왕관 찌"], "b_rainbowp": ["🌟", "레전더리", "무지개 진주 찌"], "b_hourglass": ["🔮", "미스틱", "시간의 모래시계 찌"], "b_starheart": ["🔮", "미스틱", "별의 심장 찌"], "b_maple2": ["💎", "유니크", "단풍 등불 찌"], "b_gift": ["💎", "유니크", "선물상자 찌"], "b_lucky": ["💎", "유니크", "복주머니 찌"], "r_ice": ["💎", "유니크", "빙결 낚싯대"], "r_trident": ["💎", "유니크", "포세이돈 삼지창"], "r_thunder": ["💎", "유니크", "번개 낚싯대"], "r_saber": ["💎", "유니크", "광선 낚싯대"], "r_aurora": ["🌟", "레전더리", "오로라 낚싯대"], "r_dragon": ["🌟", "레전더리", "용염 낚싯대"], "r_gold2": ["🌟", "레전더리", "순금 용왕 낚싯대"], "r_cosmos": ["🔮", "미스틱", "우주의 낚싯대"], "h_coral": ["💎", "유니크", "산호 왕관"], "o_mermaid": ["💎", "유니크", "인어 공주 드레스"], "k_shell": ["💎", "유니크", "진주 조개 날개"], "h_dragon": ["🌟", "레전더리", "용의 뿔"], "o_dragon": ["🌟", "레전더리", "용비늘 갑옷"], "k_dragon": ["🌟", "레전더리", "용의 날개"], "h_angel": ["🌟", "레전더리", "천상의 화관"], "o_angel": ["🌟", "레전더리", "천상의 드레스"], "k_seraph": ["🌟", "레전더리", "세라핌 여섯 날개"], "h_dark": ["🌟", "레전더리", "흑기사 뿔 투구"], "o_dark": ["🌟", "레전더리", "흑기사 갑옷"], "k_dark": ["🌟", "레전더리", "타락천사 날개"], "h_tricorn": ["💎", "유니크", "대항해 삼각모"], "o_navy": ["💎", "유니크", "대항해 선장 코트"], "k_navy": ["💎", "유니크", "대항해 망토"], "h_royal": ["💎", "유니크", "궁중 금관"], "o_royal": ["💎", "유니크", "궁중 용포"], "k_royal": ["💎", "유니크", "금실 비단 망토"], "i_lantern": ["💎", "유니크", "등불 배낭"], "i_seahelm": ["🌟", "레전더리", "해룡 투구"], "i_seadragon": ["🌟", "레전더리", "해룡 비늘 로브"], "i_seawing": ["🌟", "레전더리", "해룡 지느러미 날개"], "i_clambob": ["💎", "유니크", "진주 조개 찌"], "i_lanternfish": ["💎", "유니크", "초롱아귀 찌"], "i_dragonbob": ["🌟", "레전더리", "해룡 비늘 찌"], "i_rodcoral": ["💎", "유니크", "산호 왕국 낚싯대"], "i_rodfog": ["🌟", "레전더리", "안개왕의 지팡이"]};   // 유니크 이상 (index.html tier)
const ISLE_ITEMS = [['i_keepcap',3e6,30],['i_keeper',5e6,50],['i_lantern',6e6,60],['i_seahelm',1e7,100],['i_seadragon',1.5e7,150],['i_seawing',2e7,200],['i_fogbob',3e6,30],['i_clambob',5e6,50],['i_lanternfish',8e6,80],['i_dragonbob',1.2e7,120],['i_rodcoral',6e6,60],['i_rodfog',1.8e7,160]];
const pvId = x => 'pv_' + x[2] + '_' + x[1];
const PV_PRICE = { o: 5e6, hat: 3e6, bk: 8e6 }, PV_ISLE_PRICE = { o: [2e6, 40], hat: [1.5e6, 30], bk: [3e6, 60] };
for (const x of PV_WEEK.concat(PV_ISLE)) LOOK_IDS[x[0]].push(pvId(x));
function pvWeek() { const n = wkNum(), pool = PV_WEEK.slice(), out = []; let seed = n * 7919 + 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const backs = pool.filter(x => x[0] === 'bk'); out.push(backs[Math.floor(rnd() * backs.length)]);
  while (out.length < 4) { const x = pool[Math.floor(rnd() * pool.length)]; if (!out.includes(x)) out.push(x); }
  return out.map(x => ({ id: pvId(x), g: PV_PRICE[x[0]] })); }
const pvIsle = () => ISLE_ITEMS.map(x => ({ id: x[0], g: x[1], sh: x[2] })).concat(PV_ISLE.map(x => ({ id: pvId(x), g: x[3], sh: x[4] })));
const wkLeftMs = () => { const n = wkNum(); return (n + 1) * 7 * 864e5 - Date.parse(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) + 0; };
function spendMsg(ws, me, m) {
  const err = text => send(ws, { t: 'ev_err', text });
  if (m.t === 'pv_list') return send(ws, { t: 'pv', week: pvWeek(), isle: pvIsle(), wk: wkNum() });
  withLock(me.key, async () => {
    const s = me.save; if (!s) return;
    if (m.t === 'aq_buy') {
      if (m.k === 'slot') { const lv = s.aqx | 0; if (lv >= 3) return err('수조가 이미 가장 커요'); const g = AQX_G[lv]; if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
        await changeBag(me.key, { g: -g }, null); s.aqx = lv + 1; }
      else { const id = String(m.id || ''), g = AQ_DECO[id]; if (!g) return; const d = Array.isArray(s.aqd) ? s.aqd : (s.aqd = []); if (d.includes(id)) return err('이미 있어요'); if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
        await changeBag(me.key, { g: -g }, null); d.push(id); const on = objOf(s, 'aqon'); if (id.startsWith('sand_')) on.sand = id; if (id.startsWith('light_')) on.light = id; }
      queueSave(me.key, s); return send(ws, Object.assign(aqPub(s, me.name, true), { note: '🐠 수족관이 좋아졌어요!' }));
    }
    if (m.t === 'aq_on') { const on = objOf(s, 'aqon'), id = String(m.id || ''), d = s.aqd || []; const k = m.k === 'light' ? 'light' : 'sand'; on[k] = id && d.includes(id) && id.startsWith(k + '_') ? id : ''; queueSave(me.key, s); return send(ws, aqPub(s, me.name, true)); }
    if (m.t === 'cos_up') {
      const id = String(m.id || ''), own = (s.cos && s.cos.own) || [], k = cosSlot(id); if (!k || !own.includes(id)) return err('가지고 있는 치장만 올릴 수 있어요');
      const cup = objOf(s, 'cup'), cur = cup[id] | 0; if (cur >= 5) return err('이미 ★5예요'); const g = cupCost(id, cur); if (!hasKey(s, 'g', g)) return err('골드가 모자라요');
      let shUse = 0; if (cur === 4) { const b = objOf(s, 'shb'); const ids = Object.keys(b).filter(x => (b[x] | 0) > 0).sort((a, c) => fishPrice(+a) - fishPrice(+c)); if (!ids.length) return err('★5에는 반짝 물고기 1마리가 필요해요 (가방 반짝 칸)'); shUse = +ids[0]; b[shUse]--; }
      await changeBag(me.key, { g: -g }, null); cup[id] = cur + 1; queueSave(me.key, s);
      me.look = cleanLook(me.look, s, me.color); broadcast({ t: 'look', id: me.id, look: me.look }, ws);
      if (cur + 1 >= 5) broadcast({ t: 'news', text: '✨ ' + me.name + ' 님이 치장을 ★5까지 올렸어요!' }, ws);
      return send(ws, { t: 'cup', cup, id, shb: s.shb, used: shUse });
    }
    if (m.t === 'pv_buy') {
      const id = String(m.id || ''), own = (s.cos && s.cos.own) || []; if (own.includes(id)) return err('이미 가지고 있어요');
      const w = pvWeek().find(x => x.id === id), i = pvIsle().find(x => x.id === id), it = w || i; if (!it) return err('이번 주에는 없는 물건이에요');
      if (i && (me.y | 0) < 60 * 16) return err('🏝️ 안개 섬의 섬 상점에서만 살 수 있어요');
      if (!hasKey(s, 'g', it.g)) return err('골드가 모자라요'); if (it.sh && !hasKey(s, 'i:shard', it.sh)) return err('안개 조각이 모자라요 (' + it.sh + '개)');
      const d = { g: -it.g }; if (it.sh) d['i:shard'] = -it.sh; await changeBag(me.key, d, null); const got = giveCos(s, [id]); queueSave(me.key, s);
      send(ws, { t: 'cos_got', ids: got }); broadcast({ t: 'news', text: (w ? '✨ ' : '🏝️ ') + me.name + ' 님이 한정 치장을 샀어요!' }, ws); return;
    }
  }).catch(e => console.error('spend', e.message));
}

/* ---------- 내 집 (2026-11-04): 방 넓히기 · 벽지 · 바닥 · 가구 놓기 · 친구 집 놀러 가기 (index.html HOME과 같은 숫자) ---------- */
const HOME_ROOM = [[6, 5], [8, 6], [10, 7], [12, 8]], HOME_ROOM_G = [0, 1e6, 5e6, 2e7];
const HOME_WALL = { w_cream: 0, w_mint: 3e4, w_pink: 3e4, w_sky: 5e4, w_stripe: 1e5, w_star: 3e5, w_wood: 2e5, w_night: 8e5, w_gold: 3e6 };
const HOME_FLOOR = { f_wood: 0, f_tile: 4e4, f_check: 8e4, f_grass: 1.5e5, f_marble: 6e5, f_carpet: 3e5, f_cloud: 1.5e6, f_gold: 4e6 };
const HOME_FUR = { chair: [2e4, 1, 1], table: [5e4, 2, 1], bed: [1.5e5, 2, 2], sofa: [2e5, 2, 1], lamp: [4e4, 1, 1], plant: [3e4, 1, 1], bigplant: [1.2e5, 1, 1], rug: [8e4, 2, 2], shelf: [1.5e5, 2, 1], wardrobe: [2.5e5, 1, 1],
  tv: [4e5, 2, 1], tank: [6e5, 2, 1], fireplace: [1e6, 2, 1], piano: [2e6, 2, 1], clock: [1.5e5, 1, 1], bear: [1e5, 1, 1], cake: [6e4, 1, 1], trophy: [8e5, 1, 1], arcade: [1.2e6, 1, 1], starlamp: [5e5, 1, 1],
  goldfish: [3e6, 1, 1], fountain: [8e6, 2, 2], cherry: [5e6, 2, 2], throne: [1e7, 1, 1],
  chandelier: [2e7, 2, 1], canopy: [4e7, 2, 2], harp: [3e7, 1, 1], bigaq: [6e7, 2, 2], armor: [3e7, 1, 1], swordrack: [5e7, 2, 1], globe: [8e7, 1, 1], castle: [1e8, 2, 2] };
const homeOf = s => { const h = s.home && typeof s.home === 'object' ? s.home : (s.home = {}); h.lv = Math.max(0, Math.min(3, h.lv | 0)); if (!HOME_WALL.hasOwnProperty(h.wall)) h.wall = 'w_cream'; if (!HOME_FLOOR.hasOwnProperty(h.floor)) h.floor = 'f_wood';
  h.own = h.own && typeof h.own === 'object' ? h.own : {}; h.walls = Array.isArray(h.walls) ? h.walls : ['w_cream']; h.floors = Array.isArray(h.floors) ? h.floors : ['f_wood']; h.items = Array.isArray(h.items) ? h.items : []; return h; };
function homeClean(h, items) {   // 방 안 · 가진 수만큼 · 겹치지 않게
  const [W, H] = HOME_ROOM[h.lv], used = {}, cnt = {}, out = [];
  for (const it of Array.isArray(items) ? items.slice(0, 60) : []) { if (!Array.isArray(it)) continue; const [id, x, y] = [String(it[0]), it[1] | 0, it[2] | 0], F = HOME_FUR[id]; if (!F) continue;
    if ((cnt[id] | 0) >= (h.own[id] | 0) || x < 0 || y < 0 || x + F[1] > W || y + F[2] > H) continue; let ok = true;
    if (id !== 'rug') for (let dx = 0; dx < F[1]; dx++) for (let dy = 0; dy < F[2]; dy++) if (used[(x + dx) + ',' + (y + dy)]) ok = false;
    if (!ok) continue; if (id !== 'rug') for (let dx = 0; dx < F[1]; dx++) for (let dy = 0; dy < F[2]; dy++) used[(x + dx) + ',' + (y + dy)] = 1; cnt[id] = (cnt[id] | 0) + 1; out.push([id, x, y]); }
  return out;
}
const homeScore = h => { let v = HOME_ROOM_G[h.lv] / 1e4 + (HOME_WALL[h.wall] + HOME_FLOOR[h.floor]) / 1e4; for (const it of h.items) v += (HOME_FUR[it[0]] || [0])[0] / 1e4; return Math.round(v); };
const homePub = (s, name, mine, liked, look) => { const h = homeOf(s); return { t: 'home', name, mine, liked: !!liked, lv: h.lv, wall: h.wall, floor: h.floor, items: h.items, likes: s.hml | 0, look: look || null, own: mine ? h.own : null, walls: mine ? h.walls : null, floors: mine ? h.floors : null, score: homeScore(h) }; };
function homeMsg(ws, me, m) {
  const err = text => send(ws, { t: 'ev_err', text });
  if (m.t === 'home_get') return (async () => { const key = String(m.name || me.name).toLowerCase(), sv = key === me.key ? me.save : await loadSave(key); if (!sv) return err('그런 집이 없어요');
    const g = me.save && me.save.hmlg && me.save.hmlg.d === kstDay() ? me.save.hmlg.k : [];
    send(ws, homePub(sv, (rosterCache.get(key) || {}).name || m.name || me.name, key === me.key, g.includes(key), cleanLook(sv.cos && sv.cos.look, sv, colorOf(key)))); })().catch(() => { });
  if (m.t === 'home_list') return (async () => { const list = []; for (const [key, r] of rosterCache) { const sv = await loadSave(key); if (sv && sv.home && (sv.home.items || []).length) list.push({ name: r.name, likes: sv.hml | 0, score: homeScore(homeOf(sv)) }); } list.sort((a, b) => b.likes - a.likes || b.score - a.score); send(ws, { t: 'home_list', list: list.slice(0, 30) }); })().catch(() => { });
  if (m.t === 'home_like') { const key = String(m.name || '').toLowerCase(); if (key === me.key || !rosterCache.has(key)) return;
    return withLocks([me.key, key], async () => { const s = me.save, t = await loadSave(key); if (!s || !t) return; const g = s.hmlg && s.hmlg.d === kstDay() ? s.hmlg : (s.hmlg = { d: kstDay(), k: [] });
      if (g.k.includes(key)) return err('오늘은 이미 좋아요를 눌렀어요'); g.k.push(key); t.hml = (t.hml | 0) + 1; queueSave(me.key, s); queueSave(key, t);
      send(ws, homePub(t, (rosterCache.get(key) || {}).name, false, true, cleanLook(t.cos && t.cos.look, t, colorOf(key))));
      const l = liveByKey(key); if (l) send(l[0], { t: 'news', text: '🏠 ' + me.name + ' 님이 우리 집에 좋아요를 눌렀어요 (♥ ' + t.hml + ')' }); }).catch(() => { }); }
  withLock(me.key, async () => {
    const s = me.save; if (!s) return; const h = homeOf(s), done = () => { queueSave(me.key, s); send(ws, homePub(s, me.name, true, false, me.look)); };
    if (m.t === 'home_buy') {
      let g = 0; const id = String(m.id || '');
      if (m.k === 'room') { if (h.lv >= 3) return err('가장 넓은 집이에요'); g = HOME_ROOM_G[h.lv + 1]; }
      else if (m.k === 'wall') { if (!HOME_WALL.hasOwnProperty(id) || h.walls.includes(id)) return; g = HOME_WALL[id]; }
      else if (m.k === 'floor') { if (!HOME_FLOOR.hasOwnProperty(id) || h.floors.includes(id)) return; g = HOME_FLOOR[id]; }
      else if (m.k === 'fur') { if (!HOME_FUR[id]) return; if ((h.own[id] | 0) >= 9) return err('9개까지 가질 수 있어요'); g = HOME_FUR[id][0]; }
      else return;
      if (!hasKey(s, 'g', g)) return err('골드가 모자라요'); if (g) await changeBag(me.key, { g: -g }, null);
      if (m.k === 'room') { h.lv++; broadcast({ t: 'news', text: '🏠 ' + me.name + ' 님의 집이 넓어졌어요!' }, ws); }
      else if (m.k === 'wall') { h.walls.push(id); h.wall = id; } else if (m.k === 'floor') { h.floors.push(id); h.floor = id; } else h.own[id] = (h.own[id] | 0) + 1;
      return done();
    }
    if (m.t === 'home_set') { if (m.wall && h.walls.includes(m.wall)) h.wall = m.wall; if (m.floor && h.floors.includes(m.floor)) h.floor = m.floor; if (m.items) h.items = homeClean(h, m.items); return done(); }
  }).catch(e => console.error('home', e.message));
}

const aqPub = (s, name, mine, liked) => ({ t: 'aq', name, slots: aqClean(s, s.aq), likes: s.aql | 0, mine, liked: !!liked, max: aqMax(s), deco: Array.isArray(s.aqd) ? s.aqd : [], on: s.aqon || {} });
function aqMsg(ws, me, m) {
  if (m.t === 'aq_set') return withLock(me.key, () => { const s = me.save; if (!s) return; s.aq = aqClean(s, m.slots); queueSave(me.key, s); send(ws, aqPub(s, me.name, true)); }).catch(() => { });
  if (m.t === 'aq_list') return (async () => { const list = []; for (const [key, r] of rosterCache) { const sv = await loadSave(key); if (sv && Array.isArray(sv.aq) && sv.aq.length) list.push({ name: r.name, n: sv.aq.length, likes: sv.aql | 0, sh: sv.aq.filter(x => x.sh).length }); } list.sort((a, b) => b.likes - a.likes); send(ws, { t: 'aq_list', list }); })().catch(() => { });
  if (m.t === 'aq_get') return (async () => { const key = String(m.name || '').toLowerCase(), sv = await loadSave(key); if (!sv) return send(ws, { t: 'ev_err', text: '그런 수족관이 없어요' });
    const g = me.save && me.save.aqlg && me.save.aqlg.d === kstDay() ? me.save.aqlg.k : [];
    send(ws, aqPub(sv, (rosterCache.get(key) || {}).name || m.name, key === me.key, g.includes(key))); })().catch(() => { });
  if (m.t === 'aq_like') { const key = String(m.name || '').toLowerCase(); if (key === me.key || !rosterCache.has(key)) return;
    return withLocks([me.key, key], async () => { const s = me.save, t = await loadSave(key); if (!s || !t) return; const g = s.aqlg && s.aqlg.d === kstDay() ? s.aqlg : (s.aqlg = { d: kstDay(), k: [] });
      if (g.k.includes(key)) return send(ws, { t: 'ev_err', text: '오늘은 이미 좋아요를 눌렀어요' }); g.k.push(key); t.aql = (t.aql | 0) + 1; queueSave(me.key, s); queueSave(key, t);
      send(ws, aqPub(t, (rosterCache.get(key) || {}).name, false, true));
      const l = liveByKey(key); if (l) send(l[0], { t: 'news', text: '🐠 ' + me.name + ' 님이 내 수족관에 좋아요를 눌렀어요 (♥ ' + t.aql + ')' }); }).catch(() => { }); }
}

/* ---------- 낚시터 정복 ---------- */
const ZRW = { tk: [10, 12, 15, 20, 25, 20], g: [5000, 15000, 40000, 100000, 200000, 150000] };   // index.html ZRW와 같아야 해요
const ZONE_COS = { 1: ['lotus', 'pondrobe'], 2: ['leaf', 'streamsuit'], 3: ['whalehat', 'sunset'], 4: ['jelly', 'deepsea'], 5: ['mooncrown', 'starcloak'] };
const ZONE_NAMES = ['잔잔한 연못', '속삭이는 시냇가', '노을 바닷가', '푸른 먼바다', '달빛 호수', '안개 섬'];
function zoneFishIds(z) { if (z === 6) return Array.from({ length: ISLE_N }, (_, i) => ISLE_FIRST + i); const a = []; for (let i = 0; i < 20; i++) { a.push((z - 1) * 20 + i); a.push(100 + (z - 1) * 20 + i); } return a; }
function giveCos(s, ids) { const c = s.cos && typeof s.cos === 'object' ? s.cos : (s.cos = {}); c.own = Array.isArray(c.own) ? c.own : []; const g = Array.isArray(s.cosg) ? s.cosg : (s.cosg = []); const got = [];
  for (const id of ids) { if (!c.own.includes(id)) { c.own.push(id); got.push(id); } if (!g.includes(id)) g.push(id); } return got; }

/* ---------- 4인 배낚시 3.0: 모집 → 4명 이상 출항 → 10분 · 어창 · 바다 이벤트 · 보스 2번(모두가 같이 당겨야) · 만선 귀항 투표 → 귀항 보상 ----------
   - 바다 위에서 접속이 끊겨도 선원으로 남아요. 다시 들어오면 갑판으로 돌아가요 (보스는 접속 중인 사람만 같이 당기면 돼요)
   - 만선(어창 가득)이 되면 바로 귀항 투표를 할 수 있어요. 안 돌아가고 계속 낚으면 대만선(2배)에 도전 */
const PT_MIN = 3 /* 2026-11-09: 3명부터 (예전 4명) */, PT_MAX = 5, PT_MS = 10 * 60e3, PT_DAY = 2, PT_BOSS_AT = [3.5 * 60e3, 7.5 * 60e3], PT_BOSS_MS = 30e3, PT_LOBBY_MS = 15 * 60e3, PT_TAP_MIN = 14, PT_BOSS_PER = 20;   /* 2026-11-09: 리듬으로 바뀌어서 (링에 맞게 톡) */
const PT_EV = ['dolphin', 'gull', 'school', 'marlin', 'whale', 'wave'], PT_EV_MS = 30e3;   // index.html SEA_EV와 같은 이름
let party = null, ptSendT = 0;
const PT_WEEK = 12, ptDay = () => PT_WEEK + (arkSt() >= 4 ? 4 : 0);   // 2026-11-05: 하루 대신 한 주에 (몰아서 가도 돼요) · ⛵ 물결 범선: +4
const ptToday = s => { const r = s && s.ptd; return r && r.w === wkId() ? r.n | 0 : 0; };   // 이번 주 나간 횟수
const ptLive = () => party ? party.members.filter(k => liveByKey(k)) : [];
function ptPub() {
  if (!party) return null; const b = party.boss, now = Date.now();
  return { state: party.state, leader: party.names[party.leader], members: party.members.map(k => party.names[k]), on: party.members.map(k => !!liveByKey(k)),
    hold: party.hold, need: party.need, end: party.end, goAt: party.goAt || 0, votes: party.votes ? party.votes.length : 0, fullAt: party.fullAt || 0,
    ev: party.ev && party.ev.until > now ? party.ev : null, bossN: party.bossN | 0, bossWin: party.bossWin | 0,
    boss: b ? { k: b.k, got: b.got, need: b.need, until: b.until, min: PT_TAP_MIN, taps: party.members.map(k => b.taps[k] | 0), miss: party.members.map(k => (b.miss || {})[k] | 0), seed: b.seed, at: b.at, sn: Date.now() } : null };
}
function ptSend(extra) { for (const [ws, p] of players) send(ws, Object.assign({ t: 'pt', p: ptPub(), today: ptToday(p.save) }, extra ? extra(p) : {})); }
function ptSoon() { if (ptSendT) return; ptSendT = setTimeout(() => { ptSendT = 0; ptSend(); }, 300); }
function ptClear() { if (party) for (const t of party.timers || []) clearTimeout(t); }
const ptTell = text => { if (party) for (const k of party.members) { const l = liveByKey(k); if (l) send(l[0], { t: 'news', text }); } };
function ptMsg(ws, me, m) {
  const now = Date.now(), isMem = party && party.members.includes(me.key);
  /* 항구의 '물결 어선'에 직접 걸어가서 타요 (부두 근처에 있어야 해요). 첫 사람이 타면 모집 시작 · 4명이 타면 20초 뒤 자동 출항 (선장은 바로 출항) */
  if (m.t === 'pt_open' || m.t === 'pt_join' || m.t === 'pt_board') {
    if (isMem && party.state === 'sea') return ptSend();   // 다시 들어온 선원: 상태만 다시 알려 줘요
    const tx = (me.x | 0) / 16, ty = (me.y | 0) / 16; if (tx < 14 || tx > 23 || ty < 43 || ty > 50) return send(ws, { t: 'news', text: '⚓ 항구 부두의 물결 어선 앞에서 탈 수 있어요' });
    if (ptToday(me.save) >= ptDay()) return send(ws, { t: 'news', text: '이번 주 배낚시는 ' + ptDay() + '번 다 나갔어요 (월요일에 다시)' });
    if (!party) {
      party = { leader: me.key, members: [me.key], names: { [me.key]: me.name }, state: 'lobby', hold: 0, need: 0, end: 0, boss: null, timers: [], last: {}, goAt: 0 };
      party.timers.push(setTimeout(() => { if (party && party.state === 'lobby') { ptClear(); party = null; ptSend(); } }, PT_LOBBY_MS));
      broadcast({ t: 'news', text: '⚓ ' + me.name + ' 님이 물결 어선에 탔어요! 항구로 와서 같이 타요 (' + PT_MIN + '명부터 출항)' }, ws);
      return ptSend();
    }
    if (party.state !== 'lobby' || isMem) return; if (party.members.length >= PT_MAX) return send(ws, { t: 'news', text: '어선이 꽉 찼어요 (' + PT_MAX + '명)' });
    party.members.push(me.key); party.names[me.key] = me.name;
    if (party.members.length >= PT_MIN && !party.goAt) { party.goAt = now + 20e3; party.timers.push(setTimeout(() => { if (party && party.state === 'lobby' && party.goAt) ptGo(); }, 20e3)); broadcast({ t: 'news', text: '⚓ 물결 어선 ' + party.members.length + '명! 20초 뒤 출항해요 (더 탈 사람은 서둘러요)' }); }
    return ptSend();
  }
  if (!party) return;
  if (m.t === 'pt_leave') { if (isMem) ptRemove(me.key); return; }
  if (m.t === 'pt_go') { if (party.state !== 'lobby' || party.leader !== me.key) return; return ptGo(ws); }
  if (!isMem || party.state !== 'sea') return;
  if (m.t === 'pt_catch') {
    if (now - (party.last[me.key] || 0) < 1200) return; party.last[me.key] = now;
    const school = party.ev && party.ev.k === 'school' && party.ev.until > now;
    const pp = [1, 2, 4, 8, 15][Math.max(0, Math.min(4, m.rar | 0))] * (school ? 2 : 1); const st = ptSt(me.key); st.c++; st.pts += pp; ptAdd(pp); return ptSoon();
  }
  if (m.t === 'pt_home') {   // 만선이면 귀항 투표 · 접속한 선원 절반 이상이면 바로 돌아가요
    if (party.hold < party.need || party.boss) return;
    party.votes = party.votes || []; if (party.votes.indexOf(me.key) < 0) party.votes.push(me.key);
    const live = ptLive().length, need = Math.max(1, Math.ceil(live / 2));
    if (party.votes.filter(k => liveByKey(k)).length >= need) { ptTell('⚓ 만선 귀항! 뱃머리를 항구로 돌려요'); return ptEnd(); }
    ptTell('⚓ ' + me.name + ' 님이 귀항에 한 표 (' + party.votes.length + '/' + need + ')'); return ptSend();
  }
  if (m.t === 'pt_miss') { const b = party.boss; if (!b) return; b.miss = b.miss || {}; if ((b.miss[me.key] | 0) > 200) return; b.miss[me.key] = (b.miss[me.key] | 0) + 1; ptSt(me.key).miss++; return ptSoon(); }
  if (m.t === 'pt_tap') {
    const b = party.boss; if (!b) return; const tc = b.tc[me.key] || (b.tc[me.key] = []); while (tc.length && now - tc[0] > 1000) tc.shift(); if (tc.length >= 10) return; tc.push(now);
    b.got++; b.taps[me.key] = (b.taps[me.key] | 0) + 1; ptSt(me.key).hit++;
    const live = ptLive(); if (b.got >= b.need && live.every(k => (b.taps[k] | 0) >= PT_TAP_MIN)) ptBossWin(); else ptSoon();
  }
}
const ptSt = key => { party.st = party.st || {}; return party.st[key] || (party.st[key] = { c: 0, pts: 0, hit: 0, miss: 0 }); };
function ptAdd(n) {
  const was = party.hold; party.hold += n;
  if (was < party.need && party.hold >= party.need) { party.fullAt = Date.now(); ptTell('🚩 만선!! 어창이 가득 찼어요. 귀항 투표로 바로 돌아가거나, 계속 낚아서 대만선(' + party.need * 2 + ')에 도전해요'); ptSend(p => party.members.includes(p.key) ? { full: 1 } : {}); }
  else if (was < party.need * 2 && party.hold >= party.need * 2) { ptTell('🏆 대만선!!! 어창이 두 배로 넘쳐요. 귀항 보상이 커져요'); ptSend(p => party.members.includes(p.key) ? { full: 2 } : {}); }
}
function ptGo(ws) {
  if (!party || party.state !== 'lobby') return; const now = Date.now();
  party.members = party.members.filter(k => liveByKey(k));
  if (party.members.length < PT_MIN) { party.goAt = 0; ptSend(); if (ws) send(ws, { t: 'news', text: PT_MIN + '명이 타야 출항할 수 있어요' }); return; }
  ptClear(); party.timers = []; party.state = 'sea'; party.goAt = 0; party.end = now + PT_MS + 3000; party.need = 40 * party.members.length; party.hold = 0; party.votes = []; party.bossN = 0; party.bossWin = 0; party.bossKinds = [];
  for (const k of party.members) { const l = liveByKey(k); if (l && l[1].save) { const s = l[1].save; s.ptd = { w: wkId(), n: ptToday(s) + 1 }; queueSave(k, s); } }
  for (const at of PT_BOSS_AT) party.timers.push(setTimeout(ptBoss, at));
  party.timers.push(setTimeout(ptEnd, PT_MS + 3000), setTimeout(ptEvent, 35e3 + Math.random() * 20e3));
  broadcast({ t: 'news', text: '⚓ ' + party.members.map(k => party.names[k]).join(', ') + ' 님이 물결 어선을 타고 먼바다로 떠났어요!' });
  ptSend(p => party.members.includes(p.key) ? { go: party.members.indexOf(p.key) } : { sail: 1 });
}
/* 바다 이벤트: 40~75초마다 하나씩 (보스 중엔 쉬어요). 모두 같은 장면을 봐요 */
function ptEvent() {
  if (!party || party.state !== 'sea') return; const now = Date.now();
  party.timers.push(setTimeout(ptEvent, 40e3 + Math.random() * 35e3));
  if (party.boss || party.end - now < 25e3) return;
  const last = party.ev && party.ev.k; let k; do k = PT_EV[(Math.random() * PT_EV.length) | 0]; while (k === last);
  party.ev = { k, until: now + PT_EV_MS, at: now };
  if (k === 'whale') ptAdd(3 * party.members.length);   // 행운의 고래: 어창 보너스
  if (k === 'wave') ptAdd(2 * party.members.length);    // 큰 파도가 갑판에 물고기를 올려 보내요
  ptSend(p => party.members.includes(p.key) ? { sev: k } : {});
}
function ptBoss() {
  if (!party || party.state !== 'sea' || party.boss) return; const now = Date.now();
  const used = party.bossKinds || [], pool = [0, 0, 0, 1, 1, 2].filter(k => used.indexOf(k) < 0); const k = pool.length ? pool[(Math.random() * pool.length) | 0] : 0; used.push(k); party.bossKinds = used;
  party.ev = null; party.bossN = (party.bossN | 0) + 1;
  party.boss = { k, got: 0, need: PT_BOSS_PER * Math.max(1, ptLive().length), until: now + PT_BOSS_MS, taps: {}, tc: {}, miss: {}, seed: crypto.randomBytes(4).readUInt32LE(0), at: now };
  const b = party.boss;
  party.timers.push(setTimeout(() => { if (party && party.boss === b) { const lazy = ptLive().filter(k => (b.taps[k] | 0) < PT_TAP_MIN).map(k => party.names[k]); party.boss = null;
    ptTell(BOSS_NAMES[b.k] + '(이)가 줄을 끊고 사라졌어요…' + (lazy.length ? ' (' + lazy.join(', ') + ' 님이 ' + PT_TAP_MIN + '번 이상 당겨야 했어요)' : ' (조금만 더 빨리 연타했으면!)')); ptSend(p => party.members.includes(p.key) ? { bossEnd: 'lost' } : {}); } }, PT_BOSS_MS));
  ptSend(p => party.members.includes(p.key) ? { boss: 1 } : {});
}
async function ptBossWin() {
  const b = party.boss, id = BOSS_IDS[b.k] || BOSS_ID, mem = party.members.slice(); party.boss = null; party.bossWin = (party.bossWin | 0) + 1; ptAdd(20);
  ptSend(p => party.members.includes(p.key) ? { bossEnd: 'win', bk: b.k } : {});
  broadcast({ t: 'news', text: '🎉 ' + mem.map(k => party.names[k]).join(', ') + ' 님이 다 같이 ' + BOSS_NAMES[b.k] + '(을)를 낚았어요!' });
  for (const k of mem) await withLock(k, async () => {
    await changeBag(k, { [id]: 1 }, '🎉 다 같이 ' + BOSS_NAMES[b.k] + '(을)를 낚았어요!');
    const s = await loadSave(k); if (!s) return; const sd = sdexOf(s); sd[id] = (sd[id] | 0) + 1; queueSave(k, s);   // 다 같이 당긴 것도 손맛
    const l = liveByKey(k); if (l) send(l[0], { t: 'sdex', sdex: sd });
  }).catch(e => console.error('boss', e.message));
}
function ptRemove(key) {
  if (!party) return; party.members = party.members.filter(k => k !== key);
  const l = liveByKey(key); if (l && party.state === 'sea') send(l[0], { t: 'pt', p: ptPub(), end: '먼저 돌아왔어요 (보상 없음)' });
  if (!party.members.length) { ptClear(); party = null; return ptSend(); }
  if (party.leader === key) party.leader = party.members[0];
  if (party.state === 'lobby' && party.members.length < PT_MIN) party.goAt = 0;
  ptSend();
}
async function ptEnd() {
  if (!party || party.state !== 'sea') return; const P = party; ptClear(); party = null;
  const full = P.hold >= P.need, big = P.hold >= P.need * 2, tk = big ? 6 : full ? 4 : 2, g = (big ? 3000000 : full ? 1500000 : 400000) + (P.bossWin | 0) * 500000, mats = ['knack', 'knack', 'shell', 'weed'];   /* 2026-11-09: 10분 몰입한 만큼 크게 */
  const STS = P.st || {}, mvp = P.members.slice().sort((a, b) => ((STS[b] || {}).pts | 0) - ((STS[a] || {}).pts | 0))[0];
  broadcast({ t: 'pt_result', hold: P.hold, need: P.need, full, big, boss: P.bossWin | 0, list: P.members.map(k => { const x = STS[k] || {}; return { name: P.names[k], c: x.c | 0, pts: x.pts | 0, hit: x.hit | 0, miss: x.miss | 0, g, tk: tk + (k === mvp && (x.pts | 0) > 0 ? 2 : 0) }; }) });
  for (const k of P.members) {
    await withLock(k, async () => {
      const s = await loadSave(k); if (!s) return;
      const d = { g }; let items = 0; for (let i = 0; i < (big ? 2 : full ? 1 : 0); i++) { const it = mats[(Math.random() * mats.length) | 0]; d['i:' + it] = (d['i:' + it] | 0) + 1; items++; }
      const e = enhOf(s), out = []; enhDaily(e, out); e.tk = Math.min(ENH.TK_MAX, e.tk + tk + (k === mvp && ((STS[k] || {}).pts | 0) > 0 ? 2 : 0));
      const own = (s.cos && s.cos.own) || [], drop = [];
      if (full && !own.includes('lifejacket') && Math.random() < (big ? .5 : .3)) drop.push('lifejacket');
      if (full && !own.includes('pirate') && Math.random() < (big ? .12 : .06)) drop.push('pirate');
      const got = giveCos(s, drop);
      await changeBag(k, d, null);
      const msg = '⚓ 귀항! 어창 ' + P.hold + '/' + P.need + (big ? ' 대만선!!' : full ? ' 만선!' : '') + ' · 강화권 +' + tk + ' · 골드 +' + g + (items ? ' · 재료 +' + items : '') + (got.length ? ' · 새 옷!' : '') + (P.bossWin ? ' · 보스 ' + P.bossWin + '마리 🎉' : '');
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
  rosterCache.set(key, { name, job, lv: vlOf(save && save.vl), sit: jobRank(save, 'tam', 'sit') > 0, legs: legZones(save), sd: sdN(save), gt: gtN(save), sh: shN(save), dex: dexIds(save && save.dex), help: save && save.help ? save.help.n | 0 : 0, hl: cpOf(save), mar: (save && save.mar && save.mar.p) || '', jr: jrOf(save, job), jx: (save && save.job && save.job.xp && save.job.xp[job]) | 0 });
  if (save && save.boat && !vBoat) vBoat = { by: name };
  rosterSoon();
}
const shN = s => { const d = (s && s.shiny && typeof s.shiny === 'object') ? s.shiny : {}; let n = 0; for (const k in d) if ((d[k] | 0) > 0) n++; return n; };
const gtN = s => (s && s.giant && typeof s.giant === 'object') ? Object.keys(s.giant).length : 0;
const dexIds = d => { const out = []; if (d && typeof d === 'object') for (const k in d) if (d[k] && d[k].n > 0 && validFish(+k)) out.push(+k); return out; };
/* 👑 손맛 왕 (2026-11-05): 손맛 도감(직접 낚은 종 수) 1등만. 더 많이 낚아야 빼앗을 수 있고, 같으면 지금 왕이 지켜요 */
let sdKing = null;
function sdKingCheck(init) {
  let best = null; for (const [k, r] of rosterCache) { const n = r.sd | 0; if (n > 0 && (!best || n > best.n)) best = { key: k, name: r.name, n }; }
  if (!best) return;
  if (sdKing && rosterCache.has(sdKing.key)) { const cur = rosterCache.get(sdKing.key).sd | 0; sdKing.n = cur; sdKing.name = rosterCache.get(sdKing.key).name; if (best.key !== sdKing.key && best.n <= cur) return; }
  if (sdKing && best.key === sdKing.key) return;
  const prev = sdKing; sdKing = { key: best.key, name: best.name, n: best.n, since: Date.now() };
  if (init) return;
  broadcast({ t: 'news', text: prev ? '👑 손맛 왕좌가 바뀌었어요! ' + best.name + ' 님이 ' + prev.name + ' 님에게서 왕관을 빼앗았어요 (' + best.n + '종)' : '👑 첫 손맛 왕 탄생! ' + best.name + ' 님 (' + best.n + '종)' });
  console.log('손맛 왕', best.name, best.n);
}
const kingPub = () => sdKing ? { name: sdKing.name, n: sdKing.n, since: sdKing.since } : null;
/* 🌊 월척 왕 (거대 개체 종 수) · ✨ 반짝 왕 (반짝 종 수) (2026-11-09): 손맛 왕처럼 1등만, 같으면 지금 왕이 지켜요 */
const xKing = { gt: null, sh: null, hl: null }, XK_NAME = { gt: ['🌊 월척 왕', '종 월척'], sh: ['✨ 반짝 왕', '종 반짝'], hl: ['⚔️ 용사 왕', '전투력'] };
function xKingCheck(f, init) {
  let best = null; for (const [k, r] of rosterCache) { const n = r[f] | 0; if (n > (f === 'hl' ? 199 : 0) && (!best || n > best.n)) best = { key: k, name: r.name, n }; }
  if (!best) return; const cur = xKing[f];
  if (cur && rosterCache.has(cur.key)) { const c = rosterCache.get(cur.key)[f] | 0; cur.n = c; cur.name = rosterCache.get(cur.key).name; if (best.key !== cur.key && best.n <= c) return; }
  if (cur && best.key === cur.key) return;
  xKing[f] = { key: best.key, name: best.name, n: best.n, since: Date.now() };
  if (!init && rosterCache.size > 1) broadcast({ t: 'news', text: XK_NAME[f][0] + ' 탄생! ' + best.name + ' 님 (' + (f === 'hl' ? '전투력 ' + best.n : best.n + XK_NAME[f][1]) + ')' });
}
const xKingPub = () => { const o = {}; { const eb = Object.entries((V && V.ebTop) || {}).sort((a, b) => b[1] - a[1])[0]; o.eb = eb && eb[1] > 0 ? { name: eb[0], n: eb[1] } : null; } for (const f of ['gt', 'sh', 'hl']) { xKingCheck(f, !xKingCheck.ready); const k = xKing[f]; o[f] = k ? { name: k.name, n: k.n } : null; } xKingCheck.ready = 1; return o; };
/* 🎣 하루 낚시왕 (2026-11-09): 오늘 직접 낚은 마릿수 · 반짝 50마리 · 신화 100마리로 쳐요 · 한국 자정에 1등에게 1천만 골드 */
const DAYK_G = 10000000;
function dayPts(me, s, oldSd) { const nsd = s.sdex || {}; let pts = 0; for (const k in nsd) { const dn = Math.max(0, (nsd[k] | 0) - (oldSd[k] | 0)); if (dn) pts += dn * (isMyth(+k) ? 100 : 1); } return pts; }
function dayAdd(key, name, n) { if (!V || !n) return; const d = kstDay(); if (!V.dk || V.dk.d !== d) { dayClose(); V.dk = { d, p: {} }; } const p = V.dk.p; p[key] = p[key] || { n: 0, name }; p[key].n += n; p[key].name = name; vMark(); dkSoon(); }
function dayClose() { if (!V || !V.dk || V.dk.paid) return; const arr = Object.entries(V.dk.p).sort((a, b) => b[1].n - a[1].n); V.dk.paid = 1; if (!arr.length || V.dk.d === kstDay()) return; const [k, r] = arr[0];
  changeBag(k, { g: DAYK_G }, '🎣 어제의 낚시왕! 1천만 골드').catch(() => { }); addMail(k, '🎣 ' + V.dk.d + ' 하루 낚시왕! ' + r.n + '마리 · 1천만 골드를 받았어요');
  broadcast({ t: 'news', text: '🎣 어제의 낚시왕은 ' + r.name + ' 님! (' + r.n + '마리) 1천만 골드를 받았어요' }); V.dkLast = { d: V.dk.d, name: r.name, n: r.n }; }
const dkPub = () => { const d = kstDay(), dk = V && V.dk && V.dk.d === d ? V.dk : null; return { t: 'dayk', d, list: dk ? Object.values(dk.p).sort((a, b) => b.n - a.n).slice(0, 10) : [], last: V && V.dkLast || null, g: DAYK_G }; };
let dkT = 0; function dkSoon() { if (dkT) return; dkT = setTimeout(() => { dkT = 0; broadcast(dkPub()); }, 1500); }
setInterval(() => { if (V && V.dk && V.dk.d !== kstDay() && !V.dk.paid) { dayClose(); V.dk = { d: kstDay(), p: {} }; vMark(); dkSoon(); } }, 60000);
function rosterSoon() { clearTimeout(rosterT); rosterT = setTimeout(rosterSend, 500); }
function rosterSend(force) {
  const live = new Set([...players.values()].map(p => p.key));
  const list = [...rosterCache.entries()].map(([k, r]) => ({ name: r.name, job: r.job, lv: r.lv, on: live.has(k), sit: r.sit && live.has(k), sd: r.sd | 0, gt: r.gt | 0, help: r.help | 0, jr: r.jr | 0 }));
  const vdex = [...new Set([...rosterCache.values()].flatMap(r => r.dex || []))].sort((a, b) => a - b);   // 마을 도감: 모두가 만난 물고기
  const note = vNote && vNote.d === kstDay() ? vNote : null, paths = [...new Set([...rosterCache.values()].flatMap(r => r.legs || []))].sort();
  // 누릉이가 따라다니는 '오늘의 주인공': 오늘 직접 제일 많이 낚은 친구. 아직 아무도 안 낚았으면 30분마다 접속한 친구를 돌아가며
  let rich = null, rn = 0; const on = []; for (const p of players.values()) { if (!p.save) continue; on.push(p.name); const n = p.tday && p.tday.d === kstDay() ? p.tday.n : 0; if (n > rn) { rn = n; rich = p.name; } }
  if (!rich && on.length) { on.sort(); rich = on[Math.floor(Date.now() / 1800e3) % on.length]; }
  sdKingCheck(); const king = kingPub(), kings = xKingPub();
  const sig = JSON.stringify([list, note, vBoat, paths, vdex, rich, king && king.name, king && king.n, kings]);
  if (!force && sig === rosterSig) return; rosterSig = sig;
  broadcast({ t: 'roster', list, note, boat: vBoat, paths, vdex, rich, king, kings });
}
/* 마을 기부함: 모두의 저장에 흩어진 기부를 모아서 봐요 */
const BOAT_NEED = { 'i:knack': 13, 'i:map': 1, 'i:sail': 1, g: 10000000 }, DONORS_NEED = 4, DON_MIN_G = 10000;   // index.html BOAT_NEED와 같아야 해요
/* 한 사람이 넣을 수 있는 양: 재료는 필요한 양의 절반(최소 1), 골드는 1만까지. 골드는 목표를 넘어도 받아서 누구나 기부에 참여할 수 있어요 */
const donCap = k => k === 'g' ? 5000000 : Math.max(1, Math.ceil(BOAT_NEED[k] / 2));   // 골드는 한 사람 500만까지
async function boxState() {
  const tot = {}, donors = [], per = {};
  for (const key of rosterCache.keys()) {
    const sv = await loadSave(key), d0 = sv && sv.don; if (!d0 || typeof d0 !== 'object') continue;
    const d = {}; for (const k in d0) { const nk = mkKey(k); d[nk] = (d[nk] | 0) + (d0[k] | 0); }   // 옛 재료 이름으로 낸 것도 솜씨 재료로 세요
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
    await vLoad();
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
db.roster().then(rows => { for (const r of rows || []) { if (String(r.key).startsWith('__')) continue; if (r.boat && !vBoat) vBoat = { by: r.name }; if (!rosterCache.has(r.key)) rosterCache.set(r.key, { name: r.name, job: r.job && r.job.id || '', lv: vlOf(r.vl), sit: false, legs: legZones({ dex: r.dex }), sd: sdN({ sdex: r.sdex }), gt: gtN({ giant: r.giant }), dex: dexIds(r.dex), help: r.help ? r.help.n | 0 : 0, jr: jrOf({ job: r.job }, r.job && r.job.id), jx: (r.job && r.job.xp && r.job.id && r.job.xp[r.job.id]) | 0 }); } sdKingCheck(true); console.log('현황판', rosterCache.size, '명'); }).catch(e => console.error('현황판을 읽지 못했어요', e.message));
db.ranks().then(rows => { for (const r of (rows || []).filter(r => !String(r.key).startsWith('__'))) rankSet(r.key, r.name, r.enh, cleanLook(r.look, { cos: { own: Array.isArray(r.own) ? r.own : [] }, enh: r.enh }, colorOf(r.key))); champBoot = true; console.log('강화 순위', rankCache.size, '명 · 동상', champ ? champ.name + ' +' + champ.lv : '없음'); }).catch(e => { champBoot = true; console.error('강화 순위를 읽지 못했어요', e.message); });

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
  await Promise.all([...pending.keys()].map(flushSave)); await vFlush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log('물결마을 서버 시작: 포트 ' + PORT));
