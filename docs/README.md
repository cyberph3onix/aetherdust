# AetherDust documentation

| | |
|---|---|
| [Quickstart](quickstart.md) | mock → local `undeployed` → preprod, with what to expect at each step |
| [Integration guide](integration.md) | the DApp side: SDK, REST, error codes, idempotency, where the key lives |
| [Policy reference](policy.md) | every field, the rules in evaluation order, how budgets behave |
| [Runbooks](runbooks.md) | fund the wallet, register DUST, low balance, stuck requests, restarts and re-syncs, key rotation, upgrades |
| [Observability](observability.md) | metrics reference, alerts, log fields |
| [Threat model](threat-model.md) | assets, boundaries, attacks considered, residual risks, deployment checklist |
| [Upstream issue draft](upstream-issue-dust-wallet-zero-fee.md) | the `wallet-sdk-dust-wallet` zero-fee hang we work around, written up for the SDK's tracker |

Architecture and the phase history live in [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md); the product spec is
[`prd.md`](../prd.md); the original proof that DUST sponsorship works on Midnight is
[`spikes/sponsor-spike/SPIKE_REPORT.md`](../spikes/sponsor-spike/SPIKE_REPORT.md).

The API's own reference is generated from the code: `/docs` (Swagger UI) and `/openapi.json` on a running api.
