import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaymentRequirements } from './api';
import { createPendingPaymentProof, matchesPendingPaymentProof } from './x402-payment';

const baseRequirements: PaymentRequirements = {
    version: '1',
    network: 'stacks-testnet',
    token: 'USDCX',
    amount: '1000000',
    receiver: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
    description: 'Alpha Cards',
    resource: '/v1/alpha/cards?source=both&window=24h&n=20',
    scheme: 'sip10-transfer',
    asset_contract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx',
};

test('matchesPendingPaymentProof reuses only the same payment challenge', () => {
    const pending = createPendingPaymentProof('0xpaytx', baseRequirements);

    assert.equal(matchesPendingPaymentProof(pending, baseRequirements), true);
    assert.equal(
        matchesPendingPaymentProof(pending, { ...baseRequirements, amount: '250000' }),
        true
    );
    assert.equal(
        matchesPendingPaymentProof(pending, { ...baseRequirements, amount: '1500000' }),
        false
    );
    assert.equal(
        matchesPendingPaymentProof(
            pending,
            { ...baseRequirements, resource: '/v1/alpha/cards?source=reddit&window=24h&n=20' }
        ),
        false
    );
});
