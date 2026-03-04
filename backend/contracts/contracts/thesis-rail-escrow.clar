;; ThesisRail Escrow Smart Contract
;; Campaign-based escrow with milestone payouts on Stacks
;; Clarity 4 / Epoch 3.4
;;
;; Flow: create-campaign(owner, token?, metadata-hash) -> fund-campaign -> add-task -> claim-task ->
;;       submit-proof -> approve-task (payout) -> close-campaign -> withdraw-remaining

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

;; Campaign status: 0=draft, 1=funded, 2=active, 3=closed
;; Task status: 0=open, 1=claimed, 2=proof_submitted, 3=approved, 4=rejected

;; ============================================================
;; Data Variables
;; ============================================================

(define-data-var campaign-counter uint u0)

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

(define-read-only (get-campaign-balance (campaign-id uint))
  (match (map-get? campaigns { campaign-id: campaign-id })
    campaign (ok (get remaining-balance campaign))
    ERR_CAMPAIGN_NOT_FOUND
  )
)

;; ============================================================
;; Public Functions
;; ============================================================

;; Clarity 4 transfer helper: execute STX transfer from the contract principal.
(define-private (transfer-from-escrow (amount uint) (recipient principal))
  (as-contract?
    (
      (with-stx amount)
    )
    (match (stx-transfer? amount tx-sender recipient)
      ok-value true
      err-value false
    )
  )
)

;; Create a new campaign
(define-public (create-campaign (owner principal) (token (optional principal)) (metadata-hash (buff 32)))
  (let
    (
      (new-id (+ (var-get campaign-counter) u1))
    )
    ;; Preserve owner authority model: creator must be the owner.
    (asserts! (is-eq tx-sender owner) ERR_NOT_AUTHORIZED)
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

;; Fund a campaign with STX
(define-public (fund-campaign (campaign-id uint) (amount uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
    )
    ;; Only owner can fund
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Must have positive amount
    (asserts! (> amount u0) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer STX to contract
    (try! (stx-transfer? amount tx-sender current-contract))
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
(define-public (approve-task (campaign-id uint) (task-id uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
      (task (unwrap! (map-get? tasks { campaign-id: campaign-id, task-id: task-id }) ERR_TASK_NOT_FOUND))
      (executor-addr (unwrap! (get executor task) ERR_NOT_AUTHORIZED))
    )
    ;; Only owner can approve
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Campaign must be active
    (asserts! (is-eq (get status campaign) u2) ERR_INVALID_STATUS)
    ;; Task must have proof submitted
    (asserts! (is-eq (get status task) u2) ERR_INVALID_STATUS)
    ;; Sufficient balance in escrow
    (asserts! (>= (get remaining-balance campaign) (get payout task)) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer payout from contract to executor
    (asserts! (try! (transfer-from-escrow (get payout task) executor-addr)) ERR_TRANSFER_FAILED)
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

;; Withdraw remaining funds (owner, campaign must be closed)
(define-public (withdraw-remaining (campaign-id uint) (amount uint))
  (let
    (
      (campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) ERR_CAMPAIGN_NOT_FOUND))
    )
    ;; Only owner can withdraw
    (asserts! (is-eq tx-sender (get owner campaign)) ERR_NOT_AUTHORIZED)
    ;; Campaign must be closed
    (asserts! (is-eq (get status campaign) u3) ERR_INVALID_STATUS)
    ;; Must have sufficient balance
    (asserts! (> (get remaining-balance campaign) u0) ERR_NO_BALANCE)
    (asserts! (<= amount (get remaining-balance campaign)) ERR_INSUFFICIENT_FUNDS)
    ;; Transfer remaining to owner
    (asserts! (try! (transfer-from-escrow amount (get owner campaign))) ERR_TRANSFER_FAILED)
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
