-- Captured by Andy online: the app's memory in Supabase, so the web app
-- (studio.andyssarchives.com) and the Mac share it. Pictures themselves stay
-- on Google Drive: a photo row only carries its Drive file id.
--
-- Paste this whole file once into Supabase › SQL editor › Run. It can be run
-- again safely. Only Andy's Google account can read or write (row security);
-- the Mac's sync uses the service key, which bypasses that on purpose.

create table if not exists owners (email text primary key);
insert into owners (email) values ('owner@example.com') on conflict do nothing;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from owners where email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;

-- ------------------------------------------------------------------ library

create table if not exists photos (
  id            text primary key,
  captured_at   text not null,
  filename      text not null default '',
  -- The trip folder, relative to its source ("CAMERA/SRI LANKA/BEACH"), and the source's label.
  folder        text not null default '',
  source        text not null default '',
  media_kind    text not null default 'image',
  is_video      boolean not null default false,
  duration_s    real,
  width         integer,
  height        integer,
  camera_model  text,
  -- Shot on the iPhone (or exported from Photos), its burst, and whether it came out soft.
  iphone        boolean not null default false,
  burst         integer not null default 1,
  burst_best    boolean not null default true,
  soft          boolean not null default false,
  -- The file is gone from the Mac's sources.
  gone          boolean not null default false,
  review        text not null default 'unreviewed' check (review in ('unreviewed', 'selected', 'maybe', 'rejected')),
  reviewed_ms   bigint,
  thumbhash     text,
  -- Google Drive's file id (from Google Drive for desktop), null when it isn't on Drive.
  drive_id      text,
  -- Changed on the Mac / on the web: the newer one wins when they meet.
  updated_ms    bigint not null default 0,
  web_ms        bigint
);
-- Columns added after the first run.
alter table photos add column if not exists iphone boolean not null default false;
alter table photos add column if not exists burst integer not null default 1;
alter table photos add column if not exists burst_best boolean not null default true;
alter table photos add column if not exists soft boolean not null default false;
alter table photos add column if not exists gone boolean not null default false;
-- A video's web copy on Drive (1080p H.264, tools/web-video/make.py): what browsers play instead of the camera file.
alter table photos add column if not exists web_video_id text;
create index if not exists photos_by_date on photos (captured_at desc);
create index if not exists photos_web on photos (web_ms) where web_ms is not null;

create table if not exists albums (
  id             text primary key,
  name           text not null,
  description    text not null default '',
  cover_photo_id text,
  updated_ms     bigint not null default 0,
  web_ms         bigint,
  deleted        boolean not null default false
);

create table if not exists album_photos (
  album_id text not null,
  photo_id text not null,
  position integer not null default 0,
  web_ms   bigint,
  deleted  boolean not null default false,
  primary key (album_id, photo_id)
);
alter table album_photos add column if not exists web_ms bigint;
alter table album_photos add column if not exists deleted boolean not null default false;

create table if not exists tags (id text primary key, name text not null, slug text not null default '');
create table if not exists photo_tags (tag_id text not null, photo_id text not null, primary key (tag_id, photo_id));

-- ------------------------------------------------------------------ Studio

-- Every Studio list (pillars, families, ideas, pieces, saves, boards, shootDays,
-- brandJobs, reviews, watch) as the app's own camelCase rows.
create table if not exists studio_rows (
  list       text not null,
  id         text not null,
  data       jsonb not null,
  updated_ms bigint not null default 0,
  web_ms     bigint,
  deleted    boolean not null default false,
  primary key (list, id)
);
create index if not exists studio_rows_web on studio_rows (web_ms) where web_ms is not null;

-- saveIdea (save → idea) and pieceMedia (piece → photo) links.
create table if not exists studio_links (
  kind    text not null,
  a       text not null,
  b       text not null,
  web_ms  bigint,
  deleted boolean not null default false,
  primary key (kind, a, b)
);

-- ------------------------------------------------------------------ Google Drive

-- The web app's Google login (read-only Drive), kept so the drive-token edge
-- function can hand the phone a fresh access token every hour without a new sign-in.
create table if not exists google_tokens (
  email         text primary key,
  refresh_token text not null,
  updated_ms    bigint not null default 0
);

-- ------------------------------------------------------------------ who may read and write

do $$
declare t text;
begin
  foreach t in array array['owners', 'photos', 'albums', 'album_photos', 'tags', 'photo_tags', 'studio_rows', 'studio_links', 'google_tokens'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format('create policy owner_all on %I for all to authenticated using (is_owner()) with check (is_owner())', t);
  end loop;
end $$;
