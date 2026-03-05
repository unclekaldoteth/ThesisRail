# ThesisRail Escrow Contract

Clarity 4 smart contract deployed on Stacks Epoch 3.4. Implements a campaign-based escrow with milestone task payouts.

Deployed on testnet:
```
ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v6
```

---

## Contract Flow

```
create-campaign(owner, token?, metadata-hash) -> fund-campaign(campaign-id, token, amount) ->
add-task -> claim-task -> submit-proof -> approve-task(campaign-id, task-id, token) ->
close-campaign -> withdraw-remaining(campaign-id, token, amount)
```

Current create signature:
- `(create-campaign (owner principal) (token (optional principal)) (metadata-hash (buff 32)))`
- In current USDCx mode, `token` must be `some <token-contract-principal>`.
- Funding and payouts are executed through SIP-010 `transfer` calls.

---

## Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 100 | ERR_NOT_AUTHORIZED | Caller is not the campaign owner |
| 101 | ERR_CAMPAIGN_NOT_FOUND | Campaign ID does not exist |
| 102 | ERR_TASK_NOT_FOUND | Task ID does not exist |
| 103 | ERR_INSUFFICIENT_FUNDS | Not enough token balance in escrow |
| 104 | ERR_INVALID_STATUS | Wrong campaign or task status for this operation |
| 105 | ERR_ALREADY_CLAIMED | Task already claimed by another executor |
| 106 | ERR_SELF_CLAIM | Campaign owner cannot claim their own task |
| 107 | ERR_DEADLINE_PASSED | Task deadline has elapsed |
| 108 | ERR_NO_BALANCE | No remaining balance to withdraw |
| 109 | ERR_TRANSFER_FAILED | Escrow transfer failed |
| 110 | ERR_ACTIVE_ALLOCATIONS | Campaign still has allocated task payouts |
| 111 | ERR_INVALID_TOKEN | Token argument does not match campaign token |

---

## Status Codes

**Campaign status:**

| Value | Meaning |
|-------|---------|
| 0 | draft |
| 1 | funded |
| 2 | active |
| 3 | closed |

**Task status:**

| Value | Meaning |
|-------|---------|
| 0 | open |
| 1 | claimed |
| 2 | proof_submitted |
| 3 | approved |
| 4 | reserved (unused in current MVP) |

---

## Development

Requirements: [Clarinet](https://docs.hiro.so/clarinet/getting-started) >= 2.x

```bash
# Create local settings from templates (contains your own mnemonics)
cp settings/Simnet.example.toml settings/Simnet.toml
cp settings/Devnet.example.toml settings/Devnet.toml

# Check contract for errors
clarinet check

# Run unit tests
npm test

# Start local devnet
clarinet console
```

---

## Testing

Unit tests are in `tests/thesis-rail-escrow.test.ts` using the `@stacks/clarinet-sdk` and Vitest.

```bash
npm test
```

Test coverage includes:
- Campaign creation and funding
- Task allocation accounting (reserved payout balance)
- Task addition and claiming
- Deadline enforcement on task claim
- Proof submission and approval
- Payout verification
- Error conditions (unauthorized, invalid status, self-claim)

---

## Deploying to Testnet

1. Add your wallet mnemonic to `settings/Testnet.toml` under `[accounts.deployer]`
2. Fund the deployer address with testnet STX from https://explorer.hiro.so/sandbox/faucet?chain=testnet
3. Export your deployer key and run the deploy script:

```bash
STX_PRIVATE_KEY=your_private_key node deploy-testnet.js
```

The script directly broadcasts the contract to the Stacks testnet API and prints the TXID and contract address.

To deploy with a versioned onchain contract name while reusing `contracts/thesis-rail-escrow.clar`:

```bash
STX_PRIVATE_KEY=your_private_key CONTRACT_NAME=thesis-rail-escrow-v6 node deploy-testnet.js
```

---

## Network Configuration

| File | Network |
|------|---------|
| `settings/Devnet.toml` | Local Clarinet devnet |
| `settings/Simnet.toml` | Clarinet simnet (unit tests) |
| `settings/Testnet.toml` | Stacks testnet (gitignored) |
| `settings/Mainnet.toml` | Stacks mainnet (gitignored) |

`Testnet.toml` and `Mainnet.toml` are gitignored to prevent committing wallet mnemonics.
