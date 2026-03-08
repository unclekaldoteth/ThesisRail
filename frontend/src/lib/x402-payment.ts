import type { PaymentRequirements } from './api';

export interface PendingPaymentProof {
    txId: string;
    amount: string;
    receiver: string;
    resource: string;
}

function parsePositiveAmount(value: string): number | null {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

export function createPendingPaymentProof(
    txId: string,
    requirements: PaymentRequirements
): PendingPaymentProof {
    return {
        txId,
        amount: requirements.amount,
        receiver: requirements.receiver,
        resource: requirements.resource,
    };
}

export function matchesPendingPaymentProof(
    pendingPayment: PendingPaymentProof | null | undefined,
    requirements: PaymentRequirements | null | undefined
): pendingPayment is PendingPaymentProof {
    if (!pendingPayment || !requirements) return false;
    const pendingAmount = parsePositiveAmount(pendingPayment.amount);
    const requiredAmount = parsePositiveAmount(requirements.amount);
    if (pendingAmount === null || requiredAmount === null) return false;

    return pendingAmount >= requiredAmount
        && pendingPayment.receiver === requirements.receiver
        && pendingPayment.resource === requirements.resource;
}
