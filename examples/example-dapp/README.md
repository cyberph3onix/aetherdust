# Example DApp — counter with Lace + AetherDust

The user's wallet (Lace) signs a `counter.increment` **with fees unpaid** (`payFees: false`); AetherDust's sponsor pays
the DUST. A wallet holding **0 NIGHT / 0 DUST** can use the DApp. The whole integration is `createSponsoredMidnightProvider`
in [`src/main.ts`](src/main.ts) — the rest is ordinary midnight-js wiring.

```ts
const client = createAetherDustClient({ baseUrl, apiKey, userId });
const sponsored = await createSponsoredMidnightProvider({ client, wallet: connectedLaceApi });
const providers = { ...otherProviders, walletProvider: sponsored, midnightProvider: sponsored };
const counter = await findDeployedContract(providers, { compiledContract, privateStateId, initialPrivateState, contractAddress });
await counter.callTx.increment(); // proves → Lace balances+signs (no fee) → AetherDust sponsors → confirmed
```

## Runbook (preprod, human in the loop — plan §22 Phase 3 / V7)

You need: a running AetherDust with a funded, DUST-registered sponsor on `preprod` (`docker compose --profile testnet up -d`,
see the root README), and Lace installed in the browser with an **unfunded** wallet on `preprod`.

1. **Deploy the counter** (once; paid by the sponsor wallet, self-paying). The script needs the proof server from the
   host, which the `testnet` profile keeps private — publish it (the DApp needs it later too):
   ```bash
   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --profile testnet up -d proof-server
   ```
   On a public testnet the wallet sync takes ~2 h the first time — run the deploy in the background:
   ```bash
   cd examples/example-dapp
   set -a && . ../../deploy/.env && set +a
   nohup pnpm deploy-counter > deploy.log 2>&1 &
   tail -f deploy.log          # ends with {"network":"preprod","contractAddress":"…"}
   ```
2. **Register the DApp with AetherDust** (creates the application, a policy that sponsors only `increment` on that
   address, and one API key; uses the admin token from `deploy/.env`):
   ```bash
   cd ../.. && scripts/register-dapp.sh <contractAddress>
   ```
   It prints the API key once — copy it.
3. **Run the DApp**: `cd examples/example-dapp && pnpm dev` → http://localhost:5173. In Brave, turn Shields **off** for
   the page (lion icon). Fill in network `preprod`, API base URL `http://localhost:8080`, the API key, a user id, and the
   contract address (they're remembered in localStorage).
4. **Connect wallet** — Lace prompts; approve. The page shows the wallet's NIGHT/DUST (should be 0/0).
5. **Increment (sponsored)** — Lace prompts to sign. Watch the log:
   - `wallet honoured payFees:false — sealed tx carries no DustSpend` → **V7 passes**; then `AetherDust: confirmed … sponsor
     paid N DUST` and the counter value goes up. Done: AC1/AC2 exactly as an end user experiences them.
   - `wallet ADDED n DustSpend(s) despite payFees:false` → Lace paid the fee itself, i.e. this Lace build does not honour
     `payFees:false` yet. AetherDust correctly refuses (`INVALID_REQUEST`, rule R6). Record the Lace version; the Node-side
     path (`test/e2e` "SDK" test, same provider code over a wallet-SDK shim) is the fallback demo until Lace ships it.
   - `AetherDust refused: CONTRACT_NOT_ALLOWED / ENTRY_POINT_NOT_ALLOWED` → the policy from step 2 doesn't match the address.

The user's proof is generated on the proof server in the "Proof server" field (default `http://localhost:6300`, i.e. your
compose proof server published with `deploy/docker-compose.e2e.yml`). Leave it empty to use the one the wallet reports —
observed 2026-09-22: Lace reports `https://proof-server.preprod.midnight.network`, whose CORS preflight has no
`Access-Control-Allow-Origin`, so browsers cannot call it directly.

## Local chain instead of preprod

The same DApp works against `docker compose --profile local-midnight` with a wallet on `undeployed` (Lace does not offer
`undeployed`; that combination is what `test/e2e` automates with a Node-side wallet).
