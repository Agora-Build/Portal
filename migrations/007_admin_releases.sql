-- D27 slice 1 (docs/integrations.md §3.3.5; Portal issue #41): the Agora.Build admins Auth lists for each built-in Station
-- (stations.admin_accounts), against which the admin API checks its tokens; the admin API's record of every change an
-- admin asks of it (admin_actions); and the releases of the built-in Station's R9 bindings (binding_releases).
SET LOCAL lock_timeout = '5s';
-- Wait for any append in flight before locking stations, as 006 does: an appender holds this lock first.
SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'));

-- The admins Auth's built-in listing names for a built-in Station (GET /manage/v1/built-in-stations, `admins`). The admin
-- set is their union over the active built-in Stations. A custom Station has none.
ALTER TABLE stations ADD COLUMN admin_accounts text[] NOT NULL DEFAULT '{}';
ALTER TABLE stations ADD CONSTRAINT stations_admin_accounts_check CHECK (built_in OR admin_accounts = '{}');

-- Every change an admin asks of the admin API, shaped like Auth's admin_actions: written started before the change, in its
-- own statement, then done (details say what it did) or failed (details.code, the refusal's). Never deleted. For a release
-- the target is the binding as the request named it, JSON [stationId, accountId, genesisHash].
CREATE TABLE admin_actions (
  id text PRIMARY KEY CHECK (id ~ '^pa-[0-9a-hjkmnp-tv-z]{26}$'),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor ~ '^ab[0-9A-HJKMNP-TV-Z]{26}$'),
  action text NOT NULL CHECK (action IN ('binding_released')),
  target_kind text NOT NULL CHECK (target_kind IN ('binding')),
  target text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'done', 'failed')),
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX admin_actions_actor_idx ON admin_actions (actor, at);

-- An admin's release of a built-in Station's binding, kept forever. account_id is the Agora.Build owner released and
-- r9_account_id the R9 account, as in station_bindings. It stays pending until the Station's binding_changed with a higher
-- version settles it: applied (released, the same binding_id) or superseded (anything else). idempotency_key is the admin
-- site's form key and request_hash the hash of the request that made it, which tells a retry from a key reused.
CREATE TABLE binding_releases (
  release_id text PRIMARY KEY CHECK (release_id ~ '^rl-[0-9a-hjkmnp-tv-z]{26}$'),
  station_id text NOT NULL,
  account_id text NOT NULL,
  r9_account_id text NOT NULL,
  genesis_hash text NOT NULL,
  binding_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'superseded')),
  requested_at timestamptz NOT NULL,
  settled_at timestamptz,
  settled_version bigint,
  actor text NOT NULL CHECK (actor ~ '^ab[0-9A-HJKMNP-TV-Z]{26}$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{2,199}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT binding_releases_settled CHECK ((state = 'pending') = (settled_at IS NULL)),
  CONSTRAINT binding_releases_settled_version CHECK (
    (settled_at IS NULL) = (settled_version IS NULL) AND (settled_version IS NULL OR settled_version > version))
);
-- At most one pending release of one exact binding: asking again answers that one.
CREATE UNIQUE INDEX binding_releases_one_pending_idx ON binding_releases (station_id, r9_account_id, genesis_hash, binding_id, version)
  WHERE state = 'pending';
-- A binding's releases, newest first (the admin API), and settling them.
CREATE INDEX binding_releases_binding_idx ON binding_releases (station_id, r9_account_id, genesis_hash, requested_at);
-- A Station's pending releases, oldest first (the checkpoint).
CREATE INDEX binding_releases_pending_idx ON binding_releases (station_id, requested_at) WHERE state = 'pending';

-- The admin API finds bindings by the Agora.Build account or by the R9 account.
CREATE INDEX station_bindings_account_idx ON station_bindings (account_id);
CREATE INDEX station_bindings_r9_account_idx ON station_bindings (r9_account_id);
