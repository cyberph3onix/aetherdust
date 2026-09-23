/**
 * Contract tests for Private Allowlist Access, run against the Compact circuit simulator — the same circuits the
 * chain verifies, with the same witnesses, so these exercise the real privacy logic rather than a model of it.
 *
 * What they establish:
 *   1. an operator can extend the allowlist, and only the operator can
 *   2. a member proves membership and is admitted, and the ledger never learns which member
 *   3. the same member cannot claim twice (the nullifier does its job)
 *   4. someone who is not on the list cannot claim
 *   5. a member cannot borrow another member's Merkle path (the leaf is bound to the caller's own secret)
 *   6. adding members later does not invalidate a proof against an older root (HistoricMerkleTree)
 *   7. what a claim publishes is exactly the Merkle root and the nullifier — never the path, commitment or secret
 */
import { createCircuitContext, createConstructorContext, sampleContractAddress, type CircuitContext } from '@midnight-ntwrk/compact-runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { Allowlist, commitmentFor, createPrivateState, nullifierFor, witnesses, type AllowlistPrivateState } from './index.js';

const secretOf = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const OPERATOR = secretOf(0xa1);
const ALICE = secretOf(0x01);
const BOB = secretOf(0x02);
const MALLORY = secretOf(0x99);
const COIN_KEY = '0'.repeat(64);

let address: string;
let publicState: any; // the shared ledger, as a block would leave it

/** One participant: their own secret and private state, over the ledger as they currently see it. */
class Participant {
  readonly contract: InstanceType<typeof Allowlist.Contract<AllowlistPrivateState>>;
  context: CircuitContext<AllowlistPrivateState>;

  constructor(secret: Uint8Array, state = publicState, overrides: Partial<typeof witnesses> = {}) {
    this.contract = new Allowlist.Contract<AllowlistPrivateState>({ ...witnesses, ...overrides } as typeof witnesses);
    this.context = createCircuitContext(address as any, COIN_KEY, state, createPrivateState(secret));
  }
  get ledger() { return Allowlist.ledger(this.context.currentQueryContext.state); }
  /** Publish this participant's result, as including their transaction in a block would. */
  publish() { publicState = this.context.currentQueryContext.state; return this; }

  addMember(commitment: Uint8Array) {
    this.context = this.contract.impureCircuits.addMember(this.context, commitment).context;
    return this;
  }
  /** The public transcript of the last call: every value it hands the chain. */
  transcript: unknown[] = [];
  claimAccess() {
    const r = this.contract.impureCircuits.claimAccess(this.context);
    this.context = r.context;
    this.transcript = r.proofData.publicTranscript;
    return this;
  }
}

beforeEach(() => {
  address = sampleContractAddress();
  const contract = new Allowlist.Contract<AllowlistPrivateState>(witnesses);
  // the operator fixes the allowlist's owner at deployment: a commitment to a secret only they hold
  publicState = contract.initialState(createConstructorContext(createPrivateState(OPERATOR), COIN_KEY), commitmentFor(OPERATOR)).currentContractState;
});

const operator = () => new Participant(OPERATOR);
const admitted = (...members: Uint8Array[]) => {
  const op = operator();
  for (const m of members) op.addMember(commitmentFor(m));
  return op.publish();
};

describe('the allowlist (public state)', () => {
  it('starts empty and holds commitments, never secrets', () => {
    const op = operator();
    expect(op.ledger.admissions).toBe(0n);
    expect(op.ledger.nullifiers.isEmpty()).toBe(true);
    expect(op.ledger.members.firstFree()).toBe(0n);

    op.addMember(commitmentFor(ALICE)).addMember(commitmentFor(BOB));

    expect(op.ledger.members.firstFree()).toBe(2n);
    expect(op.ledger.members.findPathForLeaf(commitmentFor(ALICE))).toBeDefined();
    expect(op.ledger.members.findPathForLeaf(ALICE)).toBeUndefined(); // the secret itself is not in the tree
  });

  it('refuses anyone but the operator', () => {
    const impostor = new Participant(MALLORY);
    expect(() => impostor.addMember(commitmentFor(MALLORY))).toThrow(/not the allowlist owner/);
    expect(impostor.ledger.members.firstFree()).toBe(0n);
  });
});

describe('claiming access', () => {
  beforeEach(() => { admitted(ALICE, BOB); });

  it('admits a member and records only a nullifier — nothing that identifies them', () => {
    const alice = new Participant(ALICE).claimAccess();

    expect(alice.ledger.admissions).toBe(1n);
    expect(alice.ledger.nullifiers.size()).toBe(1n);

    // everything an observer can read, and what it is not
    const [nullifier] = [...alice.ledger.nullifiers];
    expect(Buffer.from(nullifier!).equals(Buffer.from(ALICE))).toBe(false);            // not her secret
    expect(Buffer.from(nullifier!).equals(Buffer.from(commitmentFor(ALICE)))).toBe(false); // not her commitment
    expect(alice.ledger.members.findPathForLeaf(nullifier!)).toBeUndefined();          // not a leaf of the tree
    expect(alice.ledger.members.firstFree()).toBe(2n);                                  // the tree is untouched

    // the DApp derives the same nullifier locally, so it can say "already entered" without sending a transaction
    expect(Buffer.from(nullifier!).equals(Buffer.from(nullifierFor(ALICE)))).toBe(true);
    expect(Buffer.from(nullifierFor(BOB)).equals(Buffer.from(nullifier!))).toBe(false);
  });

  it('lets each member claim exactly once', () => {
    const alice = new Participant(ALICE).claimAccess();
    expect(() => alice.claimAccess()).toThrow(/already claimed/);
    expect(alice.ledger.admissions).toBe(1n);

    const bob = new Participant(BOB, alice.publish().ledger && publicState).claimAccess();
    expect(bob.ledger.admissions).toBe(2n);
    expect(bob.ledger.nullifiers.size()).toBe(2n);
  });

  it('refuses someone who is not on the list', () => {
    const mallory = new Participant(MALLORY);
    expect(() => mallory.claimAccess()).toThrow(/not on the allowlist|path is not for this member/);
    expect(mallory.ledger.admissions).toBe(0n);
  });

  it('refuses a member who supplies someone else’s Merkle path', () => {
    // Mallory is on the list, but tries to claim using Alice's path — spending Alice's entitlement, not her own
    admitted(ALICE, BOB, MALLORY);
    const mallory = new Participant(MALLORY, publicState, {
      memberPath: ({ ledger, privateState }: any) => [privateState, ledger.members.findPathForLeaf(commitmentFor(ALICE))],
    });
    expect(() => mallory.claimAccess()).toThrow(/path is not for this member/);
    expect(mallory.ledger.admissions).toBe(0n);
  });

  it('keeps an earlier proof valid after the list grows (historic roots)', () => {
    const rootWhenAliceJoined = new Participant(ALICE).ledger.members.root();

    admitted(ALICE, BOB, MALLORY);                       // the list changes underneath her
    const later = new Participant(ALICE);
    expect(later.ledger.members.root()).not.toEqual(rootWhenAliceJoined);

    later.claimAccess();                                  // still admitted
    expect(later.ledger.admissions).toBe(1n);
    expect(later.ledger.members.checkRoot(rootWhenAliceJoined)).toBe(true);
  });

  it('publishes only the Merkle root and the nullifier — never the path, the commitment or the secret', () => {
    admitted(ALICE, BOB, MALLORY);
    const alice = new Participant(ALICE);
    const path = alice.ledger.members.findPathForLeaf(commitmentFor(ALICE))!;
    const root = alice.ledger.members.root();
    alice.claimAccess();

    // every value the transaction pushes onto the public transcript, as the chain will see it
    const le = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse().toString('hex');
    const pushed = alice.transcript
      .flatMap((op: any) => (op?.push?.value?.tag === 'cell' ? op.push.value.content.value : []))
      .map((v: Uint8Array) => Buffer.from(v).toString('hex').padEnd(64, '0'));
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

    expect(new Set(pushed)).toEqual(new Set([le(root.field), hex(nullifierFor(ALICE))]));
    expect(pushed).not.toContain(hex(commitmentFor(ALICE)));   // which leaf is hers
    expect(pushed).not.toContain(hex(ALICE));                  // her secret
    for (const step of (path as any).path) expect(pushed).not.toContain(le(step.sibling.field)); // her position
  });
});
