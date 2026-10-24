-- Portal's record of registered Stations and integrations (spec §3.3, §3.6, D19). Auth decides who may get tokens;
-- these tables are Portal's own history and the Stations' change feed. Rows are never deleted in normal operation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE stations (
  id text PRIMARY KEY,                         -- Auth's Station ID
  origin text NOT NULL,
  owner_account text NOT NULL,
  report_client_id text NOT NULL UNIQUE,       -- Auth's s-… report client
  status text NOT NULL CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL,
  removed_at timestamptz
);
CREATE UNIQUE INDEX stations_active_origin_idx ON stations (origin) WHERE status = 'active';
CREATE INDEX stations_owner_idx ON stations (owner_account);

CREATE TABLE station_members (
  station_id text NOT NULL REFERENCES stations (id),
  account_id text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (station_id, account_id, added_at)
);
CREATE UNIQUE INDEX station_members_current_idx ON station_members (station_id, account_id) WHERE removed_at IS NULL;
CREATE INDEX station_members_account_idx ON station_members (account_id) WHERE removed_at IS NULL;

CREATE TABLE station_challenges (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  origin text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX station_challenges_account_idx ON station_challenges (account_id, created_at);

CREATE TABLE integrations (
  id text PRIMARY KEY,                         -- Auth's i-… client ID
  owner_account text NOT NULL,
  station_id text NOT NULL REFERENCES stations (id),
  kind text NOT NULL CHECK (kind IN ('custom_app')),
  name text NOT NULL,
  scopes text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting_approval', 'provisioning', 'waiting_for_host', 'ready', 'paused', 'revoking', 'revoked')),
  resume_state text CHECK (resume_state IN ('awaiting_approval', 'provisioning', 'waiting_for_host', 'ready')),
  r9_svc text CHECK (r9_svc ~ '^[0-9a-f]{64}$'),
  quota_per_second integer NOT NULL CHECK (quota_per_second BETWEEN 1 AND 10000),
  expires_at timestamptz NOT NULL,
  approved_by text,
  approved_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integrations_owner_idx ON integrations (owner_account, created_at);
CREATE INDEX integrations_station_idx ON integrations (station_id);

-- Every change to a Station, its sharing or an integration, kept forever. Also the Stations' change feed: rows are
-- appended under one advisory lock (repository.appendEvent), so id order is commit order and a cursor never skips.
CREATE SEQUENCE integration_events_seq AS bigint;
CREATE TABLE integration_events (
  id bigint NOT NULL DEFAULT nextval('integration_events_seq'),
  at timestamptz NOT NULL DEFAULT now(),
  station_id text NOT NULL,
  integration_id text,
  account_id text NOT NULL,                    -- the object's owner, or the member added or removed
  actor text NOT NULL,                         -- an ab… account, 'station' (a Station report) or 'system'
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9_]{2,40}$'),
  state text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
ALTER SEQUENCE integration_events_seq OWNED BY integration_events.id;
CREATE INDEX integration_events_station_idx ON integration_events (station_id, id);
CREATE INDEX integration_events_integration_idx ON integration_events (integration_id, at);
CREATE INDEX integration_events_account_idx ON integration_events (account_id, at);
CREATE TABLE integration_events_default PARTITION OF integration_events DEFAULT;
