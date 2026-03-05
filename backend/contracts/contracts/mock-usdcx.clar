;; Mock USDCx token for Clarinet tests.
;; Implements the minimal SIP-010 transfer surface used by thesis-rail-escrow.

(define-constant ERR_NOT_TOKEN_OWNER (err u4))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR_NOT_TOKEN_OWNER)
    (ok true)
  )
)
