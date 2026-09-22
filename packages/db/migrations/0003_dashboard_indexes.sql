-- Phase 4: the dashboard overview and every Prometheus scrape group requests by (application, status) and read the
-- newest rows across applications. Without these two indexes both are sequential scans over the whole table.
CREATE INDEX IF NOT EXISTS sponsorship_requests_app_status_idx ON sponsorship_requests (application_id, status);
CREATE INDEX IF NOT EXISTS sponsorship_requests_created_idx ON sponsorship_requests (created_at DESC);
-- confirmation-latency percentiles (last hour) and the usage series
CREATE INDEX IF NOT EXISTS sponsorship_requests_confirmed_at_idx ON sponsorship_requests (confirmed_at) WHERE status = 'CONFIRMED';
CREATE INDEX IF NOT EXISTS usage_records_created_idx ON usage_records (created_at);
