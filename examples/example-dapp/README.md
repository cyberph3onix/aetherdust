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

1. **Deploy the counter** (once; paid by the sponsor wallet, self-paying). On a public testnet the wallet sync takes ~2 h
   the first time — run it in the background:
   ```bash
   cd examples/example-dapp
   set -a && . ../../deploy/.env && set +a
   nohup pnpm deploy-counter > deploy.log 2>&1 &
   tail -f deploy.log          # ends with {"network":"preprod","contractAddress":"…"}
   ```
2. **Create the DApp's application, key and policy** (admin API; `ADMIN` is `AETHERDUST_ADMIN_TOKEN` from `deploy/.env`):
   ```bash
   cd ../..
   ADMIN=$(grep '^AETHERDUST_ADMIN_TOKEN=' deploy/.env | cut -d= -f2); API=http://localhost:8080; ADDR=<contractAddress>
   APP=$(curl -s -X POST $API/v1/admin/applications -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"CounterDApp"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
   curl -s -X PUT $API/v1/admin/applications/$APP/policy -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d "{
     \"contracts\": {\"$ADDR\": [\"increment\"]},
     \"limits\": {\"period\":\"daily\",\"global_budget_dust\":\"50\",\"per_user_budget_dust\":\"5\",\"max_fee_per_tx_dust\":\"1\"},
     \"rate_limit\": {\"requests_per_minute_per_credential\":60,\"requests_per_minute_per_user\":10,\"requests_per_minute_per_ip\":120}}"
   curl -s -X POST $API/v1/admin/applications/$APP/api-keys -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"env":"live","label":"counter-dapp"}'
   ```
   The last call prints the `token` (`ad_live_…`) once — that's the DApp's API key.
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

Proving happens against the proof server the wallet reports in `getConfiguration().proverServerUri`; if your Lace build
reports none, set `localStorage.setItem('aetherdust.proofServer', 'http://localhost:6300')` in the console and point it at
your compose proof server (publish its port for this test only: `deploy/docker-compose.e2e.yml`).

## Local chain instead of preprod

The same DApp works against `docker compose --profile local-midnight` with a wallet on `undeployed` (Lace does not offer
`undeployed`; that combination is what `test/e2e` automates with a Node-side wallet).
