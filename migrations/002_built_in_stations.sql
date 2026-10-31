-- The built-in Station (spec §3.3.2, D24): Auth admits it from its clients file, nobody owns it and every account may
-- use it. Portal's row mirrors Auth's listing (builtIn, access, integrations, name); owner_account is NULL for it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE stations ALTER COLUMN owner_account DROP NOT NULL;
ALTER TABLE stations ADD COLUMN built_in boolean NOT NULL DEFAULT false;
ALTER TABLE stations ADD COLUMN access text NOT NULL DEFAULT 'members' CHECK (access IN ('members', 'any_account'));
ALTER TABLE stations ADD COLUMN integrations_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE stations ADD COLUMN name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60);
ALTER TABLE stations ADD CONSTRAINT stations_built_in_owner_check CHECK (
  (built_in AND owner_account IS NULL AND access = 'any_account')
  OR (NOT built_in AND owner_account IS NOT NULL AND access = 'members')
);
-- Every account's listing reads the active built-in Stations; plan limits count per Station and owner.
CREATE INDEX stations_built_in_idx ON stations (created_at, id) WHERE built_in AND status = 'active';
CREATE INDEX integrations_station_owner_idx ON integrations (station_id, owner_account) WHERE state <> 'revoked';
