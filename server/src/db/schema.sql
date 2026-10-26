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

-- every resolved package@version edge from every lockfile ever scanned: the world graph
create table if not exists pv_edge (
  parent text not null,
  child text not null,
  primary key (parent, child)
);
create index if not exists graph_pvs on graph using gin (pvs);

-- how a package@version is used anywhere we have scanned it; flags only ever widen
create table if not exists pv_use (
  pv text primary key,
  runtime boolean not null,
  direct boolean not null,
  install boolean not null
);

-- repos the crawler feeds into the world map; found from seeds and from packages' repository fields
create table if not exists crawl_queue (
  repo text primary key,
  source text not null,
  status text not null default 'pending',
  lockfile_sha text,
  packages int,
  hits int not null default 1,
  error text,
  tried_at timestamptz,
  added_at timestamptz not null default now()
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
-- where our code imports each direct dependency, kept from the scan's sources (advisor/remedy.ts)
alter table snapshot add column if not exists usage jsonb;
-- the GitLab project page, so code locations can link to the file at the scanned commit
alter table snapshot add column if not exists web_url text;

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
-- 'fix' records a merge request opened to fix the package; it does not pass the gate, merging the fix does
alter table decision add column if not exists mr_url text;
alter table decision drop constraint if exists decision_action_check;
alter table decision add constraint decision_action_check check (action in ('accept', 'pin', 'fix'));

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

-- whose connection it is: "gitlab:<url>:<username>" or "local:<username>" (see sessionUser)
alter table connection add column if not exists owner text;
-- OAuth tokens last 2 hours; the refresh token renews them (connector/gitlab.ts)
alter table connection add column if not exists scope text;
alter table connection add column if not exists refresh_enc text;
alter table connection add column if not exists expires_at timestamptz;

-- depmap's own accounts, next to Sign in with GitLab
-- source files that import a direct dependency, kept per snapshot so a background AI fix can read them
create table if not exists snapshot_file (
  snapshot_id int not null references snapshot(id) on delete cascade,
  path text not null,
  content text not null,
  primary key (snapshot_id, path)
);

-- one AI-written code change per risky package and snapshot (advisor/aifix.ts); key reuses a finished fix for the same code
create table if not exists ai_fix (
  snapshot_id int not null references snapshot(id) on delete cascade,
  pv text not null,
  key text not null,
  remedy jsonb not null,
  status text not null default 'queued',
  result jsonb,
  usage jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (snapshot_id, pv)
);
create index if not exists ai_fix_key on ai_fix (key) where status = 'done';
create index if not exists ai_fix_queued on ai_fix (created_at) where status = 'queued';

create table if not exists app_user (
  username text primary key,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_state (
  state text primary key,
  verifier text not null,
  gitlab_url text not null,
  created_at timestamptz not null default now()
);
alter table oauth_state add column if not exists scope text;
alter table oauth_state add column if not exists return_to text;

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
alter table crawl_queue add column if not exists hits int not null default 1;
