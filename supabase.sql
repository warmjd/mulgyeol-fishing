-- 물결마을 낚시터: Supabase SQL Editor에 통째로 붙여 넣고 Run 하세요.
create table if not exists public.players (
  key        text primary key,          -- 소문자 닉네임 (중복 확인용)
  name       text not null,             -- 화면에 보이는 닉네임
  code_hash  text not null,             -- 로그인 코드 (암호화되어 저장)
  save       jsonb,                     -- 가방 · 도감 · 골드 · 장비 등 게임 저장
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 브라우저에서 직접 읽고 쓰지 못하게 잠금 (서버의 secret 키만 접근 가능)
alter table public.players enable row level security;

-- ===== 4단계: 교환소 (이미 위를 Run 했다면 아래 부분만 붙여 넣고 Run 해도 돼요) =====
create table if not exists public.trade_posts (
  id         text primary key,
  by_key     text not null,             -- 글쓴이 (소문자 닉네임)
  by_name    text not null,
  kind       text not null,             -- give 드려요 / want 구해요
  give       jsonb,                     -- [물고기 번호, 마릿수] — 교환소가 맡아 둔 물고기
  want       jsonb,                     -- [물고기 번호, 마릿수]
  note       text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.trade_mail (
  id         bigint generated always as identity primary key,
  to_key     text not null,             -- 받는 사람
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists trade_mail_to on public.trade_mail (to_key, created_at desc);
alter table public.trade_posts enable row level security;
alter table public.trade_mail enable row level security;
