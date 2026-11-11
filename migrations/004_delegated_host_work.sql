-- Delegated host work (D29, docs/integrations.md §3.11): a revocation's interrupt choice, and when the integration
-- was revoked, for the 24-hour window of a later "interrupt running tasks". NULL revoked_at (revoked before this
-- migration) means the window has passed.
SET LOCAL lock_timeout = '5s';
ALTER TABLE integrations ADD COLUMN revoked_at timestamptz;
ALTER TABLE integrations ADD COLUMN interrupt_running boolean NOT NULL DEFAULT false;

-- A built-in Station's account-level events (account_disabled, account_enabled: no integration) are read by Station and
-- account: accountChangeApplied, inside the global event lock, and disabledAccounts. 001's integration_events_account_idx
-- is by account and time, so these would scan every event of the Station.
CREATE INDEX integration_events_station_account_idx ON integration_events (station_id, account_id, id) WHERE integration_id IS NULL;
