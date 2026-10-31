-- Admin changes from Auth (Agora.Build integrations design §3.3.4, D26, owner decisions after the Auth review): the
-- Portal reads Auth's change feed and follows each change on its own rows (scripts/integrations/auth-changes.mjs,
-- service.applyAuthChange).
SET LOCAL lock_timeout = '5s';

-- Who paused a paused integration, as Auth answers it (pausedBy): its owner, its custom Station's owner, or an
-- Agora.Build admin, whose pause only an admin lifts. NULL when nobody is recorded; read only while state is 'paused'.
ALTER TABLE integrations ADD COLUMN paused_by text CHECK (paused_by IN ('owner', 'station', 'admin'));
-- Set while Auth's feed says the integration's owner account is disabled (owner_disabled, until owner_enabled). Auth
-- issues it no token meanwhile; the Portal and the Station's feed show it as paused (states.mjs effectiveState).
ALTER TABLE integrations ADD COLUMN owner_disabled_at timestamptz;

-- Where the Portal is in Auth's change feed: Auth's opaque cursor after the last page it read, NULL before the first.
-- Exactly one row.
CREATE TABLE auth_change_feed (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor text CHECK (cursor ~ '^[A-Za-z0-9_-]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_change_feed (id) VALUES (true);
