/**
 * Sponsor wallet CLI (worker image only — it needs the seed):
 *   aetherdust-wallet status          balances, coins, addresses, sync state
 *   aetherdust-wallet addresses       where to send NIGHT (unshielded) — no network sync needed
 *   aetherdust-wallet register-dust [--wait <minutes>]   register NIGHT UTXOs for DUST generation and wait (default 30 min) for the first DUST; re-runnable
 *   aetherdust-wallet new-seed        print a fresh random seed (hex) — store it as AETHERDUST_SPONSOR_SEED(_FILE)
 *   aetherdust-wallet fund <mn_addr…> <night>   send NIGHT from this wallet (e.g. seed a new sponsor from the undeployed genesis wallet)
 */
import { readFileSync } from 'node:fs';
import { loadConfig, loadSponsorSeed, midnightEndpoints } from '@aetherdust/config';
import { specksToDust } from '@aetherdust/core';
import { buildSponsorWallet, registerForDust, snapshot, transferNight, waitForSync } from '@aetherdust/midnight/wallet';

const [cmd, ...args] = process.argv.slice(2);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

const main = async () => {
  if (cmd === 'new-seed') {
    const { generateRandomSeed } = await import('@midnightntwrk/wallet-sdk-hd');
    console.log(Buffer.from(generateRandomSeed()).toString('hex'));
    return;
  }
  if (!['status', 'addresses', 'register-dust', 'fund'].includes(cmd ?? '')) {
    console.error('usage: aetherdust-wallet status|addresses|register-dust|new-seed|fund <mn_addr…> <night>');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const ep = midnightEndpoints(config);
  const w = await buildSponsorWallet(loadSponsorSeed(config, (p) => readFileSync(p, 'utf8')), {
    ...ep, feeOverheadSpecks: BigInt(config.AETHERDUST_DUST_FEE_OVERHEAD_SPECKS), feeBlocksMargin: config.AETHERDUST_DUST_FEE_BLOCKS_MARGIN,
  });
  try {
    if (cmd === 'addresses') {
      const s = await snapshot(w);
      console.log(json({ network: ep.network, unshieldedAddress: s.unshieldedAddress, dustAddress: s.dustAddress }));
      return;
    }
    console.error(`syncing sponsor wallet on ${ep.network} (${ep.indexer})…`);
    await waitForSync(w, config.AETHERDUST_WALLET_SYNC_TIMEOUT_S * 1000, (line) => console.error(`  sync: ${line}`));
    if (cmd === 'register-dust') {
      const i = args.indexOf('--wait');
      const waitMin = i >= 0 ? Number(args[i + 1]) : 30;
      if (!Number.isFinite(waitMin) || waitMin <= 0) throw new Error('--wait takes a number of minutes');
      console.log(await registerForDust(w, waitMin * 60_000, (m) => console.error(m)));
    }
    if (cmd === 'fund') {
      const [to, night] = args;
      if (!to || !night || !/^\d+(\.\d{1,6})?$/.test(night)) throw new Error('usage: fund <mn_addr…> <night, up to 6 decimals>');
      const stars = BigInt(Math.round(Number(night) * 1_000_000));
      console.log(JSON.stringify({ submitted: await transferNight(w, to, stars, 30 * 60_000), to, stars: stars.toString() }));
    }
    const s = await snapshot(w);
    console.log(json({ network: ep.network, ...s, dust: specksToDust(s.dustSpecks), night: (Number(s.nightStars) / 1_000_000).toString(), maxInFlight: s.dustCoins }));
  } finally {
    await w.facade.stop().catch(() => {});
  }
};
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
