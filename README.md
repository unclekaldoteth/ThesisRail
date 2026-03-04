# ThesisRail

ThesisRail is a decentralized content campaign platform built on the Stacks blockchain. It aggregates alpha signals from social media (Reddit, YouTube), converts them into structured content campaigns, and uses a Clarity smart contract escrow to enforce milestone-based payouts to content contributors.

Built for DoraHacks hackathon — combining x402 pay-per-request APIs, Stacks on-chain escrow, and AI-scored signal ingestion.

---

## Architecture Overview

```
+-------------------+         +----------------------+         +---------------------------+
|   Next.js         |         |   Express API         |         |   Stacks Blockchain        |
|   Frontend        | <-----> |   Backend (Node.js)   | <-----> |   thesis-rail-escrow.clar  |
|   (port 3000)     |  HTTP   |   (port 3001)         |  RPC    |   (Clarity 4 / Epoch 3.4)  |
+-------------------+         +----------------------+         +---------------------------+
         |                            |
         |                    +-------+-------+
         |                    |               |
         v                    v               v
   Hiro Wallet           Reddit API     YouTube Data API
   (Stacks)              ingestion      ingestion
```

---

## Project Structure

```
ThesisRail/
  frontend/          Next.js frontend: alpha dashboard, campaign viewer, task management
    src/screens/     Screen modules (alpha, campaign, tasks)
  backend/
    src/             Express API server
      api/           Route handlers (alpha, campaigns)
      ingestion/     Reddit and YouTube data fetchers
      scoring/       Alpha signal scorer (produces alpha cards)
      storage/       In-memory store for campaigns and cards
      x402/          Payment middleware (HTTP 402 enforcement)
    contracts/       Clarity smart contract + Clarinet config
      contracts/     thesis-rail-escrow.clar
      tests/         Clarinet unit tests
      settings/      Network configs (Devnet, Testnet, Mainnet)
      deployments/   Generated deployment plans
```

---

## System Flow

```mermaid
flowchart TD
    A[User opens frontend] --> B{Wallet connected?}
    B -- No --> C[Connect Hiro Wallet]
    B -- Yes --> D[Fetch Alpha Signals]
    C --> D

    D --> E[x402 payment required]
    E --> F[User pays STX via wallet]
    F --> G[API returns scored alpha cards]

    G --> H[User selects alpha card]
    H --> I[Convert to Campaign]
    I --> J[Campaign + 3 tasks created]
    J --> K[Fund campaign on-chain via escrow contract]
    K --> L[Campaign status: funded]

    L --> M[Contributor claims task]
    M --> N[Work is completed]
    N --> O[Submit proof hash]
    O --> P[Campaign owner reviews]
    P --> Q{Approved?}
    Q -- Yes --> R[STX payout sent on-chain]
    Q -- No --> S[Task rejected, returned to open]

    R --> T{All tasks done?}
    T -- Yes --> U[Close campaign, withdraw remaining]
    T -- No --> M
```

---

## Smart Contract: thesis-rail-escrow-v5

Deployed on Stacks testnet:
```
ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v5
```

### Contract State Machine

```mermaid
stateDiagram-v2
    [*] --> draft : create-campaign
    draft --> funded : fund-campaign (STX locked in escrow)
    funded --> active : (first task claimed)
    active --> closed : close-campaign

    state "Task Lifecycle" as TL {
        [*] --> open : add-task
        open --> claimed : claim-task
        claimed --> proof_submitted : submit-proof
        proof_submitted --> approved : approve-task (payout)
        proof_submitted --> rejected : reject-task
        rejected --> open : (reset to open)
    }
```

### Public Functions

| Function | Access | Description |
|----------|--------|-------------|
| `create-campaign` | Any | Creates a new campaign with metadata hash |
| `fund-campaign` | Campaign owner | Locks STX into the escrow |
| `add-task` | Campaign owner | Adds a task with payout and deadline |
| `claim-task` | Any (not owner) | Claims an open task to work on |
| `submit-proof` | Executor | Submits proof hash for review |
| `approve-task` | Campaign owner | Approves proof, releases payout |
| `close-campaign` | Campaign owner | Closes campaign |
| `withdraw-remaining` | Campaign owner | Withdraws leftover balance |

---

## Getting Started

See individual README files in [`frontend/README.md`](./frontend/README.md) and [`backend/README.md`](./backend/README.md).

### Quick Start (Full Stack)

```bash
# 1. Start backend
cd backend && npm install && npm run dev

# 2. Start frontend
cd frontend && npm install && npm run dev
```

Frontend: http://localhost:3000
Backend API: http://localhost:3001

---

## Deployed Contract

| Network | Address |
|---------|---------|
| Testnet | `ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v5` |
| Explorer | https://explorer.hiro.so/address/ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v5?chain=testnet |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, TypeScript, Hiro Wallet SDK |
| Backend | Node.js, Express, TypeScript |
| Smart Contract | Clarity 4, Stacks blockchain (Epoch 3.4) |
| Payment Protocol | x402 (HTTP 402 pay-per-request) |
| Data Sources | Reddit API, YouTube Data API v3 |
| Contract Tooling | Clarinet, Vitest |

---

## License

MIT
