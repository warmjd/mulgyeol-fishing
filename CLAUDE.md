# 물결마을 낚시터 — Claude 작업 안내서

새 대화에서 「물결마을 ○○ 바꿔줘」라고 하면 이 저장소(warmjd/mulgyeol-fishing) 이야기예요. 이 파일을 먼저 읽고 바로 일해요.

## 구성
- `index.html` — 게임 전부 (캔버스 픽셀 월드, 약 1.2만 줄 한 파일). `server.js` — Node(express + ws) 서버, Supabase에 저장 (Render 배포).
- main에 바로 커밋 · 푸시해요. 커밋 끝에 세션이 알려 주는 Co-Authored-By · Claude-Session 줄을 붙여요.
- 확인: `<script>`만 뽑아 `node --check`, `node --check server.js`. 화면은 `python3 -m http.server`로 열고 hostname을 `0.0.0.0`으로 접속하면 오프라인 모드(서버 없이)로 Playwright 스크린샷 가능 (localhost면 온라인 모드라 서버 필요).

## 꼭 지킬 약속 (사용자 규칙)
- 「텍스트로만」, 「기획만」, 「일단 보류」라고 하면 **구현하지 말고** 글(또는 이미지)로만 답해요.
- 저장소가 공개라서 **저작권 있는 그림 · 캐릭터 금지**, 직접 그린 픽셀 아트만.
- 운영자는 **조돌맹**만. 비밀 키(SUPABASE_SECRET_KEY · service_role)는 절대 묻거나 받지 않아요. 데이터 내보내기에 code_hash 빼기.
- 가짜 · 미끼 정보 금지. 아이템 압수 금지. 운영자 선물은 받는 사람에게 티 안 나게.
- **잠수함 패치**(사용자가 말하면): 업데이트 소식(UPD_LOG)에 안 쓰고, 커밋 메시지도 평범하게.
- 보이는 새 기능은 `UPD_LOG` 맨 위에 항목 추가하고 `UPD_VER` 올리기.
- **없앤 것 · 바뀐 것도 업데이트 소식에 꼭 알려요** (예: 「예전 ○○는 없어지고 △△가 됐어요」) · 유저가 헷갈리지 않게.
- 화면 글자는 `cx.fillText`로 그려도 또렷한 글자 층(tcv)에 다시 써져요. 문자열 안에 줄바꿈(\n)을 넣으면 스크립트 전체가 멈추니 수정마다 `node --check`.
- 노가다 · 귀찮은 일 만들지 않기. **손으로 낚는 게 자동 낚시보다 훨씬 유리**하게.
- **손맛 도감**(직접 낚은 종)이 핵심 콘텐츠. 손맛 1등 = 손맛 왕(마을 주인).
- 귀엽고 아기자기한 모바일 게임 퀄리티. UI는 화면을 가리지 않게.
- **📖 게임 안내서(gbHtml · 메뉴 → 추억 → 안내서)**: 보이는 기능을 새로 만들거나 바꾸면 안내서의 해당 탭도 같이 고쳐요 (이스터에그 · 잠수함 패치 · 유저가 직접 알아내야 하는 건 쓰지 않아요). 숫자 · 이름은 가능하면 게임 값(ENH · BAIT_SHOP · JOBS · CHAMP 등)을 그대로 써요.
- 사용자는 「알아서」 진행하는 걸 좋아해요. 끝나면 한국어로 무엇을 했고 무엇이 남았는지 짧게.

## 은근한 이야기 (기독교 우화, 나니아처럼 은근하게)
- 물결 정원(에덴): 매일 발밑에 열매(선악과)가 하나 굴러와요. 안 먹은 날만 정원 문이 열리고, 정원지기(하나님)가 함께 걸어요. 「하나님의 일기」 100일. 스토킹 느낌 절대 금지. 네 줄기 강은 낚시 금지.
- 직접적인 종교 단어는 쓰지 않아요.
- 🌳 정원 연못 (2026-11-17, 조돌맹 요청): 언덕 아래 길 옆 작은 연못(zone 22)만 낚시 돼요 · 네 줄기 강 · 샘은 그대로 금지. 물고기 20종 GDN (859~878 · client GDN_RAW · server GDN_R · FISH_MAX 879). 새 물고기 묶음은 항상 맨 끝(GDN 뒤)에 붙여요 (id가 밀리면 모두의 도감이 깨져요).

## 서버가 믿는 값
- 강화(enh) · 칩(eb) · 사냥(hunt) · 운세(fort) · 주간 기록(wh) 등은 서버 것만 믿어요. 새 서버 전용 필드를 만들면 `server.js`의 save 처리에서 **보존 목록(`for (const k of [...]) m.data[k] = me.save[k]`)에 꼭 추가**해요 (안 하면 화면 저장 때 지워져요).
- 새 아이템 id는 client `ITEMS` + server `ITEM_IDS`(+ITEM_NAME/MAKER) 둘 다. 새 치장은 server `LOOK_IDS`에도.
- 데이터 절약: 저장은 queueSave(45초 모아서), 같은 내용이면 안 써요.
- **Render 무료 · 한 달 5GB** (넘으면 멈추거나 초과 요금). 첫 화면은 br/gzip 압축 + ETag 304 (`pageBuf`), 웹소켓은 perMessageDeflate. 새 실시간 기능은 데이터 양을 먼저 계산하고 시간 제한 · 변화만 보내기.

## 지금까지 만든 큰 것들 (2026-11-16 기준)
- 실제 시간 하늘: 서울 해돋이 · 해넘이(sunCalc), 진짜 달 모양(moonAge), 맵 **북쪽 끝 = 지평선**(산 · 구름 · 별 · 은하수 · 보름달 토끼), 물에 비친 구름 · 달빛. 북쪽 끝에선 카메라가 올라가고 위쪽 알림 · 미니맵을 숨겨요(body.skyview).
- ☁️ **하늘낚시**: 북쪽 끝에서 하늘로 던지기 · 「별 잡기」 미니게임 · 하늘 도감 59종(물고기 42 · 계절 별자리 12 · 특별 5) · 별똥별 소원 · 전용 음악(skyn/skyd). 오래 즐기도록 전설 ~1/500, 신화 ~1/3000.
- 강화 +30까지, +20부터 💠 꿈의 정수 필요. 레이드 2.0(보스 5 · 공유 패턴 · 합동 공격 · 일으키기).
- 👑 손맛 왕의 마을: 가게 세금 0~5% · 공지 · 손맛 축제 · 벤치/벌집 배치 · 부탁 허락.
- 💍 반지 공방(공방 장인만) · 엔딩 「온 세상의 반지」 24조각 — 아직 없는 곳: 산 3조각(mt1~3), 깊은 바다(deep), 마지막 조각(last). 우주(별바다) 3조각은 하늘낚시로 열림.
- 직업 7개: 물결 낚시꾼 · 도감 박사 · 공방 장인 · 동물 친구(펫 성장 1.5배) · 떠돌이 상인 · 별빛 예언자(운세 대길~대흉) · 꿈 사냥꾼.
- 미끼: 장인 미끼는 덧미끼로 상점 미끼와 함께. 🧭 길잡이 미끼는 **운영자 전용**.
- 경제: 주간 경매(골드 소각) · 성실 보상(주간 손맛 마릿수) · 칩→꿈의 정수.

## 2026-11-17 추가된 것
- 🍃 손맛 모드(도감에 없는 물고기만 · 5분~2시간 · 서버 slow_cast/slow_got 보상) · 🕳️ 꿈의 심연 1~3(HFIELDS 11~13, 도감 없으면 100배) · 혼자 레이드(RAID_MIN 1) · 하루 사냥 보상(Lv40부터) · 용사 1위 통행세 3% · 은비 주간 숫자(ebn) · 은비땅 주인 몫 20%(EB_OWNER) · 반짝 축제(shf) · +25 꽃배 부르기 · 친구 낚시 단계(pos.f) · 새 낚싯대 7 · 찌 6

## 2026-11-17 ☁️ 구름 위 나라
- **구름 위 나라는 조돌맹과 Claude만 아는 비밀 작업**이에요 (아직 Lv99 유저가 없음 · 최고 84). 구름 위 바뀐 것은 UPD_LOG에 안 써요 (잠수함). 마을에 보이는 이야기(🌪️ 하늘이 갈라진 밤)만 써요.
- 🌪️ 하늘이 갈라진 밤: 내 정원 = 바닷가 **부서진 꽃배** (SHIP_N 1 · shipO [155,36] · 입구 위쪽 SHIP_EXIT [5,0] · wreckYard) · 생활 거리 가게 6곳 모두 무너짐 (RUINS · ruinsDraw · 바다에 떠다니는 조각 · ALOF 간판은 alofSignDraw로 앞바다를 둥둥). 구름과자 라운지만 그대로.
- 다음 계획 (조돌맹과 정함): ① 구름 위를 마을과 같은 타일 엔진으로 크게 다시 짓기 → 낚시는 원래 낚시 그대로 (전용 낚시 화면 없애기) · 물 위 걷기(+25)는 구름 위에선 안 됨 ② 구름 위는 빛/그림자 전용 장비 칸 · 드랍으로만 얻기 (상점 장비 판매는 없앰) ③ 나그네 이야기 장마다 새 땅: 💎 크리스탈 골짜기 → ❄️ 얼음 성 → 🌌 별바다 → 마지막 조각.
- 🌟 별빛 광장 (예전 정원 마당 · SHIP_N 0) · 🕯️ 나그네(NPCS 'nagne') 부탁 3장 → 빛/그림자 (server `al`, 7일에 한 번 바꾸기) · 조건: 용사 Lv70(AL_LV) + 심연 1 정화 (2026-11-17에 낮췄어요) · 운영자는 광장 구름 문으로 미리보기.
- 하늘낚시 20초 뒤 「틈」(riftBtn) → 처음 한 번 어둠의 길 → 구름 항구. 별도 장면 `CEL` (celUpdate/celRender, 1100×800, 섬 CISL · 다리 CBR · 구름 배 CFERRY).
- 하루 구름 숨결 90분 (server `cel`, cel_t 1분마다) · 구름 낚시 30종 (server `celd`, cel_fish 7초 제한) · 필드 2곳(새벽빛 들판 l · 그림자 숲 d): 몬스터 위치는 씨앗+시간으로 모든 화면이 같이 계산 (cfPos), 서버는 체력 · 쓰러뜨림 · 다시 나타남만 (cf_*). 데이터 아끼려고 위치는 안 보내요.
- 구름 위에 있는 사람은 pos.m에 +4 → 마을 화면에선 안 보이고, 구름 위에서만 보여요.
- ⛰️ 가장 높은 곳: 주간 저울(V.pk · 빛 l = 새벽빛 들판 처치, 그림자 d = 그림자 숲 처치, 각 150) 다 차면 열림 → 「새벽과 밤의 수호자」(PK_HP 250만 · 20초마다 모습 바뀜 · 반대 길 ×1.5 · 빛구슬 무늬는 시간 씨앗으로 화면마다 계산). server pkOf/pk_join/pk_hit · 운영자 pk_set(open/reset).
- 💧 구름 방울(server `celc`, 보존 목록에 있음) · ☁️ 구름 상점(cel_buy: gear 300 · breath 60 하루 1번 · es 40 · tk 25) · 구름 장비 it.cs='l'|'d' (낀 개수마다 구름 위 피해 +4%, 받는 피해 -4%, server csN).
- 운영자 도구: 🧪 시험 · 👥 유저 · 🎁 선물 · 📣 마을 탭. 시험 탭에서 어디든 순간 이동 · 구름 위 섬 · 사냥터 잠금 없이 · 나그네 단계 · 숨결 채우기 · 용사 레벨 · 나에게 골드/강화권/정수/칩/구름 방울 · 가장 높은 곳 문 열기/초기화.

## ☁️ 구름 위 나라 2.0 (짓는 중 · 운영자 미리보기만)
- 마을과 같은 타일 세상: MH 230 · 마을은 VMH 130줄 그대로 (genWorld 마을 반복문 · 나무 RNG는 VMH로 · 바꾸면 마을 나무 자리가 바뀌어요) · 130줄(RY0)부터 구름 위 (realmBuild: 섬 RISL · 다리 RBR · 호수 RLAKE zone 40~43 · 꾸밈 RDECO).
- 그리기: realmSky(하늘) · realmGround(512px 조각 캐시 RCH) · realmShore · realmDraws(RD 꾸밈) · 땅 타일 C(땅) Q(길) q(다리) v(빈 하늘, SOL).
- 낚시는 마을 낚시 그대로: zone 40~43이면 startNibble에서 celPick (구름 물고기 id 음수) → finishCatch 앞에서 celCatchDone → 서버 cel_fish. 자동 낚시 안 됨 · 꽃배(+25) 안 됨.
- 들어가기: 운영자 시험 탭 「새 구름 위 나라」 → realmGo (서버 cel_in · 숨결 cel_t) · 나가기 구름 나루 포털. 예전 CEL 장면(필드 · 수호자)은 아직 그대로 · 옮기는 중.
- 필드(새벽빛 들판 · 그림자 숲) · 수호자도 새 세상에서: realmFieldTick (CEL.x/y를 P에 맞춰 예전 celFieldUpdate · celAttack · pk* 그대로) · cfPos는 inRealm이면 RISL 좌표 · PKB는 새 정상. 하늘 틈 → (처음이면 어둠의 길) → celArrive → realmArrive. 예전 CEL 장면은 어둠의 길만 써요.

## 2026-11-17 ❄️ 머물던 자리
- 접속을 끊으면 그 자리에 얼음 동상 (server V.ice · iceSet/iceOff/icePub · 3일 ICE_MS) · client ICE · drawIce (녹는 단계) · 끄기 설정은 안 만들어요 (친한 친구들 게임).
- ⚠️ server pos 처리에서 `me.here = true; me.dirty = true;`가 주석 뒤에 붙어 11-16부터 친구 위치가 안 갔어요 → 고침. 한 줄 끝에 주석을 붙일 때 뒤에 코드가 있는지 꼭 확인.

- 🎣 낚시 자리의 흔적: 같은 자리 5마리부터 의자 · 미끼통 (k 's'), 전설 이상 · giant · 반짝은 물고기 팻말 (k 'b') · 하루 (server V.trc · trcCatch는 'hold'에서) · client TRC · drawTrc.
- ⚠️ 반짝 물고기 팔기(sh_sell)도 주석에 묻혀 11/16 밤부터 골드 없이 물고기만 빠졌어요 → 고침.

## 앞으로 하고 싶다고 한 것
- 산 맵 · 우주(별바다) 맵 → 반지 남은 조각 채우기. 눈 오는 겨울. 비눗방울 잠자리채가 앞모습에서 잘 안 보이는 것 손보기.

## ☁️ 구름 위 나라 2.0 (이어서 · 2026-11-17)
- MH 330 · 하늘 틈 → (처음이면 어둠의 길) → 새 세상(realmArrive). 예전 CEL 장면은 어둠의 길만 써요.
- 구름 위 장비: 구름 위에선 `ceq`+칸(구름 위 전용 칸)만 힘을 내요 (client EQK · server rpgSum(h,lv,true) · hunt_eq c:1 · 구름 장비 it.cs만). 처음 들어가면 나그네가 무기 · 갑옷 · 모자 (h.cst) · 필드 드랍은 모두 구름 장비 (celGear). 구름 상점은 장비를 안 팔아요.
- 📖 나그네 4~7장 (server al.sg · al.gd=수호자 보상 받은 사람): sg1 💎 크리스탈 골짜기(zone44 'x') → 3종 → sg2 ❄️ 얼음 성(zone45 'i') → 3종 → sg3 🌌 별바다(zone46 's') → 「별바다의 마지막 조각」(celd 47) → sg4 🕊️ 끝. 땅 RLAND · lgate 잠금(realmLandOpen). 구름 물고기 48종 (30~47 이야기 땅 · client · server CEL_FISH 같은 순서). 반지 조각 mt1(sg2) · mt2(sg3) · mt3(수호자) · last(sg4).
- 이야기 땅 몬스터: 필드 x · i · s (server CF_KINDS · cf_join은 sg 확인) · client rMonDraw (땅마다 5종 그림).
- 🏰 얼음 성 안: 섬 icein (다리 없음 · 성 문 icast ↔ idoor) · 잠든 얼음 왕(ithr · sg3부터 깨어나요).
- 운영자 시험 탭: 섬마다 바로 가기(rSafe로 빈자리) · 이야기 단계 버튼(al_set g0~g4).

## 2026-11-17 마을
- 🤢 잊힌 통발: trapRot/trapRotDraw (t0부터 2~15일 천천히) · **글 설명은 통발을 열었을 때만** (이름표엔 안 써요). ALOF 간판도 글자 이름표 없이 그림만.
- ⚠️ 주석 사고 3번째: 사냥 처치 보상 `const got = []`가 주석에 묻혀 11/16 밤부터 사냥 보상이 안 들어갔어요 → 고침. **줄 중간 주석은 /* */로.**
- 🚩 낚시터 깃발 (2026-11-17): server V.flag {w, z:{zone:{key:{n,c}}}, o:{zone:{k,n}}} · 'hold'에 fc:1(손으로 낚은 것만) → flagCatch(placeOf 낚시터) · 주인 바뀔 때만 'flag' · 월요일 새로 · 지난주 깃발마다 강화권 3 · 500만 (V.fpend → flagPay) · 'flag_get' → 'flagc' 1~3등. client FLAGS · flagPos(낚시터 물가 자동) · drawFlags · flagNear · flagSheet.
- 🎨 깃발 치장 (2026-11-17): COS k 'sflag' 24종 (sf_* · client SFLAG [모양 pen/swal/ban/sock, 색, 무늬] · drawSFlag) · 끼면 S.sflag + 'sflag' 메시지 → server SFLAGS · ownsCos 확인 · s.sflag · 내 깃발 F.o[z].sf 바꾸고 'flags'(o, f) 다시 보냄.
- ⚔️ 구름 위 사냥 손맛 (2026-11-17 · 잠수함): RC 모듈 (rcTick · rcScreen · rcHitFx · rcKill · rcDash) · 3단 베기(3번째 ×1.4, 넉백 · 돌진) · 히트스톱 RC.stop · 하얀 번쩍(lighter로 한 번 더 그리기) · 몬스터 공격 예고 mo.wind(빨간 원 + !) → 💨 구르기(#rDash, Shift/C) 무적 RC.iv · 수호자 빛구슬도 구르기로 피함 · 서버 cf_hit/pk_hit 240ms · cap ×1.45.
- 구름 위 선명하게: RPAL 진하게 · 섬 가장자리 테두리 · 구름 위에선 마을 날씨 안 그림 · 하루 색조 65% 약하게.
- 치장 상점: 카드 눌러 입어 볼 땐 renderBoutique.po=1 → 미리보기만 바꿔요. 🚩 깃발 미리보기 sfPrevStart (#sfprev).
- ❄️ 음비의 겨울옷 o_umbi (drawOutfit · server LOOK_IDS.o).
- ⚠️ 하늘낚시 골드를 화면이 더해서 저장 거절('판 것보다 골드가 많이 늘었어요') → sync로 하늘 도감까지 되돌아갔어요 (11-16~17) → 고침: server 'sky_got' (SKY_GOLD · s.skyd/skyn · rev+1 · dgold). skyd/skyn은 서버에 있으면 서버 것 유지. **화면에서 골드를 직접 더하는 새 기능은 만들지 말기 (서버가 주기).**
- 🎲 은비칩: 원하는 수 입력 · eb_buy all:1 (가진 골드 모두).
- 💠 꿈의 정수: 가질 수 있는 수 ES_MAX 1e9 · 칩→정수 한 주 10개 제한 없앰 (ess_chip n · all).
- 🐾 반려동물 기분 (2026-11-18 · 업데이트 소식에 안 씀): S.cp.md 0~100 · 켜 둔 4분마다 -1 · 0이면 경험치 없음 · 80 이상 1.5배 · 쓰다듬기 +25 (20분) · 간식 하루 2번 가득 (cpPlay). 레벨 선물 CP_RW(10~99) = server cp_rw (cpLvS · CP_RWS · s.cprw 보존 목록) · 강화 상자 + 골드.
- 로컬 서버 시험: scratchpad/stub/node_modules(express · supabase 가짜) + /opt/npm-tools/node_modules(ws)로 NODE_PATH 잡고 `PORT=8790 node server.js` → 메모리 저장 · localhost:8790 온라인 모드로 Playwright 가능.

## 🎉 2026-11-18 구름 위 나라 그랜드 오픈 (조돌맹과 정함 · 이제 비밀 아님)
- server GO_AT0 2026-11-21 21:00 KST (운영자 시험 탭에서 바꾸기 · V.go.at) · goOpen/goLand(x 3 · i 7 · p 14 · s 21일) · goWeek1(드랍 · 숨결 2배) · 늦은 개척자(14일 뒤 첫 입장 s.gin) 구름 경험치 2배.
- 조건: 용사 Lv30 (alReady) · 나그네 1~4장은 미리 · cel_in은 오픈 뒤 · 오픈 전 길 고름 = s.gpre → 칭호 t_glamp · 1시간 안 t_gday · 첫 3명 t_gfoot (V.gf.foot).
- ☁️ 구름 Lv: s.clv(경험치) · CLV_NEED 30+8L^1.6 · client cLv/hLv/hRealm · 구름 위 힘: 공격 8+Lv×3+장비 · 방어 · 체력은 용사 공식에 구름 Lv · 구름 장비 rq = CEL_RQ[g] · 첫 장비 1등급 rq1.
- 몬스터 CF_SC로 줄였어요 (서버 CF_KINDS · client CF_K 같이) · 수호자 40만 · 빛구슬 120.
- 최초 기록 V.gf (foot · lv30 · x · i · pk · s) · 시즌 4주 V.gr 순위 → V.gse 1~3등 강화 상자(특) + t_gking1~3. 'go' 메시지 · 'go_get'(순위) · 팻말 goSigns(마을 광장 · 별빛 광장) · goSheet.
- 🪑 하늘 보는 흔들의자 (2026-11-18): SWG [[70,2],[84,2]] 마을 북쪽 끝 · 둘이 앉기 · server SW (메모리 · sw_sit/sw_up/sw_push · 끝 박자 |cos|<.4면 +.16) · 흔들림 A·sin(ω(t−t0)) 화면마다 계산 · 앉으면 P.swing (내 그림은 의자가 그려요) · 둘이면 하트.
- ⛵ 꽃배 물 위 속도 절반 (P.boatK).
- 🕳️ 심연 다시 맞춤 (2026-11-18 · 업데이트 소식 안 씀): 예전 100배 벽 → abyssMul (기본 심연1 ×.5 · 2 ×.75 · 3 ×1 · 도감 없는 물고기 ×4 · 우두머리 빈 종마다 +40% 최대 ×6).
- ☁️ 구름의 축복 (2026-11-18 · 업데이트 소식 안 씀): 구름 Lv마다 마을 사냥 공격 · 체력 +1.5% (client cBless · huCP · server cBlessS · cpOf · raidAtk). 구름 위 안에선 안 붙어요.
- 🕳️ 심연 = 천상계를 다녀와야 세지는 구조 (2026-11-18 · 조돌맹 · 업데이트 소식 안 씀): ABY_HP {11:3.3, 12:10, 13:30} · ABY_AT · 심연에서만 ☁️ 하늘빛 abyssSky() = 1 + (구름 Lv-1)×10% 피해 (huHitMon) · 구름 Lv10 아래로 심연 들어가면 안내 배너.
- ☁️ 구름 문 (2026-11-18): 마을 광장 (goSigns()[0] · 시작점 왼쪽 아래) · skyGateDraw · skyGateSheet 「천상계 가는 길」 4단계(Lv30 · 나그네 3부탁 · 빛/그림자 · 오픈) · 📍 나그네 길 안내(GUIDE) · 다 되면 바로 celAsk. 접속 때 skyHint(내 말풍선 · 단계별 한 줄 · S.gin 있으면 안 나와요). 예전 꿈의 문 「포탈이 생겼어!」 말풍선(DISC portal)은 없앴어요.
- 🌟 황금 깃발 (2026-11-18): V.flag.gz (월요일마다 지난주 낚은 곳 중 한 곳 · flagGzPick) · 주인은 다음 주 강화 상자(특) + 2억 (V.fgpend → flagPay) · 'flags'/'flagc'에 gz · client FLAG_GZ · 금빛 깃대 · 별 · 이름표 늘 보임 · 깃발 창 맨 위.
- 잠수함 (말 안 해요): 깃발 점수 반짝 = 3마리 (flagCatch sh · 안내 글에 안 써요) · 반짝 1위(shinyTop · shKingKey 1분 캐시) 반짝 확률 ×1.15.
- 🌊 1위의 응원 (2026-11-18 · 조돌맹 · 1등 이름으로 보여요): 🎣 낚시 강화 1위의 지원 enhCU (server enhRoll · client 강화소 줄) 1단계마다 성공 +5%p(최대 25) · 별 ×(1+0.6g, 최대 4) · g≥2 실패해도 별 · 정수 안 잃음 / ⚔️ 용사 1위의 격려 huCatch (5레벨부터 1레벨마다 +5%, 최대 ×4 · HUTOPN) / ⚔️ 이번 주 응원 상자 supBox (전투력 1위 xKing.hl 대비 <50% A · <75% B · s.wsp 보존 목록).

## ✨ 반짝 챕터 (2026-11-18 · 숨김 · 잠수함: 업데이트 소식 · 안내서 · 진행도 표시 없음, 완성한 쪽만 도감에 표시 · 마을 알림은 이름 없이 「새 별자리」)
- 도감 한 쪽(PAGE_IDS[p]) 반짝을 다 모으면 client shchScan → 'shch' → server shchMsg (모두 반짝인지 확인) · s.shc[p] · s.shcx(그 물고기 반짝 ×2, shinyP) · 보존 목록 shc/shcx · 강화 상자(특) ×3 · 칭호 SHCH_TI (t_shch1/3/5) · V.shcf(챕터 최초 완성) · V.shcl · 마을 30분 반짝 축제(V.shf) · 'big'/'shch' 알림 · 'shch_ok' 축하 창.
- 밤하늘에 「이름자리」 별자리 (skyDraw · 이름 씨앗) · 도감 쪽마다 .shch 줄 (최초 완성 이름).

## 🎁 숨은 기쁨들 (2026-11-18 · 조돌맹 · 전부 잠수함: 업데이트 소식 · 안내서에 안 써요)
- 🏰 깃발이 자라요: server F.o[z].t (꽂은 때) · 주가 바뀌어도 같은 사람이 다시 꽂으면 F.pv로 이어져요 · 'flags'/'flagc'에 ft · client FLAGT · flagStage(1일 풀 · 3일 꽃 · 5일 돌담 · 7일 작은 성 · 14일 빛나는 성) · drawFlagGrow · 이름표 「n일째」 · 3일 넘은 깃발을 뺏으면 'flag' wd → 무너짐 배너.
- ⚡ 깃발 라이벌(F.sw 한 주 5번 주고받기 → rv · 이름표 ⚡) · 🚩 모든 물가의 주인(s.fall · FLAG_ZN 19곳 · t_fall) · 🪨 물결마을의 기억 비석(동상 옆 MM_P [13,21] · V.hof 주간 깃발 왕 + wfHist · 3주 연속 금빛 · 'hof_get'). ⚠️ hofDraw는 예전 명예의 전당(트로피) 이름이라 비석은 mm*.
- 👑 1위 바뀌는 순간 폭죽 kingTake/skyFw · 1위 발자취 kingFoot(월척 물방울 · 용사 불꽃 · 강화 불티 · 기부 분홍 · 처치 수 상위 3명 KINGS.hk 그림자) · 두 왕관/물결의 군주(crownCheck · t_crown2/3).
- ⚔️ 사냥: S.hu.kf/kb(사냥터별 처치 · 우두머리) · huFame(한 곳 5천 또는 모두 5만) → 약한 몬스터 도망 · 발자국 HUNT.fp · huBossMem(30 · 100번 · 용사 1위에겐 절) · 무기 it.kc(server) → rpName 앞말(손에 익은 · 천 번 벤 · 백전의 · 전설이 된).
- 🔨 대장장이 위로: server e.cf 연속 실패 10번부터 50%로 +35%p (rolls sm).
- 🐟 꽃배 +28 물고기 떼 · +30 별빛 발자국 (boatFx) · ✨ 도감 다 채운 낚시터 물 반짝(zoneDoneSet) · 🌼 켜 둔 시간 S.stats.pm 20시간마다 발밑 꽃(가만히 3초) · 🐾 펫 Lv50 물고기 물어 오기(CPFE · PFISH) · Lv99는 얼음 동상 곁 · 🌿 정원 일기 100일 빛 · 🪧 같은 자리 손맛 1,000마리 팻말(server spotCatch · s.spc · V.plq) · ⭐ 하늘 도감 59종 별(V.skyc · SKYD9) · 🌠 흔들의자 둘이 30분 → sw_wish · 🛍️ 경매 단골(KINGS.auc) · 🌸 7일 넘게 떠났다 오면 꽃(s.lo · 'wb').
- 보존 목록에 fall · spc · lo 추가했어요.

## 🐾 반려동물 2.0 (2026-11-18 · 조돌맹 · 업데이트 소식 · 안내서 안 씀)
- 경험치는 늘 같아요 (1분 1 · 기분만) · 배율 · 새벽 보너스 · 놀이터 · 각성 · 사냥 동행 없음 (조돌맹이 뺐어요).
- 단계 CP_STG (아기 1 · 꼬마 10 · 단짝 20 · 듬직이 35 · 수호 50 · 전설 70 · 별빛 90) · cpStageFx/cpWings (반짝 · 하트 · 목도리 · 발자국 · 날개 · 별가루) · 단계 오르면 'cp_stg' → server s.cpst 한 번만 마을 소식.
- 재능 CP_TAL: 레벨 되면 저절로 (누를 것 없음) · 15 입질 「!」 · 25/55 조절 바 · 30/60 통발 · 35/70 탐험 코스 · 40 판매 · 45/80 행운 · 90 탐험 골드 ×1.5 · jobMods/trapMax는 cpLvQ (TDZ 안전).
- 🎒 탐험 CPX a 30분 · b 1시간(Lv10) · c 3시간(Lv35) · d 6시간(Lv70): server s.cpx {c,need,got,on} · 접속할 때 on · 끊을 때 got에 더해요 (켜 둔 동안만) · cpx_go/get/stop · 강화권 하루 CPX_TK_DAY 8 (s.cpxd) · 보존 목록 cpx · cpxd · cpst.
- 🐾 반려 1위: roster cpl → KINGS.cpk · 펫 머리 왕관 · 이름표 🐾.

## 🛠️ 2026-11-18 저녁 고침
- 📜 의뢰 납품 · 해결하기 안 눌림: raidClick도 data-rq를 써서 의뢰 버튼을 먹었어요 → raidClick은 in/out/enter/board만. **data-* 이름 겹치지 않게 조심.**
- 🪤 통발: 칸 큰 통발(+27 · 펫 재능)을 걷으면 checkSave '너무 빨리 많이 잡혔어요' → sync로 물고기 사라짐 → trap_claim 때 me.trapCred(걷은 수+4, 2분)만큼 봐줘요.
- 고장 보상은 server COMP (이름 → [id, 상자, 골드, 글]) · 접속 때 한 번 (s.cmp 보존 목록). 치킨 · 꼬북린 지급.
- 💰 직업 기술 버튼(#skb) 위치: 실수로 길게 눌려 가운데로 옮겨진 사람 → 저장 키 skbpos2로 바꿔 모두 제자리 · 0.9초 꾹 + 움직이면 취소 · 화면 가운데(30~70%)면 무시.
- ⛵ 꽃배 물 위 P.boatK .5 → .85.
- 🪑 흔들의자 하늘 보기: P.swing이면 body.swingview (UI · #tags 이름표 숨김, 말풍선 .bub만) · SWV면 worldTag 안 그림 · 카메라 render.swk로 VH×.2 더 올림 · 음악 tracks.swing 「하늘 그네」 · 앉아 있을 땐 업데이트 소식 자동 열기 안 해요.
- ❎ 확인 창(askConfirm) 취소: 거래 요청 #ask의 askNo와 id가 겹쳐 32곳 모두 취소가 안 됐어요 → cfNo. **id 겹치지 않게.**

## ✨ 명품관 · 테마 치장 2.0 (2026-11-18 밤)
- TH 7 테마(dr 용 · pi 해적 · kn 기사 · st 폭풍 · sa 벚꽃 · cr 크리스탈 · ga 은하수) × TH_SLOT 7칸: thr_ 낚싯대(3억 · ROD3 · ROD_PERK + 큰 효과 rs) · thb_ 찌(5천만 · BOB3) · tpt_ 통발(1억 · thTrap · 3배 가격 안 붙게 !c.lux) · cpt_ 펫(1천만 · thPetAcc · CP_ACC) · trs_ 낚시 자리(1억 · thTrcSeat/thTrcSign · server s.trs · trc 항목 sk) · sft_ 깃발(10억 · SFLAG em 'th_' · thFlagEm/thFlagFx) · cst_ 성 양식(50억 · thCastle · server s.cst · F.o[z].cs · flagsMsg cs).
- 성 단계 flagStage: 21일 6(해자 castleMoat) · 28일 7(전설 · 👑 이름표) · 7일 넘은 성 뺏기면 thCollapse(테마 연출, 'flag' wcs).
- 세트: thMine() · server thCountS → look.th 'dr5'(3칸부터) → thAura 오라 · 7칸이면 client 'thset' → server 확인 후 t_th_* 칭호 + big 소식.
- 명품관 openLux/renderLux (테마 카드 → 7칸만 그림 · luxIcon 캐시) · 메뉴 성장 「명품관」 · 치장 상점 맨 위 버튼 · 일반 치장 상점에선 c.lux 숨김. tidySheet가 .muted 긴 글을 지워서 TIDY_SKIP에 .luxi/.luxh/.luxc.
- server 'flags'는 이제 flagsMsg() 하나로 (ft · rv · cs 빠지지 않게). client는 ft/cs가 있을 때만 갈아끼워요.
- ✨ 명품관 2.0 (같은 밤): 테마 효과는 모두 새로 — rodSig k 'T_<t>'(테마 낚싯대) · 'T_<t>2'(각성 낚싯대 thr2_ 15억) → RFX → rfxDraw default thRfx · 찌 'Tb_<t>' → thBobSig · 낚싯대 끝 tip 'th:<t>' → thTip(TH_TIP). 발자국 ftt_(FOOT_FX/FX_COL th<t>) · 이름표 tft_(FRAME_COL + 주입 CSS .ntag.tft_). lux2 블록은 FX_COL 정의 바로 뒤 (TDZ). TH_SLOT 10칸 · 칭호는 7칸 이상.
- 🏰 성 전시장: CSTX 6 (pg 누각 · cd 사탕 · ic 얼음 · mu 버섯 · co 산호 · tr 나무 위) · xCastle · server cstOf 정규식에 같이.

## 🌊 따라잡기 (2026-11-18 밤 · 조돌맹 · 잠수함: 업데이트 소식 · 안내서 · 화면 표시 없음)
- 그 분야 1~3등이 아니면: server cuTop(key, f) (rosterCache 30초 캐시 · sd 손맛 · sh 반짝 · gt 월척 · hl 전투력) → 반짝 shinyP ×3 (sh) · giveTk 강화권 ×2 (sd) · clvAdd 구름 경험치 ×2 (hl) · checkSave 골드 검사 ×2 (sd).
- client CU3 (roster list로 같은 기준 · list에 hl 추가) · cuX(f,m) → 행운 · 판매가 ×2 (sd) · 월척 확률 ×2 (gt) · 사냥 경험치 ×2 (hl). 오프라인은 ×1.
- 반려동물 경험치는 조돌맹이 「늘 같게」라고 해서 안 넣었어요.

## 🚪 봉인된 문 · +31~+40 (2026-11-18 밤 · 조돌맹)
- ENH.MAX는 getter: V.e30(처음 +30 닿은 사람) 있으면 40, 없으면 30 (server · client E30). 이미 +30인 사람이 접속하면 문이 저절로 열려요. 운영자 시험 탭 「🚪 봉인된 문」 열기/닫기 (op 'e30').
- 비용: ENH_ES(+20~29 1개 · +30~39 2~5개) · ENH_SF(+34부터 🌠 별의 조각 e.sf 1~3). 🌠 얻는 곳(sfAdd): 손으로 낚은 반짝 1 · 신화 2 · 전설 25% · 하늘낚시 전설 이상(하루 6 · s.sfsk) · 구름 물고기 첫 종 100%/그 외 8%.
- 단계 효과 ENH_MILE2: 31 낚싯대 끝 별 · 32 별똥별 꼬리 · 33 통발 +5칸 · 34 물 위 별자리 발자국 · 35 🌀 별빛 순간이동(길 안내 · 하루 3번 S.tpd) · 36 반짝 ×1.2 + 물고기 뛰어오름 · 37 하늘 전설/신화 ×1.5 + 밤 머리 위 별 · 38 사냥/레이드 공격 +10% + 오로라 · 39 깃발 점수 ×1.5 · 40 발밑 구름 + 칭호. 효과 그림은 enhStarFx (친구도 look.e로 보여요).
- 문: DOOR_P [28,27] 강화소 오른쪽 · doorDraw(+25부터 빛 새요) · doorSheet (닫힘 · 열림 표 + 최초 기록 V.e40f). 서버 최초 +31~40 'big' 알림. 칭호 t_enh35 · t_enh40.
- 🎁 날마다 선물 (잠수함 · 업데이트 소식 · 안내서에 안 씀 · 순위 얘기 안 함): 전체 4등(top4: sd · sh · gt · hl 순위 합) 아래 + 7일 안에 접속한 사람 → 접속 때 하루 한 번 MVP_DAY(3억 · 강화권 150 · 정수 50 · 🌠 3 · 강화 상자 A, s.dg) · 켜 둔 1시간마다 MVP_HOUR(5천만 · 강화권 10 · 정수 5). 보존 목록 dg · sfsk.
- 🪑 흔들의자 고요 모드 (2026-11-18 · 잠수함): swingview면 body의 cv · tcv 말고 모두 숨김(조이스틱 · 앉기/밀기 버튼 · 알림 · 말풍선 · #tags) · 효과음(Snd.sfx) 꺼짐 · 음악만 · 일어나기는 화면 두 번 톡톡(swTap · 키보드 이동도 그대로).
- 🌌 천상계 하늘 (2026-11-19 · 깜짝이라 업데이트 소식 안 씀): realmSky = 깊은 남색 바탕 + skyGalaxy() 캐시(2048×1000 · 은하수 띠 · 먼지 11만 점 · 성운 · 어두운 먼지 줄기 · 푸른 큰 별 빛살)를 'lighter'로 · 반짝이 70개 · 별똥별 · 구름 띠는 아주 옅게. 하루 첫 입장(S.rwd)은 realmWow: 온 화면 은하수 + 「천 상 계」 글자 + 별똥별 소나기 → 5초에 걸쳐 드러남 (body.rwow로 UI 숨김).
