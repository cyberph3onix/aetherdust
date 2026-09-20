-- Replay protection (plan §18) must cover every request that could spend — RESERVED and beyond — but not policy
-- rejections: nothing was consumed, and after the operator fixes the policy the DApp's already-signed transaction
-- must be sponsorable under a new request_id. (Found by the Phase 2 e2e suite.)
DROP INDEX IF EXISTS sponsorship_requests_tx_hash_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_requests_tx_hash_uidx ON sponsorship_requests (tx_hash) WHERE status <> 'REJECTED';
CREATE INDEX IF NOT EXISTS sponsorship_requests_tx_hash_idx ON sponsorship_requests (tx_hash);
