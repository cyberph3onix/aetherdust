import { z } from 'zod';

/** The `transaction` object a DApp sends. Real Midnight bytes are hex/base64 of `tx.serialize()`. */
export const TransactionEnvelopeSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('midnight-ledger-v8'),
    encoding: z.enum(['hex', 'base64']).default('hex'),
    bytes: z.string().min(1),
  }),
  /** Synthetic transaction accepted only when AETHERDUST_SPONSOR_ADAPTER=mock (tests, demos, DApp integration without a chain). */
  z.object({
    format: z.literal('mock'),
    calls: z.array(z.object({ address: z.string().regex(/^[0-9a-f]{64}$/i), entryPoint: z.string().min(1) })).min(0),
    /** unique id for the synthetic tx; defaults to random */
    id: z.string().min(1).optional(),
    ttlSeconds: z.number().int().positive().optional(),
    deploys: z.number().int().nonnegative().optional(),
    hasDustActions: z.boolean().optional(),
    byteLength: z.number().int().positive().optional(),
    /** failure injection for the mock adapter */
    fail: z.enum(['estimate', 'sponsor', 'submit', 'confirm', 'timeout', 'balance-low']).optional(),
    feeDust: z.string().optional(),
    actualFeeDust: z.string().optional(),
    confirmMs: z.number().int().nonnegative().optional(),
  }),
]);
export type TransactionEnvelope = z.infer<typeof TransactionEnvelopeSchema>;

export const MOCK_MAGIC = 'AETHERDUST-MOCK-TX:';

export const envelopeToBytes = (env: TransactionEnvelope): Uint8Array => {
  if (env.format === 'midnight-ledger-v8') {
    const buf = Buffer.from(env.bytes, env.encoding);
    if (buf.length === 0 || (env.encoding === 'hex' && !/^[0-9a-fA-F]*$/.test(env.bytes) || (env.encoding === 'hex' && env.bytes.length % 2 !== 0)))
      throw new Error(`transaction.bytes is not valid ${env.encoding}`);
    return new Uint8Array(buf);
  }
  return new Uint8Array(Buffer.from(MOCK_MAGIC + JSON.stringify(env), 'utf8'));
};
export const isMockBytes = (bytes: Uint8Array): boolean =>
  bytes.byteLength > MOCK_MAGIC.length && Buffer.from(bytes.subarray(0, MOCK_MAGIC.length)).toString('utf8') === MOCK_MAGIC;
export const parseMockBytes = (bytes: Uint8Array): Extract<TransactionEnvelope, { format: 'mock' }> =>
  TransactionEnvelopeSchema.parse(JSON.parse(Buffer.from(bytes.subarray(MOCK_MAGIC.length)).toString('utf8'))) as Extract<TransactionEnvelope, { format: 'mock' }>;
