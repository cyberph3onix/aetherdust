/**
 * Operator onboarding on a real chain: a brand-new sponsor seed (0 NIGHT / 0 DUST) is funded with NIGHT, registers its
 * UTXO for DUST generation (`aetherdust-wallet register-dust`), and once DUST exists it can estimate and sponsor.
 * Runs in the in-process e2e only (needs the genesis wallet to fund from). Measures how long DUST takes to appear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateRandomSeed } from '@midnightntwrk/wallet-sdk-hd';
import { loadConfig, midnightEndpoints } from '@aetherdust/config';
import { buildSponsorWallet, registerForDust, snapshot, transferNight, waitForState, waitForSync, type SponsorWallet } from '@aetherdust/midnight/wallet';

const E2E = process.env.AETHERDUST_E2E === '1' && !process.env.AETHERDUST_E2E_API_URL;
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const ep = midnightEndpoints(loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: 'e2e-admin-token-0123456789', ...process.env }));
const opts = { ...ep, feeOverheadSpecks: 0n, feeBlocksMargin: 5 };

let genesis: SponsorWallet; let fresh: SponsorWallet;

describe.skipIf(!E2E)('e2e: new sponsor onboarding (fund → register-dust → DUST)', () => {
  beforeAll(async () => {
    genesis = await buildSponsorWallet(GENESIS_SEED, opts);
    await waitForSync(genesis, 600_000);
    fresh = await buildSponsorWallet(Buffer.from(generateRandomSeed()).toString('hex'), opts);
    await waitForSync(fresh, 120_000);
  }, 15 * 60_000);
  afterAll(async () => { await Promise.allSettled([genesis?.facade.stop(), fresh?.facade.stop()]); });

  it('a fresh seed funded with NIGHT registers for DUST generation and starts generating', async () => {
    const before = await snapshot(fresh);
    expect(before).toMatchObject({ nightStars: 0n, nightUtxos: 0, dustCoins: 0, dustSpecks: 0n });

    // 1. fund (what an operator does with `aetherdust-wallet fund` / a faucet)
    const t0 = Date.now();
    await transferNight(genesis, before.unshieldedAddress, 100_000_000n, 30 * 60_000); // 100 NIGHT
    const funded = await waitForState(fresh, (s) => (s.unshielded.availableCoins.length > 0 ? s : undefined), 180_000, 'NIGHT to arrive');
    const fundedAt = Date.now();
    expect(funded.unshielded.availableCoins.length).toBe(1);
    expect((await snapshot(fresh)).nightStars).toBe(100_000_000n);

    // 2. register (needs DUST for the registration fee — none yet: the registration tx is paid by... the registration itself)
    const outcome = await registerForDust(fresh, 10 * 60_000, (m) => console.log(`[register-dust] ${m}`));
    const dustAt = Date.now();
    expect(outcome).toBe('registered');
    const after = await snapshot(fresh);
    console.log(`[register-dust] NIGHT arrived in ${((fundedAt - t0) / 1000).toFixed(1)} s; first DUST ${((dustAt - fundedAt) / 1000).toFixed(1)} s after that; balance ${after.dustSpecks} SPECK, coins ${after.dustCoins}`);
    expect(after.nightUtxosRegisteredForDust).toBe(1);
    expect(after.dustCoins).toBe(1);
    expect(after.dustSpecks).toBeGreaterThan(0n);

    // 3. it is now a usable sponsor: a fee estimate for a real user tx succeeds against this wallet
    const { readFileSync } = await import('node:fs');
    const { deserializeFinalized } = await import('@aetherdust/midnight');
    const userTx = deserializeFinalized(new Uint8Array(readFileSync(new URL('../../packages/midnight/fixtures/user-sealed-unpaid-4.bin', import.meta.url))));
    const fee = await fresh.facade.estimateTransactionFee(userTx, fresh.dustSecretKey, { ttl: new Date(Date.now() + 30 * 60_000) });
    expect(fee).toBeGreaterThan(0n);
  }, 15 * 60_000);
});
