-- immutable per package@version: registry facts
create table if not exists package_version (
  pv text primary key,
  name text not null,
  version text not null,
  facts jsonb,
  fetched_at timestamptz not null default now()
);

-- immutable per lockfile hash: the encoded graph (docs/CONTRACT.md §1) and node order
create table if not exists graph (
  lockfile_sha text primary key,
  bin bytea not null,
  pvs text[] not null,
  lockfile text not null,
  created_at timestamptz not null default now()
);

-- one row per scan; colours and dynamic flags are frozen per snapshot, aligned with graph.pvs
create table if not exists snapshot (
  id serial primary key,
  repo text not null,
  ref text,
  commit_sha text,
  kind text not null default 'push',
  mr_iid int,
  base_snapshot_id int references snapshot(id),
  lockfile_sha text not null references graph(lockfile_sha),
  as_of timestamptz not null,
  color bytea not null,
  flags bytea not null,
  counts jsonb not null,
  gate jsonb,
  delta jsonb,
  metrics jsonb,
  created_at timestamptz not null default now()
);
create index if not exists snapshot_repo on snapshot(repo, id);

-- details only for non-green nodes
create table if not exists snapshot_pv (
  snapshot_id int not null references snapshot(id) on delete cascade,
  pv text not null,
  color smallint not null,
  reasons jsonb not null,
  fingerprint jsonb,
  advisories jsonb not null default '[]',
  primary key (snapshot_id, pv)
);

create table if not exists advice (
  snapshot_id int not null references snapshot(id) on delete cascade,
  package text not null,
  data jsonb not null,
  primary key (snapshot_id, package)
);

-- version knowledge for the upgrade advisor: module format, exported API, changelog
create table if not exists pv_api (
  pv text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists decision (
  id serial primary key,
  repo text not null,
  pv text not null,
  action text not null check (action in ('accept', 'pin')),
  reason text not null,
  by_user text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists decision_repo on decision(repo, pv);

create table if not exists event (
  id serial primary key,
  at timestamptz not null default now(),
  kind text not null,
  repo text,
  pv text,
  snapshot_id int,
  payload jsonb not null default '{}'
);

create table if not exists connection (
  id uuid primary key,
  gitlab_url text not null,
  username text not null,
  profile jsonb not null,
  token_enc text not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_state (
  state text primary key,
  verifier text not null,
  gitlab_url text not null,
  created_at timestamptz not null default now()
);

-- security watchers: posts and advisories from the places incidents get reported first
create table if not exists watch_item (
  id text primary key,
  source text not null,
  title text not null,
  url text not null,
  published timestamptz not null,
  summary text not null default '',
  packages jsonb not null default '[]'
);
create index if not exists watch_item_published on watch_item(published);

-- columns added after the first release
alter table snapshot add column if not exists delta jsonb;
alter table snapshot add column if not exists metrics jsonb;
