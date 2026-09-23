/**
 * Witness implementations: the private half of the contract. Everything here stays on the caller's machine — the
 * circuit consumes these values, and only what the contract explicitly `disclose()`s ever reaches the chain.
 */
import { CompactTypeBytes, CompactTypeVector, persistentHash, type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from './managed/allowlist/contract/index.js';

const BYTES_32 = new CompactTypeBytes(32);
export const TREE_DEPTH = 10;

/** What a participant keeps to themselves: the secret whose commitment sits in the allowlist. */
export type AllowlistPrivateState = {
  /** 32 bytes. A member's secret, or the operator's when extending the list. */
  readonly secret: Uint8Array;
};

export const createPrivateState = (secret: Uint8Array): AllowlistPrivateState => {
  if (secret.length !== 32) throw new Error(`secret must be 32 bytes, got ${secret.length}`);
  return { secret };
};

/** `persistentHash(secret)` — the public commitment for a secret, exactly as the circuit computes it. */
export const commitmentFor = (secret: Uint8Array): Uint8Array => persistentHash(BYTES_32, secret);

/** The domain the nullifier is separated by. Must match `pad(32, ...)` in the circuit, byte for byte. */
export const NULLIFIER_DOMAIN = 'allowlist:access:v1';
const domainBytes = (() => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(NULLIFIER_DOMAIN));
  return b;
})();

/**
 * `persistentHash([secret, domain])` — the nullifier the circuit publishes when this secret claims.
 * Computing it locally lets a member see "you have already entered" without sending a transaction; it is the same
 * value either way, which `allowlist.test.ts` checks against a real circuit run.
 */
export const nullifierFor = (secret: Uint8Array): Uint8Array =>
  persistentHash(new CompactTypeVector(2, BYTES_32), [secret, domainBytes] as any);

export interface MerklePathWitness {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
}

/** A well-formed placeholder for calls that do not prove membership (`addMember` never reads the path). */
const emptyPath = (): MerklePathWitness => ({
  leaf: new Uint8Array(32),
  path: Array.from({ length: TREE_DEPTH }, () => ({ sibling: { field: 0n }, goes_left: false })),
});

export const witnesses = {
  localSecret: ({ privateState }: WitnessContext<Ledger, AllowlistPrivateState>): [AllowlistPrivateState, Uint8Array] =>
    [privateState, privateState.secret],

  /**
   * The Merkle path for this caller's commitment, read out of the *public* tree. Building it leaks nothing — the
   * tree is on the ledger. What stays private is *which* leaf is ours; the circuit re-derives our commitment from
   * our secret and refuses a path that authenticates any other leaf.
   */
  memberPath: (
    { ledger, privateState }: WitnessContext<Ledger, AllowlistPrivateState>,
  ): [AllowlistPrivateState, MerklePathWitness] => {
    const found = ledger.members.findPathForLeaf(commitmentFor(privateState.secret));
    return [privateState, (found as unknown as MerklePathWitness | undefined) ?? emptyPath()];
  },
};
