-- Delegated host work, the exact-cursor checkpoint, account availability and the built-in Station's binding reports
-- (D29, docs/integrations.md §3.11; Portal issues #40 and #41). The Portal applies every account-level entry of Auth's
-- feed once, keeps each account's availability and whether Auth's accounts baseline was applied, and records the
-- bindings and refused binding attempts the built-in Station reports.
SET LOCAL lock_timeout = '5s';
-- Wait for any append in flight before locking a table, as ensureEventPartitions does: an appender holds this lock first.
SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'));

-- Account-level events (accounts_baseline) name no account.
ALTER TABLE integration_events ALTER COLUMN account_id DROP NOT NULL;

-- Every account-level entry of Auth's feed the Portal applied, once each: re-reading the feed skips them.
CREATE TABLE auth_account_entries (
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  account_id text,
  kind text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_cursor, auth_at)
);

-- Each account's availability as the latest applied entry says.
CREATE TABLE account_availability (
  account_id text PRIMARY KEY,
  disabled boolean NOT NULL,
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row once an accounts_baseline is applied; deleted when the Portal skips an account-level entry (with its setting
-- off, say). The baseline is complete only once the Portal has also caught up with the end of Auth's feed: it is then
-- true, and the built-in Stations are told. Starting the feed over (a first start or a reset) makes it false again.
CREATE TABLE account_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  auth_cursor text NOT NULL,
  auth_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  complete boolean NOT NULL DEFAULT false
);

-- Set when the Portal skips an account-level entry of Auth's feed (service.forgetAccounts): the applied account entries must
-- always be a prefix of Auth's feed, so until the feed is read again from the start (the reader's start-over clears it)
-- every account-level entry is skipped and not recorded, and the accounts never become complete. It is kept on the one-row
-- table of the Portal's place in the feed.
ALTER TABLE auth_change_feed ADD COLUMN accounts_need_replay boolean NOT NULL DEFAULT false;

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
