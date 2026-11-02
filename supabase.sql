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
