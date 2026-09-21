/**
 * A DApp-connector-shaped wallet (the `SponsorableWallet` subset of `ConnectedAPI` v4) implemented on the wallet SDK.
 * It lets the *exact* SDK provider path a browser DApp uses (`createSponsoredMidnightProvider`) run server-side
 * against a real chain — the Node-side stand-in for Lace (plan §22 Phase 3 fallback; V7 still needs a real Lace).
 * Same wire conventions as the connector: serialized ledger-v8 transactions as hex strings.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { fromHex, toHex, type SponsorableWallet } from '@aetherdust/client';
import { signRecipe, type SponsorWallet } from '@aetherdust/midnight/wallet';
import * as Rx from 'rxjs';

export const connectorShim = (w: SponsorWallet, ttl: () => Date = () => new Date(Date.now() + 30 * 60_000)): SponsorableWallet & { calls: { payFees: boolean | undefined }[] } => ({
  calls: [],
  async getShieldedAddresses() {
    const s = await Rx.firstValueFrom(w.facade.state());
    return { shieldedCoinPublicKey: s.shielded.coinPublicKey.toHexString(), shieldedEncryptionPublicKey: s.shielded.encryptionPublicKey.toHexString() };
  },
  async balanceUnsealedTransaction(tx, options) {
    this.calls.push({ payFees: options?.payFees });
    // "unsealed" = Transaction<SignatureEnabled, Proof, PreBinding> (the connector spec), i.e. midnight-js's UnboundTransaction
    const unbound = ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', fromHex(tx));
    const kinds: ('shielded' | 'unshielded' | 'dust')[] = options?.payFees === false ? ['shielded', 'unshielded'] : ['shielded', 'unshielded', 'dust'];
    const recipe = await w.facade.balanceUnboundTransaction(unbound, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: ttl(), tokenKindsToBalance: kinds });
    const sealed = await w.facade.finalizeRecipe(await signRecipe(w, recipe));
    return { tx: toHex(sealed.serialize()) };
  },
});
