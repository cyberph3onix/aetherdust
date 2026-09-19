/**
 * Operator helpers: pnpm wallet status|register-dust|fund <bech32-unshielded-addr> <stars>|new-seed
 * Uses SPONSOR_SEED (default: undeployed genesis seed).
 */
import { generateRandomSeed } from '@midnightntwrk/wallet-sdk-hd';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { UnshieldedAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { loadConfig, sponsorSeed } from './config.js';
import { specksToDust } from './inspect.js';
import { buildWallet, registerForDust, signRecipeWithFallback, snapshot, ttl, waitForSync } from './wallet.js';

const [cmd, ...args] = process.argv.slice(2);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

const main = async () => {
  if (cmd === 'new-seed') { console.log(Buffer.from(generateRandomSeed()).toString('hex')); return; }
  const cfg = loadConfig();
  const ctx = await buildWallet(cfg, sponsorSeed(), 'wallet');
  await waitForSync(ctx);
  if (cmd === 'status') {
    const s = await snapshot(ctx);
    console.log(json({ ...s, dust: specksToDust(s.dustSpecks), nightWhole: (s.nightStars / 1_000_000n).toString() }));
  } else if (cmd === 'register-dust') {
    console.log(await registerForDust(ctx));
    console.log(json(await snapshot(ctx)));
  } else if (cmd === 'fund') {
    const [addr, stars] = args;
    const receiver = MidnightBech32m.parse(addr).decode(UnshieldedAddress, cfg.network);
    const recipe = await ctx.wallet.transferTransaction(
      [{ type: 'unshielded', outputs: [{ type: unshieldedToken().raw, receiverAddress: receiver, amount: BigInt(stars) }] }],
      { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey }, { ttl: ttl() });
    const signed = await signRecipeWithFallback(ctx, recipe);
    const tx = await ctx.wallet.finalizeRecipe(signed.recipe);
    console.log('submitted', await ctx.wallet.submitTransaction(tx));
  } else {
    console.log('usage: wallet status|register-dust|fund <addr> <stars>|new-seed');
  }
  await ctx.wallet.stop();
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
