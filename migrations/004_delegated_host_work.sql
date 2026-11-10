-- Delegated host work (D29, docs/integrations.md §3.11): a revocation's interrupt choice, and when the integration
-- was revoked, for the 24-hour window of a later "interrupt running tasks". NULL revoked_at (revoked before this
-- migration) means the window has passed.
SET LOCAL lock_timeout = '5s';
ALTER TABLE integrations ADD COLUMN revoked_at timestamptz;
ALTER TABLE integrations ADD COLUMN interrupt_running boolean NOT NULL DEFAULT false;
