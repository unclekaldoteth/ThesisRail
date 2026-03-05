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
      storage/       File-backed persistent store for campaigns, cards, and events
      onchain/       Stacks tx API client + reconciliation worker
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
    P --> R[Owner executes approve-task]
    R --> S[STX payout sent on-chain]

    S --> T{All tasks done?}
    T -- Yes --> U[Close campaign, withdraw remaining]
    T -- No --> M
```

---

## UI/UX Flow

```mermaid
flowchart TD
    A["Open App"] --> B["Connect Wallet"]

    B --> C["Alpha Dashboard"]
    C --> C1["Set Filters: Source / Window / Count"]
    C --> C2["Fetch Alpha"]
    C2 -->|402 Payment Required| C3["Payment Modal"]
    C3 --> C4["STX Transfer (x402)"]
    C4 --> C2
    C2 -->|Loaded| C5["Alpha Cards Grid"]

    C5 -->|Thesis Detail| D["Alpha Detail"]
    D -->|Convert to Campaign| E["Campaign Builder"]

    C5 -->|Convert to Campaign| E

    E -->|No id| E1["Campaign List"]
    E1 -->|Select Campaign| E
    E -->|Draft| E2["Edit Tasks"]
    E2 -->|Save Work Order| E2
    E -->|Deploy Escrow| F["Onchain Deploy Flow"]

    F --> F1["create-campaign"]
    F1 --> F2["fund-campaign"]
    F2 --> F3["add-task (each)"]
    F3 --> F4["Backend Sync: fundCampaign"]
    F4 -->|Success| G["Go to Task Board"]

    G --> H["Task Board"]
    H --> H1["Role Switcher: Owner / Executor"]

    H1 -->|Executor| I["Executor View"]
    I --> I1["Claim Task"]
    I1 --> I2["Submit Proof"]
    I2 --> H

    H1 -->|Owner| J["Owner View"]
    J --> J1["Approve & Pay"]
    J --> J2["Close Campaign"]
    J2 --> J3["Withdraw Remaining"]
    J --> J4["Sync Onchain Timeline"]
    J1 --> H
    J3 --> H
    J4 --> H

    I1 -.-> K["Guard: Owner wallet cannot claim"]
    I2 -.-> L["Guard: Only executor can submit"]
    J1 -.-> M["Guard: Only owner can approve"]
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
    }
```

### Public Functions

| Function | Access | Description |
|----------|--------|-------------|
| `create-campaign` | Any | Creates a campaign with `(owner, token?, metadata-hash)` |
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
| Frontend | Next.js 16, TypeScript, Hiro Wallet SDK |
| Backend | Node.js, Express, TypeScript |
| Smart Contract | Clarity 4, Stacks blockchain (Epoch 3.4) |
| Payment Protocol | x402 (HTTP 402 pay-per-request) |
| Data Sources | Reddit API, YouTube Data API v3 |
| Contract Tooling | Clarinet, Vitest |

---

## License

MIT
