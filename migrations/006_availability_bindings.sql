-- Delegated host work, the exact-cursor checkpoint, account availability and the built-in Station's binding reports
-- (D29, docs/integrations.md §3.11; Portal issues #40 and #41). The Portal follows every account-level entry of Auth's
-- feed in Auth's order, keeps each account's availability and whether its view is complete, and records the bindings
-- and refused binding attempts the built-in Station reports.
SET LOCAL lock_timeout = '5s';
-- Wait for any append in flight before locking a table, as ensureEventPartitions does: an appender holds this lock first.
SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'));

-- Account-level events (accounts_baseline, accounts_incomplete) name no account.
ALTER TABLE integration_events ALTER COLUMN account_id DROP NOT NULL;

-- Every account-level entry of Auth's feed the Portal applied while live, once each: re-reading the feed skips them.
-- Only Auth's three account-level kinds; the Portal's own accounts_incomplete is never one.
CREATE TABLE auth_account_entries (
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  account_id text,
  kind text NOT NULL CHECK (kind IN ('account_disabled', 'account_enabled', 'accounts_baseline')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_cursor, auth_at)
);

-- Each account's availability as the latest applied entry says. An account with no row is enabled (or doesn't exist).
CREATE TABLE account_availability (
  account_id text PRIMARY KEY,
  disabled boolean NOT NULL,
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A rebuild (service.accountsStartingOver) applies Auth's whole feed to these instead, so neither the live table nor the
-- built-in Stations ever see a superseded state; once it has caught up with the end of the feed (accountsCaughtUp) the
-- Portal adopts it, and the Stations hear only how it differs from the live table. INCLUDING ALL copies the keys and
-- checks, the kind's too.
CREATE TABLE auth_account_entries_rebuild (LIKE auth_account_entries INCLUDING ALL);
CREATE TABLE account_availability_rebuild (LIKE account_availability INCLUDING ALL);

-- The last accounts_baseline applied (one row once there is one), and whether the Portal's view of the accounts is
-- complete: true only while live, from an in-order baseline on, so an account missing from the disabled list is
-- enabled. A start-over or a move to waiting makes it false again; the baseline stays recorded.
CREATE TABLE account_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  complete boolean NOT NULL DEFAULT false
);

-- How the Portal follows Auth's accounts, on the one row of its place in Auth's feed:
-- * accounts_mode: rebuilding (into the tables above, from the feed's first entry), live (each entry as it comes), or
--   waiting (an account-level entry was skipped, so what is applied can't be trusted to be all of the feed: nothing more
--   is applied until an operator resets the Portal's Auth cursor, docs/platform.md, and the Portal rebuilds);
-- * accounts_epoch: raised by every start-over. A read pass applies account-level entries, and saves its cursor, only in
--   the epoch it began in, so a pass in flight when another replica started over is fenced;
-- * accounts_cursor: a copy of cursor, which this image writes with it every time. An image from before this migration
--   writes cursor alone, and skips account-level entries unrecorded; a cursor that differs from its copy was moved by one,
--   so the reader starts over (the setting on) or the Portal waits (off) rather than trust what it holds;
-- * rebuild_baseline_cursor and _at: the accounts_baseline the current rebuild applied, if any;
-- * accounts_incomplete_owed: the view stopped being complete while the setting was off, so the built-in Stations, which
--   were told it was complete, are told it is not the next time the Portal runs with the setting on.
ALTER TABLE auth_change_feed
  ADD COLUMN accounts_mode text NOT NULL DEFAULT 'rebuilding' CHECK (accounts_mode IN ('rebuilding', 'live', 'waiting')),
  ADD COLUMN accounts_epoch bigint NOT NULL DEFAULT 0 CHECK (accounts_epoch >= 0),
  ADD COLUMN accounts_cursor text CHECK (accounts_cursor ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD COLUMN rebuild_baseline_cursor text CHECK (rebuild_baseline_cursor ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD COLUMN rebuild_baseline_at timestamptz,
  ADD COLUMN accounts_incomplete_owed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT auth_change_feed_rebuild_baseline CHECK ((rebuild_baseline_cursor IS NULL) = (rebuild_baseline_at IS NULL));
-- A fresh Portal starts by rebuilding. One that already read some of Auth's feed skipped every account-level entry in it
-- unrecorded (no Portal before this one applied them), so it waits for an operator to reset its cursor. Either way the
-- cursor gets its copy, so the migration's own row is not taken for an older image's write.
UPDATE auth_change_feed SET accounts_mode = 'waiting', accounts_cursor = cursor WHERE cursor IS NOT NULL;

-- The built-in Station's last reported binding per R9 account.
CREATE TABLE station_bindings (
  station_id text NOT NULL,
  r9_account_id text NOT NULL,
  genesis_hash text NOT NULL,
  account_id text NOT NULL,
  binding_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  binding_state text NOT NULL CHECK (binding_state IN ('bound', 'unbound', 'released')),
  report_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, r9_account_id, genesis_hash)
);

-- The built-in Station's refused binding attempts, shown to the account each one protects.
CREATE TABLE binding_attempts (
  station_id text NOT NULL,
  report_id text NOT NULL,
  account_id text NOT NULL,
  r9_account_id text NOT NULL,
  genesis_hash text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('bound_elsewhere', 'owner_disabled')),
  attempted_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, report_id)
);
CREATE INDEX binding_attempts_account_idx ON binding_attempts (account_id, attempted_at);

-- Binding reports name no integration, and are kept by their report id like the revocation reports.
ALTER TABLE station_reports ALTER COLUMN integration_id DROP NOT NULL;

-- The Station directory reads an account's ended memberships too; 001's index covers current members only.
CREATE INDEX station_members_account_all_idx ON station_members (account_id);
