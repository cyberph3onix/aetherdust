/**
 * midnight-js providers backed by a DApp-connector wallet (Lace) and AetherDust:
 *   walletProvider.balanceTx  → wallet balances + signs + seals WITHOUT paying fees (`payFees: false`)
 *   midnightProvider.submitTx → AetherDust sponsors the DUST, submits, and returns the identifier midnight-js should watch
 * The user's keys never leave the wallet; AetherDust only ever sees the sealed transaction bytes.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import type { AetherDustClient } from './client.js';
import { AetherDustError } from './errors.js';
import { fromHex, toHex } from './hex.js';

/** The subset of the DApp connector's `ConnectedAPI` (v4) that sponsorship needs. Lace's connected API satisfies it. */
export interface SponsorableWallet {
  getShieldedAddresses(): Promise<{ shieldedCoinPublicKey: string; shieldedEncryptionPublicKey: string; shieldedAddress?: string }>;
  balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;
}

export interface SponsoredProviderOptions {
  client: AetherDustClient;
  wallet: SponsorableWallet;
  /**
   * Idempotency key for a sealed transaction. Default: `${prefix}:${tx.transactionHash()}`, so retrying the same
   * sealed transaction replays the same request instead of creating a new one.
   */
  requestIdFor?: (tx: ledger.FinalizedTransaction) => string;
  requestIdPrefix?: string;
  /** 'confirmed' (default) blocks `submitTx` until the sponsored tx is confirmed; 'approved' returns after queueing. */
  until?: 'confirmed' | 'approved';
  /**
   * How transaction bytes are encoded on the connector wire. The connector API types them as `string`; wallets use
   * hex. Override if your wallet differs.
   */
  encode?: (bytes: Uint8Array) => string;
  decode?: (s: string) => Uint8Array;
  /** Called with every request outcome (approved/confirmed) — handy for UI status. */
  onRequest?: (r: import('./types.js').SponsorshipRequest) => void;
}

export type SponsoredProviders = WalletProvider & MidnightProvider & {
  /** The connector wallet's keys, resolved once at creation. */
  keys: { coinPublicKey: string; encryptionPublicKey: string };
};

const wrapWallet = async <T>(what: string, p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    throw new AetherDustError('WALLET_ERROR', `wallet ${what} failed: ${(e as Error)?.message ?? e}`, { cause: e });
  }
};

/** Resolves the wallet's public keys once (midnight-js reads them synchronously), then returns the providers. */
export const createSponsoredMidnightProvider = async (o: SponsoredProviderOptions): Promise<SponsoredProviders> => {
  const encode = o.encode ?? toHex;
  const decode = o.decode ?? fromHex;
  const prefix = o.requestIdPrefix ?? 'aetherdust';
  const requestIdFor = o.requestIdFor ?? ((tx: ledger.FinalizedTransaction) => `${prefix}:${tx.transactionHash()}`);
  const addr = await wrapWallet('getShieldedAddresses', o.wallet.getShieldedAddresses());
  const keys = { coinPublicKey: addr.shieldedCoinPublicKey, encryptionPublicKey: addr.shieldedEncryptionPublicKey };
  return {
    keys,
    getCoinPublicKey: () => keys.coinPublicKey,
    getEncryptionPublicKey: () => keys.encryptionPublicKey,
    async balanceTx(tx) {
      // The connector has no TTL parameter; the wallet applies its own (Lace/midnight-js default to 1 h).
      const { tx: sealed } = await wrapWallet('balanceUnsealedTransaction(payFees:false)', o.wallet.balanceUnsealedTransaction(encode(tx.serialize()), { payFees: false }));
      try { return ledger.Transaction.deserialize('signature', 'proof', 'binding', decode(sealed)); } catch (e) {
        throw new AetherDustError('WALLET_ERROR', `wallet returned a transaction that is not a sealed ledger-v8 transaction: ${(e as Error)?.message ?? e}`, { cause: e });
      }
    },
    async submitTx(tx) {
      const r = await o.client.sponsor({ requestId: requestIdFor(tx), transaction: tx, until: o.until ?? 'confirmed' });
      o.onRequest?.(r);
      // confirmed → the sponsored tx's identifier; approved → the user's own identifier, which survives the merge (Phase 0 V2)
      const id = r.transaction_id ?? r.user_transaction_identifiers[0];
      if (!id) throw new AetherDustError('INTERNAL', 'sponsorship request carries no transaction identifier', { request: r });
      return id;
    },
  };
};

/**
 * PRD §32 one-liner for DApps that already hold a sealed, fee-unpaid transaction (e.g. from `balanceTx` above).
 * Equivalent to `client.sponsor({ requestId, userId, transaction })`.
 */
export const sponsor = (client: AetherDustClient, p: { requestId: string; userId?: string; transaction: Parameters<AetherDustClient['sponsor']>[0]['transaction']; until?: 'confirmed' | 'approved' }) =>
  client.sponsor(p);
