;; ThesisRail Escrow Smart Contract
;; Campaign-based escrow with milestone payouts on Stacks
;; Clarity 4 / Epoch 3.4
;;
;; Flow: create-campaign(owner, token?, metadata-hash) -> fund-campaign(campaign-id, token, amount) ->
;;       add-task -> cancel-task (expired/open only) -> claim-task -> submit-proof -> approve-task(campaign-id, task-id, token) ->
;;       close-campaign -> withdraw-remaining(campaign-id, token, amount)

;; ============================================================
;; Constants & Error Codes
;; ============================================================

(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_NOT_AUTHORIZED (err u100))
(define-constant ERR_CAMPAIGN_NOT_FOUND (err u101))
(define-constant ERR_TASK_NOT_FOUND (err u102))
(define-constant ERR_INSUFFICIENT_FUNDS (err u103))
(define-constant ERR_INVALID_STATUS (err u104))
(define-constant ERR_ALREADY_CLAIMED (err u105))
(define-constant ERR_SELF_CLAIM (err u106))
(define-constant ERR_DEADLINE_PASSED (err u107))
(define-constant ERR_NO_BALANCE (err u108))
(define-constant ERR_TRANSFER_FAILED (err u109))
(define-constant ERR_ACTIVE_ALLOCATIONS (err u110))
(define-constant ERR_INVALID_TOKEN (err u111))
(define-constant ERR_INVALID_PAYOUT (err u112))
(define-constant ERR_INVALID_DEADLINE (err u113))
(define-constant ERR_TASK_NOT_CANCELABLE (err u114))

;; Campaign status: 0=draft, 1=funded, 2=active, 3=closed
;; Task status: 0=open, 1=claimed, 2=proof_submitted, 3=approved, 4=cancelled

;; Minimal SIP-010 trait surface required for settlement transfers.
(define-trait sip-010-ft-trait
  (
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))
  )
)

;; ============================================================
;; Data Variables
;; ============================================================

(define-data-var campaign-counter uint u0)
(define-data-var allowed-token (optional principal) none)

;; ============================================================
;; Data Maps
;; ============================================================

(define-map campaigns
  { campaign-id: uint }
  {
    owner: principal,
    token: (optional principal),
    total-funded: uint,
    remaining-balance: uint,
    allocated-balance: uint,
    status: uint,
    metadata-hash: (buff 32),
    task-count: uint,
    created-at: uint
  }
)

(define-map tasks
  { campaign-id: uint, task-id: uint }
  {
    payout: uint,
    deadline: uint,
    criteria-hash: (buff 32),
    status: uint,
    executor: (optional principal),
    proof-hash: (optional (buff 32))
  }
)

;; ============================================================
;; Read-Only Functions
;; ============================================================

(define-read-only (get-campaign (campaign-id uint))
  (map-get? campaigns { campaign-id: campaign-id })
)

(define-read-only (get-task (campaign-id uint) (task-id uint))
  (map-get? tasks { campaign-id: campaign-id, task-id: task-id })
)

(define-read-only (get-campaign-count)
  (var-get campaign-counter)
)

(define-read-only (get-allowed-token)
  (var-get allowed-token)
)

(define-read-only (get-campaign-balance (campaign-id uint))
  (match (map-get? campaigns { campaign-id: campaign-id })
    campaign (ok (get remaining-balance campaign))
    ERR_CAMPAIGN_NOT_FOUND
  )
)

;; ============================================================
;; Public Functions
;; ============================================================

(define-private (campaign-token-matches
  (campaign {
    owner: principal,
    token: (optional principal),
    total-funded: uint,
    remaining-balance: uint,
    allocated-balance: uint,
    status: uint,
    metadata-hash: (buff 32),
    task-count: uint,
    created-at: uint
  })
  (token <sip-010-ft-trait>)
)
  (is-eq (some (contract-of token)) (get token campaign))
)

(define-private (token-allowed (token (optional principal)))
  (is-eq token (var-get allowed-token))
)

(define-private (transfer-into-escrow (token <sip-010-ft-trait>) (amount uint))
  (contract-call? token transfer amount tx-sender current-contract none)
)

(define-private (transfer-from-escrow (token <sip-010-ft-trait>) (amount uint) (recipient principal))
  (contract-call? token transfer amount current-contract recipient none)
)

;; Create a new campaign
(define-public (create-campaign (owner principal) (token (optional principal)) (metadata-hash (buff 32)))
  (let
    (
      (new-id (+ (var-get campaign-counter) u1))
    )
    ;; Preserve owner authority model: creator must be the owner.
    (asserts! (is-eq tx-sender owner) ERR_NOT_AUTHORIZED)
    ;; ThesisRail USDCx mode: token must match configured allowed token.
    (asserts! (token-allowed token) ERR_INVALID_TOKEN)
    (map-set campaigns
      { campaign-id: new-id }
      {
        owner: owner,
        token: token,
        total-funded: u0,
        remaining-balance: u0,
        allocated-balance: u0,
        status: u0,
        metadata-hash: metadata-hash,
        task-count: u0,
        created-at: stacks-block-height
      }
    )
    (var-set campaign-counter new-id)
    (ok new-id)
  )
)

;; One-time token configuration hook for simnet/testing or pre-launch network setup.
;; Locked once the first campaign exists.
(define-public (set-allowed-token (token principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq (var-get campaign-counter) u0) ERR_INVALID_STATUS)
    (var-set allowed-token (some token))
    (ok true)
  )
)

;; Fund a campaign with SIP-010 token (USDCx in ThesisRail deployment).
(define-public (fund-campaign (campaign-id uint) (token <sip-010-ft-trait>) (amount uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
    )
    ;; Only owner can fund
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Token argument must match campaign token selection.
    (asserts! (campaign-token-matches campaign token) ERR_INVALID_TOKEN)
    ;; Must have positive amount
    (asserts! (> amount u0) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer token to escrow contract
    (try! (transfer-into-escrow token amount))
    ;; Update campaign
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign {
        total-funded: (+ (get total-funded campaign) amount),
        remaining-balance: (+ (get remaining-balance campaign) amount),
        status: u1
      })
    )
    (ok true)
  )
)

;; Add a task to a campaign
(define-public (add-task 
  (campaign-id uint) 
  (payout uint) 
  (deadline uint) 
  (criteria-hash (buff 32))
)
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (new-task-id (+ (get task-count campaign) u1))
      (available-balance (- (get remaining-balance campaign) (get allocated-balance campaign)))
    )
    ;; Only owner can add tasks
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Campaign must be funded
    (asserts! (>= (get status campaign) u1) ERR_INVALID_STATUS)
    ;; Payout must be positive
    (asserts! (> payout u0) ERR_INVALID_PAYOUT)
    ;; Deadline must be in the future
    (asserts! (> deadline stacks-block-height) ERR_INVALID_DEADLINE)
    ;; Payout must not exceed unallocated escrow balance
    (asserts! (<= payout available-balance) ERR_INSUFFICIENT_FUNDS)
    ;; Create task
    (map-set tasks
      { campaign-id: campaign-id, task-id: new-task-id }
      {
        payout: payout,
        deadline: deadline,
        criteria-hash: criteria-hash,
        status: u0,
        executor: none,
        proof-hash: none
      }
    )
    ;; Update campaign task count
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign {
        task-count: new-task-id,
        allocated-balance: (+ (get allocated-balance campaign) payout),
        status: u2
      })
    )
    (ok new-task-id)
  )
)

;; Cancel expired, unclaimed task and release its reserved payout allocation.
(define-public (cancel-task (campaign-id uint) (task-id uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (task (unwrap! (map-get? tasks { campaign-id: campaign-id, task-id: task-id }) ERR_TASK_NOT_FOUND))
      (current-height stacks-block-height)
    )
    ;; Only owner can cancel tasks
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Campaign must be active
    (asserts! (is-eq (get status campaign) u2) ERR_INVALID_STATUS)
    ;; Only open tasks can be canceled
    (asserts! (is-eq (get status task) u0) ERR_TASK_NOT_CANCELABLE)
    ;; Task can only be canceled after deadline passes
    (asserts! (> current-height (get deadline task)) ERR_TASK_NOT_CANCELABLE)
    ;; Mark task canceled
    (map-set tasks
      { campaign-id: campaign-id, task-id: task-id }
      (merge task {
        status: u4
      })
    )
    ;; Release reserved allocation
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign {
        allocated-balance: (- (get allocated-balance campaign) (get payout task))
      })
    )
    (ok true)
  )
)

;; Claim an open task (executor)
(define-public (claim-task (campaign-id uint) (task-id uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (task (unwrap! (map-get? tasks { campaign-id: campaign-id, task-id: task-id }) ERR_TASK_NOT_FOUND))
      (current-height stacks-block-height)
    )
    ;; Campaign must be active (tasks registered)
    (asserts! (is-eq (get status campaign) u2) ERR_INVALID_STATUS)
    ;; Task must be open
    (asserts! (is-eq (get status task) u0) ERR_ALREADY_CLAIMED)
    ;; Task deadline must not have passed
    (asserts! (<= current-height (get deadline task)) ERR_DEADLINE_PASSED)
    ;; Cannot claim own campaign tasks
    (asserts! (not (is-eq tx-sender (get owner campaign))) ERR_SELF_CLAIM)
    ;; Update task
    (map-set tasks
      { campaign-id: campaign-id, task-id: task-id }
      (merge task {
        status: u1,
        executor: (some tx-sender)
      })
    )
    (ok true)
  )
)

;; Submit proof for a claimed task (executor)
(define-public (submit-proof (campaign-id uint) (task-id uint) (proof-hash (buff 32)))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (task (unwrap! (map-get? tasks { campaign-id: campaign-id, task-id: task-id }) ERR_TASK_NOT_FOUND))
      (current-height stacks-block-height)
    )
    ;; Campaign must be active
    (asserts! (is-eq (get status campaign) u2) ERR_INVALID_STATUS)
    ;; Task must be claimed
    (asserts! (is-eq (get status task) u1) ERR_INVALID_STATUS)
    ;; Task deadline must not have passed
    (asserts! (<= current-height (get deadline task)) ERR_DEADLINE_PASSED)
    ;; Only executor can submit proof
    (asserts! (is-eq (some tx-sender) (get executor task)) ERR_NOT_AUTHORIZED)
    ;; Update task with proof
    (map-set tasks
      { campaign-id: campaign-id, task-id: task-id }
      (merge task {
        status: u2,
        proof-hash: (some proof-hash)
      })
    )
    (ok true)
  )
)

;; Approve task and trigger payout (owner)
(define-public (approve-task (campaign-id uint) (task-id uint) (token <sip-010-ft-trait>))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (task (unwrap! (map-get? tasks { campaign-id: campaign-id, task-id: task-id }) ERR_TASK_NOT_FOUND))
      (executor-addr (unwrap! (get executor task) ERR_NOT_AUTHORIZED))
    )
    ;; Only owner can approve
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Token argument must match campaign token selection.
    (asserts! (campaign-token-matches campaign token) ERR_INVALID_TOKEN)
    ;; Campaign must be active
    (asserts! (is-eq (get status campaign) u2) ERR_INVALID_STATUS)
    ;; Task must have proof submitted
    (asserts! (is-eq (get status task) u2) ERR_INVALID_STATUS)
    ;; Sufficient balance in escrow
    (asserts! (>= (get remaining-balance campaign) (get payout task)) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer payout from contract to executor
    (asserts! (try! (transfer-from-escrow token (get payout task) executor-addr)) ERR_TRANSFER_FAILED)
    ;; Update task status
    (map-set tasks
      { campaign-id: campaign-id, task-id: task-id }
      (merge task { status: u3 })
    )
    ;; Update campaign balance
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign {
        remaining-balance: (- (get remaining-balance campaign) (get payout task)),
        allocated-balance: (- (get allocated-balance campaign) (get payout task))
      })
    )
    (ok true)
  )
)

;; Close campaign (owner)
(define-public (close-campaign (campaign-id uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
    )
    ;; Only owner can close
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Cannot close while any task payouts remain allocated
    (asserts! (is-eq (get allocated-balance campaign) u0) ERR_ACTIVE_ALLOCATIONS)
    ;; Update status
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign { status: u3 })
    )
    (ok true)
  )
)

;; Withdraw remaining token funds (owner, campaign must be closed)
(define-public (withdraw-remaining (campaign-id uint) (token <sip-010-ft-trait>) (amount uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
    )
    ;; Only owner can withdraw
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Token argument must match campaign token selection.
    (asserts! (campaign-token-matches campaign token) ERR_INVALID_TOKEN)
    ;; Campaign must be closed
    (asserts! (is-eq (get status campaign) u3) ERR_INVALID_STATUS)
    ;; Must have sufficient balance
    (asserts! (> (get remaining-balance campaign) u0) ERR_NO_BALANCE)
    (asserts! (<= amount (get remaining-balance campaign)) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer remaining to owner
    (asserts! (try! (transfer-from-escrow token amount (get owner campaign))) ERR_TRANSFER_FAILED)
    ;; Update balance
    (map-set campaigns
      { campaign-id: campaign-id }
      (merge campaign {
        remaining-balance: (- (get remaining-balance campaign) amount)
      })
    )
    (ok true)
  )
)
