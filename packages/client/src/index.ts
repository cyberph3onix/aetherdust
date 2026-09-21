export { createAetherDustClient, toEnvelope, type AetherDustClient, type AetherDustClientOptions, type SponsorParams, type TransactionInput } from './client.js';
export { AetherDustError, findAetherDustError, isAetherDustError } from './errors.js';
export { createSponsoredMidnightProvider, sponsor, type SponsorableWallet, type SponsoredProviderOptions, type SponsoredProviders } from './provider.js';
export { fromHex, toHex } from './hex.js';
export type { ApiError, ErrorCode, InternalStatus, PublicStatus, SponsorshipRequest, TransactionEnvelope } from './types.js';
export { TERMINAL_STATUSES } from './types.js';
