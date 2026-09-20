/**
 * Turning wallet-sdk / node failures into `SponsorError`s. The SDK surfaces submission failures as Effect
 * `FiberFailure`s whose `message` is always "Transaction submission error"; the node's real reason
 * (`1010: Invalid Transaction: Custom error: N`) is buried in the cause chain (Phase 0 §4.7).
 */
import { Cause } from 'effect';
import { SponsorError } from '../adapter.js';

/** Node 1.0.2 custom error codes observed live in Phase 0 (spikes/sponsor-spike/fixtures/node-1.0.2-error-codes.rs). */
export const NODE_ERROR_CODES: Record<number, { name: string; hint: string }> = {
  115: { name: 'InvalidProof', hint: 'a contract proof in the user transaction does not verify' },
  138: { name: 'BalanceCheckOverspend', hint: 'transaction is unbalanced (fees unpaid)' },
  166: { name: 'InvalidNetworkId', hint: 'transaction was sealed for another network' },
  193: { name: 'ReplayProtectionViolation', hint: 'the transaction (or its intents) was already applied' },
  196: { name: 'DustDoubleSpend', hint: 'the sponsor DUST coin was already spent by another transaction' },
  242: { name: 'OutOfDustValidityWindow', hint: 'intent TTL expired before inclusion' },
};

/** Walk Effect causes and plain `cause` chains and return every message/string found, outermost first. */
export const collectMessages = (e: unknown): string[] => {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number) => {
    if (x == null || depth > 8) return;
    if (typeof x === 'string') { out.push(x); return; }
    if (typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    const o = x as Record<string | symbol, unknown>;
    if (typeof o.message === 'string') out.push(o.message);
    if (typeof o._tag === 'string') out.push(String(o._tag));
    for (const sym of Object.getOwnPropertySymbols(o)) {
      if (!String(sym).includes('Cause')) continue;
      try {
        const c = o[sym] as Cause.Cause<unknown>;
        for (const f of Cause.failures(c)) walk(f, depth + 1);
        for (const d of Cause.defects(c)) walk(d, depth + 1);
      } catch { /* not a Cause */ }
    }
    for (const k of ['cause', 'error', 'reason', 'data']) if (k in o) walk(o[k], depth + 1);
    if (Array.isArray(o.errors)) for (const err of o.errors) walk(err, depth + 1);
  };
  walk(e, 0);
  return out;
};

export interface ExplainedError { text: string; nodeCode: number | null; nodeName: string | null; transport: boolean }

export const explain = (e: unknown): ExplainedError => {
  const msgs = collectMessages(e);
  const text = [...new Set(msgs)].join(' ← ').slice(0, 600) || String(e);
  const m = /Custom error:\s*(\d+)/.exec(text);
  const nodeCode = m ? Number(m[1]) : null;
  const transport = nodeCode === null && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|websocket|disconnected|Normal Closure|timeout|fetch failed|network error|503|502/i.test(text);
  return { text, nodeCode, nodeName: nodeCode !== null ? NODE_ERROR_CODES[nodeCode]?.name ?? null : null, transport };
};

/** Classify a failed submission. 193 is special: the intents are already on-chain, so the caller should confirm by identifier. */
export const submissionError = (e: unknown): SponsorError => {
  const x = explain(e);
  const alreadyImported = /1013|Already Imported/i.test(x.text);
  const detail = { nodeCode: x.nodeCode, nodeName: x.nodeName, hint: x.nodeCode !== null ? NODE_ERROR_CODES[x.nodeCode]?.hint ?? null : null, transport: x.transport, alreadyImported };
  if (alreadyImported) return new SponsorError('submit', 'SUBMISSION_FAILED', `already in the transaction pool: ${x.text}`, false, detail, { cause: e });
  if (x.nodeCode !== null) return new SponsorError('submit', 'SUBMISSION_FAILED', `node rejected the transaction: ${x.text}`, false, { ...detail, code: x.nodeCode }, { cause: e });
  return new SponsorError('submit', 'SUBMISSION_FAILED', `submission failed: ${x.text}`, x.transport, detail, { cause: e });
};

/**
 * "Already applied" answers: 193 ReplayProtectionViolation once the spend is synced, or the node's pool-level
 * `1013: Transaction Already Imported` right after inclusion. Either way the identifier will confirm.
 */
export const isReplay = (e: SponsorError) => e.detail?.code === 193 || e.detail?.alreadyImported === true;

/** Balancing failures: "could not balance dust" = every DUST coin is in flight (Phase 0 V4) → retryable. */
export const sponsoringError = (e: unknown): SponsorError => {
  const x = explain(e);
  if (/could not balance dust|Insufficient Funds/i.test(x.text))
    return new SponsorError('sponsor', 'SPONSORING_FAILED', `no free DUST coin: ${x.text}`, true, { transport: false }, { cause: e });
  if (/dust.*(balance|insufficient)/i.test(x.text))
    return new SponsorError('sponsor', 'SPONSOR_BALANCE_LOW', x.text, true, undefined, { cause: e });
  // proof-server outages (the DustSpend proof is produced there) clear on their own; retry rather than fail the request
  const retryable = x.transport || /proof server|proving|prover/i.test(x.text);
  return new SponsorError('sponsor', 'SPONSORING_FAILED', x.text, retryable, { transport: x.transport }, { cause: e });
};
