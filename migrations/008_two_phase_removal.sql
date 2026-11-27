-- Two-phase Station removal (D29, docs/integrations.md §3.11; Atem designs/delegated-host-work.md I.8): a custom Station
-- being removed is `removing` while it passes its integrations' revocations to the hosts, until every integration on it is
-- revoked or 26 hours have passed; an integration whose Station couldn't confirm its revocation on every host is flagged,
-- for the owner's native revoke in Astation.
SET LOCAL lock_timeout = '5s';
-- Wait for any append in flight before locking stations and integrations, as 006 and 007 do: an appender holds this lock
-- first.
SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'));

-- active, then removing, then removed. A removing Station still reads its feed and reports; nothing else uses it. It has
-- the time its removal began (the Portal's clock); it is due 26 hours later, and removed at the first hourly check at or
-- after that.
ALTER TABLE stations DROP CONSTRAINT stations_status_check;
ALTER TABLE stations ADD CONSTRAINT stations_status_check CHECK (status IN ('active', 'removing', 'removed'));
ALTER TABLE stations ADD COLUMN removal_started_at timestamptz;
ALTER TABLE stations ADD CONSTRAINT stations_removal_started_check
  CHECK (status <> 'removing' OR removal_started_at IS NOT NULL);
-- A removing Station keeps its origin, as at Auth (its migration 012): another Station may register it once it is removed.
DROP INDEX stations_active_origin_idx;
CREATE UNIQUE INDEX stations_active_origin_idx ON stations (origin) WHERE status IN ('active', 'removing');
-- The hourly sync reads the removing Stations.
CREATE INDEX stations_removing_idx ON stations (removal_started_at, id) WHERE status = 'removing';

-- Revoked, but its Station couldn't confirm the revocation on every host (pending host revocation): the owner's native
-- revoke clears it. Only a revoked integration has it.
ALTER TABLE integrations ADD COLUMN pending_host_revocation boolean NOT NULL DEFAULT false;
ALTER TABLE integrations ADD CONSTRAINT integrations_pending_host_revocation_check
  CHECK (NOT pending_host_revocation OR state = 'revoked');
