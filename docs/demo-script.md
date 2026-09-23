# Demo video script (~1 minute)

One take, no narration required — the on-screen text carries it. Record at 1440×900 or larger so the hashes are
legible. Everything below is real: no mock state, no edited output.

**Before you start**

- AetherDust running against preprod (`docker compose … --profile testnet up -d`), worker synced.
- The allowlist contract deployed, with at least two demo members admitted (`pnpm deploy-contract setup 3`).
- The DApp open, with the contract address and API key filled in under **Connection settings**.
- Lace on preprod holding **0 NIGHT and 0 DUST** — show this; it is the point.
- One demo member's secret ready to paste, and one secret that is *not* on the list.

---

| Time | On screen | What it shows |
|---|---|---|
| 0:00–0:08 | The DApp, top of page. Hover the wallet balances in Lace: 0 NIGHT, 0 DUST. | A wallet holding nothing. |
| 0:08–0:15 | Click **Connect wallet**, approve in Lace. The badge fills in; the first step lights up. | Real wallet connection on preprod. |
| 0:15–0:25 | Open **Connection settings**, paste a member secret into *Import a secret*. Close it. **Your side** now reads *On the list: yes*, *Already entered: not yet*. | The browser derives the commitment locally and finds it in the public tree. |
| 0:25–0:45 | Press **Prove membership and enter**. Let the status line run: proving → sponsor → confirmed. The stamp lands. | The whole gasless ZK flow, unedited. Proving takes ~10–20 s; do not cut it — the wait is the honest part. |
| 0:45–0:52 | Scroll to **The public record**: admissions went up by one, a new stamp appears marked *yours, and only you can tell*. | What the chain recorded: a nullifier, not an identity. |
| 0:52–0:58 | Press the button again → *This secret has already been used to enter.* Then paste the non-member secret → *This secret is not on the allowlist.* | One admission per member; strangers refused. |
| 0:58–1:05 | Scroll to **What the chain learns** — the two columns. | The privacy claim, stated where the evidence just happened. |

**Optional tail (if you have room):** the AetherDust dashboard at `:8090`, Requests page, open the audit trail
drawer for that admission — RECEIVED → RESERVED → SPONSORING → SUBMITTED → CONFIRMED, with the DUST the sponsor
paid. It shows the fee was real and somebody else paid it.

---

**Things to avoid**

- Don't speed up the proving step. A cut there reads as a hidden failure.
- Don't show the secret in full unless you are happy for it to be public — it is a demo secret, but treat it the
  way you want viewers to treat theirs.
- Don't narrate the architecture. The video's job is to show a wallet with nothing in it getting through a door
  without saying who it is.
