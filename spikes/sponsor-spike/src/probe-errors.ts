/** Submit known-bad transactions and print the node's real rejection reasons (Effect FiberFailure unwrapping). */
import { readFileSync, readdirSync } from 'node:fs';
import { Cause } from 'effect';
import { loadConfig, sponsorSeed } from './config.js';
import { deserializeFinalized } from './inspect.js';
import { buildWallet, waitForSync } from './wallet.js';

const cfg = loadConfig();
const dir = `fixtures/live/${readdirSync('fixtures/live').filter((d) => d.startsWith('undeployed-')).sort().at(-1)}`;
const explain = (e: any) => {
  const out: string[] = [];
  const causeSym = Object.getOwnPropertySymbols(e).find((s) => String(s).includes('Cause'));
  if (causeSym) {
    try {
      const c = e[causeSym];
      for (const f of Cause.failures(c)) {
        const walk = (x: any, d = 0): string => x && typeof x === 'object' && d < 6
          ? `${x._tag ?? x.constructor?.name ?? 'obj'}{${Object.getOwnPropertyNames(x).filter((k) => !['stack','cause'].includes(k)).map((k) => `${k}=${JSON.stringify(x[k], (_k, v) => typeof v === 'bigint' ? v.toString() : v)?.slice(0, 300)}`).join(', ')}}` + (x.cause ? ' ← ' + walk(x.cause, d + 1) : '') + (x.error ? ' ← error:' + walk(x.error, d + 1) : '')
          : String(x);
        out.push(`failure: ${walk(f)}`);
      }
      for (const d of Cause.defects(c)) out.push(`defect: ${String(d).slice(0, 300)}`);
    } catch (err) { out.push(`cause-walk failed: ${err}`); }
  }
  if (e?.cause) out.push(`cause: ${JSON.stringify(e.cause, Object.getOwnPropertyNames(e.cause)).slice(0, 400)}`);
  return out.join('\n   ');
};
const main = async () => {
  const w = await buildWallet(cfg, sponsorSeed(), 'sponsor');
  await waitForSync(w);
  for (const [label, file] of [['unpaid user tx', 'user-sealed-unpaid.bin'], ['replayed merged tx', 'merged-sponsored.bin']]) {
    const tx = deserializeFinalized(new Uint8Array(readFileSync(`${dir}/${file}`)));
    console.log(`\n== ${label} via facade.submitTransaction ==`);
    try { console.log('ACCEPTED', await w.wallet.submitTransaction(tx)); } catch (e) { console.log('   ' + explain(e)); }
    console.log(`== ${label} via submissionService('Submitted') ==`);
    try { const r = await w.wallet.submissionService.submitTransaction(tx, 'Submitted'); console.log('ACCEPTED', JSON.stringify(r).slice(0, 200)); } catch (e) { console.log('   ' + explain(e)); }
  }
  await w.wallet.stop(); process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
