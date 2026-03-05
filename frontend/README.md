# ThesisRail Frontend

Next.js frontend for the ThesisRail platform. Displays alpha signals fetched from the backend via the x402 pay-per-request protocol, and provides an interface to manage content campaigns and tasks on the Stacks blockchain.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Alpha Dashboard — fetch and browse alpha cards |
| `/alpha/:id` | Alpha card detail — view full signal and convert to campaign |
| `/campaign` | Campaign list and detail |
| `/tasks` | Task management for contributors + campaign timeline/reconciliation |

`src/screens` contains the UI screen modules used by these routes.

---

## Alpha Signal Flow

```mermaid
flowchart LR
    A[User clicks Fetch Alpha] --> B{HTTP 402 returned?}
    B -- Yes --> C[Show x402 Payment Modal]
    C --> D[User approves USDCx transfer in Hiro Wallet]
    D --> E[Frontend retries request with payment proof]
    E --> F[Backend validates payment]
    F --> G[Alpha cards returned and rendered]
    B -- No --> G
    G --> H[User selects card]
    H --> I[Navigate to alpha/:id]
    I --> J[Convert to Campaign]
```

---

## Environment Variables

Create `.env.local` in the `frontend/` directory:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CONTRACT_ADDRESS=ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM
NEXT_PUBLIC_CONTRACT_NAME=thesis-rail-escrow-v6
NEXT_PUBLIC_NETWORK=testnet
NEXT_PUBLIC_STACKS_API_URL=https://api.testnet.hiro.so
NEXT_PUBLIC_USDCX_CONTRACT_ID=ST14W0V5M1A0NNRPVQ54E9G0Z4K72902R8Q2A5AS5.usdcx-token
```

---

## Development

```bash
npm install
npm run dev
```

The dev server runs on http://localhost:3000.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `next` | App framework |
| `@stacks/connect` | Hiro Wallet integration |
| `@stacks/transactions` | Contract calls and Clarity value serialization |
| `@stacks/network` | Stacks network configuration |

---

## Wallet Integration

The frontend uses the Hiro Wallet browser extension via `@stacks/connect`. The `ClientProviders` component wraps the app with the wallet context. Two wallet actions are used:

1. `openContractCall` to USDCx token — sends USDCx to pay for x402-gated API access
2. `openContractCall` to escrow contract — funds campaign and executes milestone lifecycle

Campaign mutation API calls also include deterministic `X-Idempotency-Key` headers so retries replay safely on the backend.
Task actions attach lifecycle `tx_id` values so backend timeline events can be reconciled against onchain state.
