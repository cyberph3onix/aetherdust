/**
 * Phase 0 — offline checks (no node/indexer/proof server needed).
 *
 * Exercises real ledger-v8 code paths that AetherDust's API process will run on untrusted bytes:
 *   - deserialization strictness (malformed / truncated / wrong-variant bytes)
 *   - inspection: contract calls, deploys, TTLs, dust actions
 *   - policy verdicts on those summaries (V11)
 *   - fee computation from ledger parameters (part of V3)
 *   - merge semantics: segment collisions, identifiers, hash changes (part of V1/V2)
 *   - serialization round-trip stability (wire format for DApp → AetherDust)
 * Writes fixtures to ./fixtures for reuse in AetherDust unit tests.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { checkPolicy, InspectError, inspectFinalizedBytes, specksToDust, summarize } from './inspect.js';

const NET = 'undeployed';
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail = '') => {
  results.push({ check, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${check}${detail ? ` — ${detail}` : ''}`);
};
const expectThrow = (check: string, fn: () => unknown, codeIncludes?: string) => {
  try {
    fn();
    record(check, false, 'did not throw');
  } catch (e) {
    const msg = e instanceof InspectError ? `${e.code}: ${e.message}` : String((e as Error).message ?? e);
    record(check, codeIncludes ? msg.includes(codeIncludes) : true, msg.slice(0, 140));
  }
};

mkdirSync('fixtures', { recursive: true });
const save = (name: string, bytes: Uint8Array) => writeFileSync(`fixtures/${name}`, bytes);

const ttl = new Date(Date.now() + 30 * 60 * 1000);
const params = ledger.LedgerParameters.initialParameters();

// ---------- Fixture 1: finalized tx containing a ContractDeploy (mock-proven, bound) ----------
const deployTx = (net = NET) => {
  const intent = ledger.Intent.new(ttl).addDeploy(new ledger.ContractDeploy(new ledger.ContractState()));
  return ledger.Transaction.fromParts(net, undefined, undefined, intent);
};
const finalizedDeploy = deployTx().mockProve().bind();
const deployBytes = finalizedDeploy.serialize();
save('finalized-deploy.undeployed.bin', deployBytes);
record('build finalized deploy fixture', true, `${deployBytes.byteLength} bytes, hash ${finalizedDeploy.transactionHash().slice(0, 16)}…`);

// ---------- Fixture 2: unproven contract call (no proof available offline) ----------
let callBytesPreProof: Uint8Array | undefined;
const contractAddr = ledger.sampleContractAddress();
try {
  const op = new ledger.ContractOperation();
  const empty: ledger.AlignedValue = { value: [], alignment: [] };
  const proto = new ledger.ContractCallPrototype(
    contractAddr, 'increment', op, undefined, undefined, [], empty, empty,
    ledger.communicationCommitmentRandomness(), 'increment',
  );
  const intent = ledger.Intent.new(ttl).addCall(proto);
  const unproven = ledger.Transaction.fromParts(NET, undefined, undefined, intent);
  callBytesPreProof = unproven.serialize();
  save('unproven-call.undeployed.bin', callBytesPreProof);
  const s = summarize(unproven, callBytesPreProof.byteLength);
  record('build unproven contract-call fixture', s.calls.length === 1 && s.calls[0].entryPoint === 'increment',
    `calls=${JSON.stringify(s.calls)} ttl=${s.minIntentTtl?.toISOString()}`);
} catch (e) {
  record('build unproven contract-call fixture', false, String((e as Error).message));
}

// ---------- Inspection on the finalized deploy fixture ----------
const sDeploy = inspectFinalizedBytes(deployBytes);
record('inspect: deploy detected, no calls, no dust', sDeploy.deploys === 1 && sDeploy.calls.length === 0 && !sDeploy.hasDustActions,
  JSON.stringify({ deploys: sDeploy.deploys, ids: sDeploy.identifiers.length, ttl: sDeploy.minIntentTtl?.toISOString() }));
const v = checkPolicy(sDeploy, { allowed: { [contractAddr]: ['increment'] }, minTtlRemainingMs: 60_000 });
record('policy: deploy rejected fail-closed', !v.ok && v.code === 'CONTRACT_NOT_ALLOWED', JSON.stringify(v));

// ---------- V11: adversarial / malformed inputs must fail before any sponsor resource ----------
expectThrow('reject random bytes', () => inspectFinalizedBytes(randomBytes(200)), 'DESERIALIZE_FAILED');
expectThrow('reject truncated finalized tx', () => inspectFinalizedBytes(deployBytes.subarray(0, deployBytes.byteLength - 7)), 'DESERIALIZE_FAILED');
expectThrow('reject empty bytes', () => inspectFinalizedBytes(new Uint8Array()), 'DESERIALIZE_FAILED');
expectThrow('reject oversize (limit 100B)', () => inspectFinalizedBytes(deployBytes, 100), 'TOO_LARGE');
if (callBytesPreProof) {
  expectThrow('reject unproven tx presented as finalized (wrong variant)', () => inspectFinalizedBytes(callBytesPreProof!), 'DESERIALIZE_FAILED');
}
// bit-flip fuzz: 64 single-byte corruptions must never produce a "valid" tx that differs silently
let fuzzThrows = 0, fuzzSame = 0, fuzzDiff = 0;
for (let i = 0; i < 64; i++) {
  const b = new Uint8Array(deployBytes);
  const pos = Math.floor(Math.random() * b.length);
  b[pos] ^= 1 << Math.floor(Math.random() * 8);
  try {
    const t = ledger.Transaction.deserialize('signature', 'proof', 'binding', b);
    if (t.transactionHash() === finalizedDeploy.transactionHash()) fuzzSame++; else fuzzDiff++;
  } catch { fuzzThrows++; }
}
record('bit-flip fuzz (64): corruptions rejected or hash-changed', fuzzSame === 0, `throws=${fuzzThrows} diffHash=${fuzzDiff} sameHash=${fuzzSame}`);

// ---------- Wrong network id ----------
const previewBytes = deployTx('preview').mockProve().bind().serialize();
save('finalized-deploy.preview.bin', previewBytes);
const sPreview = summarize(ledger.Transaction.deserialize('signature', 'proof', 'binding', previewBytes), previewBytes.byteLength);
record('network id is NOT recoverable from summary alone (must use validateTransaction / wellFormed)', true,
  `preview fixture deserializes fine; hash ${sPreview.txHash.slice(0, 12)}… ≠ undeployed ${sDeploy.txHash.slice(0, 12)}…`);
try {
  const st = ledger.LedgerState.blank(NET);
  const strict = new ledger.WellFormedStrictness();
  strict.enforceBalancing = false; strict.verifyNativeProofs = false; strict.verifyContractProofs = false;
  strict.enforceLimits = true; strict.verifySignatures = true;
  let undeployedOk = true, previewOk = true;
  let uErr = '', pErr = '';
  try { finalizedDeploy.wellFormed(st, strict, new Date()); } catch (e) { undeployedOk = false; uErr = String((e as Error).message ?? e).slice(0, 160); }
  try { ledger.Transaction.deserialize('signature', 'proof', 'binding', previewBytes).wellFormed(st, strict, new Date()); } catch (e) { previewOk = false; pErr = String((e as Error).message ?? e).slice(0, 160); }
  record('wellFormed rejects wrong network id before anything else', !previewOk && pErr.includes('invalid network ID'), pErr);
  record('wellFormed cannot validate mock-proven tx offline (binding) — live validateTransaction needed', !undeployedOk, uErr.slice(0, 60));
} catch (e) {
  record('wellFormed network check', false, String((e as Error).message));
}

// ---------- Serialization round-trip (wire format) ----------
const rt = ledger.Transaction.deserialize('signature', 'proof', 'binding', deployBytes).serialize();
record('serialize→deserialize→serialize is byte-stable', Buffer.compare(Buffer.from(rt), Buffer.from(deployBytes)) === 0);

// ---------- Fees (V3 groundwork) ----------
const fee = finalizedDeploy.fees(params);
const feeM = finalizedDeploy.feesWithMargin(params, 1.5);
record('fees(params) computable offline', fee > 0n, `fee=${fee} specks (${specksToDust(fee)} DUST); withMargin(1.5)=${feeM} (${specksToDust(feeM)} DUST)`);
const imb = finalizedDeploy.imbalances(0, fee);
record('imbalances(segment 0, fee) reports unpaid DUST fee', imb.size >= 1, [...imb.entries()].map(([k, v]) => `${JSON.stringify(k)}=${v}`).join(', '));

// ---------- Merge semantics (V1/V2 groundwork) ----------
const txA = deployTx().mockProve().bind();
const txB = deployTx().mockProve().bind();
expectThrow('merge of two txs with the same intent segment id throws (why the wallet randomizes segments)', () => txA.merge(txB));
const txC = ledger.Transaction.fromPartsRandomized(NET, undefined, undefined,
  ledger.Intent.new(ttl).addDeploy(new ledger.ContractDeploy(new ledger.ContractState()))).mockProve().bind();
try {
  const merged = txA.merge(txC);
  const ids = merged.identifiers();
  const unionOk = txA.identifiers().every((i) => ids.includes(i)) && txC.identifiers().every((i) => ids.includes(i));
  record('merge with randomized segment succeeds; identifiers = union', unionOk,
    `A=${txA.identifiers().length} C=${txC.identifiers().length} merged=${ids.length}; segments=${[...(merged.intents?.keys() ?? [])].join(',')}`);
  record('merged transactionHash differs from both inputs', merged.transactionHash() !== txA.transactionHash() && merged.transactionHash() !== txC.transactionHash(),
    `A ${txA.transactionHash().slice(0, 12)}… C ${txC.transactionHash().slice(0, 12)}… M ${merged.transactionHash().slice(0, 12)}…`);
  record('user tx identifiers survive merge (candidate confirmation key, V2)', txA.identifiers().every((i) => ids.includes(i)));
  save('merged-two-deploys.undeployed.bin', merged.serialize());
} catch (e) {
  record('merge with randomized segment', false, String((e as Error).message));
}

// ---------- Ledger parameters snapshot ----------
const d = params.dust;
console.log('\nledger initialParameters().dust:', d.toString());

const failed = results.filter((r) => !r.ok);
writeFileSync('fixtures/offline-results.json', JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
