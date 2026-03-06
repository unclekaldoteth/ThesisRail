import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../index';
import { resetStorageForTests } from '../storage/store';

const USDCX_CONTRACT_ID = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx';
const PAYMENT_RECEIVER = 'ST1RECEIVER1111111111111111111111111111111';
const PAYMENT_PAYER = 'ST1PAYER11111111111111111111111111111111111';

function paymentTxPayload(): Record<string, unknown> {
    return {
        tx_id: '0xpaytx',
        tx_status: 'success',
        tx_type: 'contract_call',
        sender_address: PAYMENT_PAYER,
        contract_call: {
            contract_id: USDCX_CONTRACT_ID,
            function_name: 'transfer',
            function_args: [
                { repr: 'u1000000' },
                { repr: `'${PAYMENT_PAYER}` },
                { repr: `'${PAYMENT_RECEIVER}` },
                { repr: 'none' },
            ],
        },
    };
}

test('x402 enforces caller binding and one-time payment proof usage', async (t) => {
    process.env.STORAGE_FILE = '/tmp/thesisrail-x402-security-store.json';
    process.env.STACKS_NETWORK = 'testnet';
    process.env.USDCX_CONTRACT_ID = USDCX_CONTRACT_ID;
    process.env.PAYMENT_RECEIVER_ADDRESS = PAYMENT_RECEIVER;
    process.env.ALPHA_CARDS_PRICE_USDCX = '1000000';
    process.env.ALPHA_CARDS_PRICE_CACHED_USDCX = '250000';
    process.env.RECONCILER_ENABLED = 'false';

    resetStorageForTests();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;

        if (url.includes('/extended/v1/tx/')) {
            const txId = url.split('/extended/v1/tx/')[1].replace(/^0x/, '').toLowerCase();
            if (txId === 'paytx') {
                return new Response(JSON.stringify(paymentTxPayload()), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }

        return originalFetch(input, init);
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const endpoint = `${baseUrl}/v1/alpha/cards?source=both&window=24h&n=5`;
    const proofHeader = JSON.stringify({ txId: 'paytx' });

    const challengeRes = await fetch(endpoint);
    assert.equal(challengeRes.status, 402);

    const missingCallerRes = await fetch(endpoint, {
        headers: { 'X-Payment': proofHeader },
    });
    assert.equal(missingCallerRes.status, 401);

    const wrongCallerRes = await fetch(endpoint, {
        headers: {
            'X-Payment': proofHeader,
            'X-Caller-Address': 'ST1WRONGCALLER1111111111111111111111111111',
        },
    });
    assert.equal(wrongCallerRes.status, 402);

    const paidRes = await fetch(endpoint, {
        headers: {
            'X-Payment': proofHeader,
            'X-Caller-Address': PAYMENT_PAYER,
        },
    });
    assert.equal(paidRes.status, 200);

    const replayRes = await fetch(endpoint, {
        headers: {
            'X-Payment': proofHeader,
            'X-Caller-Address': PAYMENT_PAYER,
        },
    });
    assert.equal(replayRes.status, 402);
});
