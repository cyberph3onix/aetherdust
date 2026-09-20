-- AetherDust schema v1 (IMPLEMENTATION_PLAN.md §15, adjusted after Phase 0)
CREATE TABLE IF NOT EXISTS applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  key_id          text NOT NULL UNIQUE,
  secret_hash     text NOT NULL,
  env             text NOT NULL,
  label           text,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  last_used_at    timestamptz
);

-- append-only; the highest version is the active policy
CREATE TABLE IF NOT EXISTS policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  version         integer NOT NULL,
  document        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version)
);

-- one row per (app, scope, key, period); all amounts in SPECK
CREATE TABLE IF NOT EXISTS budget_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  scope           text NOT NULL CHECK (scope IN ('global', 'user')),
  scope_key       text NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  limit_specks    numeric(39,0) NOT NULL,
  reserved_specks numeric(39,0) NOT NULL DEFAULT 0 CHECK (reserved_specks >= 0),
  settled_specks  numeric(39,0) NOT NULL DEFAULT 0 CHECK (settled_specks >= 0),
  UNIQUE (application_id, scope, scope_key, period_start)
);

CREATE TABLE IF NOT EXISTS sponsorship_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  request_id            text NOT NULL,
  user_id               text NOT NULL,
  claimed_contract      text,
  claimed_entry_point   text,
  tx_format             text NOT NULL,
  tx_hash               text NOT NULL,
  tx_bytes              bytea NOT NULL,
  tx_summary            jsonb NOT NULL,
  policy_version        integer,
  estimated_fee_specks  numeric(39,0),
  reserved_specks       numeric(39,0) NOT NULL DEFAULT 0,
  actual_fee_specks     numeric(39,0),
  period_start          timestamptz,
  status                text NOT NULL,
  reason_code           text,
  reason_detail         text,
  merged_tx_bytes       bytea,
  submitted_identifier  text,
  submitted_tx_hash     text,
  submitted_at          timestamptz,
  confirmed_at          timestamptz,
  block_height          integer,
  ttl_at                timestamptz,
  worker_id             text,
  attempts              integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, request_id)
);
-- the same transaction bytes may never be sponsored twice, under any request id
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_requests_tx_hash_uidx ON sponsorship_requests (tx_hash);
CREATE INDEX IF NOT EXISTS sponsorship_requests_app_created_idx ON sponsorship_requests (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sponsorship_requests_status_idx ON sponsorship_requests (status);
CREATE INDEX IF NOT EXISTS sponsorship_requests_user_idx ON sponsorship_requests (application_id, user_id);

-- audit trail: every transition
CREATE TABLE IF NOT EXISTS request_events (
  id           bigserial PRIMARY KEY,
  request_id   uuid NOT NULL REFERENCES sponsorship_requests(id),
  from_status  text,
  to_status    text NOT NULL,
  reason_code  text,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id, id);

-- written exactly once per CONFIRMED request
CREATE TABLE IF NOT EXISTS usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL UNIQUE REFERENCES sponsorship_requests(id),
  application_id  uuid NOT NULL REFERENCES applications(id),
  user_id         text NOT NULL,
  contract        text NOT NULL,
  entry_point     text NOT NULL,
  specks          numeric(39,0) NOT NULL,
  period_start    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_records_app_period_idx ON usage_records (application_id, period_start);
CREATE INDEX IF NOT EXISTS usage_records_app_created_idx ON usage_records (application_id, created_at);

CREATE TABLE IF NOT EXISTS sponsor_wallet_snapshots (
  id                  bigserial PRIMARY KEY,
  adapter             text NOT NULL,
  network             text NOT NULL,
  dust_balance_specks numeric(39,0) NOT NULL,
  dust_cap_specks     numeric(39,0),
  night_stars         numeric(39,0),
  dust_coins          integer NOT NULL,
  dust_coins_in_flight integer NOT NULL DEFAULT 0,
  synced              boolean NOT NULL,
  healthy             boolean NOT NULL,
  detail              jsonb,
  taken_at            timestamptz NOT NULL DEFAULT now()
);
