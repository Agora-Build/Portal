-- Delegated host work, Phase B (D29, docs/integrations.md §3.11): a Station's revocation reports. Report ids are
-- per Station and kept forever, with the body and the answer they got, so a retry gets the same answer and a reused
-- id is refused. The hosts that applied a revocation, and its final outcome, are kept per integration.
SET LOCAL lock_timeout = '5s';
CREATE TABLE station_reports (
  station_id text NOT NULL,
  report_id text NOT NULL CHECK (report_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  integration_id text NOT NULL,
  body jsonb NOT NULL,
  answer jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, report_id)
);
CREATE TABLE revocation_hosts (
  integration_id text NOT NULL,
  host text NOT NULL,
  record_id text NOT NULL,
  report_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, host)
);
ALTER TABLE integrations ADD COLUMN revocation_outcome text CHECK (revocation_outcome IN ('all_applied', 'deadline_passed'));
ALTER TABLE integrations ADD COLUMN revocation_pending_hosts jsonb;
