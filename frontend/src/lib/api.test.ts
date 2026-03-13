import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cancelTask,
    claimTask,
    closeCampaign,
    fetchAlphaCards,
    getAlphaCard,
    getCampaign,
    getCampaignEvents,
    reconcileCampaign,
    submitProof,
} from './api';

function mockOkJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

test('claim/submit/cancel/close/reconcile calls include idempotency and tx payloads', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;
        captured.push({ url, init });

        if (url.endsWith('/events')) {
            return mockOkJson({ events: [] });
        }

        return mockOkJson({
            task: { id: 't1' },
            campaign: { id: 'c1' },
            events: [],
        });
    }) as typeof fetch;

    await claimTask('campaign-1', 'task-1', 'STTESTADDRESS0000000000000000000000000000', 'tx-claim-1');
    await submitProof(
        'campaign-1',
        'task-1',
        'STTESTADDRESS0000000000000000000000000000',
        'tx-submit-1',
        undefined,
        'proof'
    );
    await cancelTask('campaign-1', 'task-2', 'STTESTADDRESS0000000000000000000000000000', 'tx-cancel-1');
    await closeCampaign('campaign-1', 'STTESTADDRESS0000000000000000000000000000', 'tx-close-1');
    await reconcileCampaign('campaign-1', 'STTESTADDRESS0000000000000000000000000000');
    await getCampaignEvents('campaign-1');

    globalThis.fetch = originalFetch;

    assert.equal(captured.length, 6);

    const claimReq = captured[0];
    assert.ok(claimReq.url.endsWith('/v1/campaigns/campaign-1/tasks/task-1/claim'));
    assert.ok(claimReq.init?.headers);
    const claimHeaders = claimReq.init?.headers as Record<string, string>;
    assert.equal(claimHeaders['X-Caller-Address'], 'STTESTADDRESS0000000000000000000000000000');
    assert.ok(typeof claimHeaders['X-Idempotency-Key'] === 'string' && claimHeaders['X-Idempotency-Key'].length > 0);
    assert.equal(claimReq.init?.body, JSON.stringify({ tx_id: 'tx-claim-1' }));

    const submitReq = captured[1];
    assert.ok(submitReq.url.endsWith('/v1/campaigns/campaign-1/tasks/task-1/submit'));
    assert.equal(
        submitReq.init?.body,
        JSON.stringify({ proof_hash: undefined, proof_description: 'proof', tx_id: 'tx-submit-1' })
    );

    const cancelReq = captured[2];
    assert.ok(cancelReq.url.endsWith('/v1/campaigns/campaign-1/tasks/task-2/cancel'));
    assert.equal(cancelReq.init?.body, JSON.stringify({ tx_id: 'tx-cancel-1' }));

    const closeReq = captured[3];
    assert.ok(closeReq.url.endsWith('/v1/campaigns/campaign-1/close'));
    assert.equal(closeReq.init?.body, JSON.stringify({ tx_id: 'tx-close-1' }));

    const reconcileReq = captured[4];
    assert.ok(reconcileReq.url.endsWith('/v1/campaigns/campaign-1/reconcile'));
    assert.equal(reconcileReq.init?.body, JSON.stringify({ campaign_id: 'campaign-1' }));

    const eventsReq = captured[5];
    assert.ok(eventsReq.url.endsWith('/v1/campaigns/campaign-1/events'));
});

test('fetchAlphaCards sends caller header before and after payment proof submission', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    const paymentRequirements = {
        version: '1',
        network: 'stacks-testnet',
        token: 'USDCX',
        amount: '1000000',
        receiver: 'ST1RECEIVER1111111111111111111111111111111',
        description: 'Alpha Cards',
        resource: '/v1/alpha/cards?source=both&window=24h&n=20',
        scheme: 'sip10-transfer',
        asset_contract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx',
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;
        captured.push({ url, init });

        if (captured.length === 1) {
            return new Response(JSON.stringify({ paymentRequirements }), {
                status: 402,
                headers: { 'content-type': 'application/json' },
            });
        }

        return mockOkJson({ cards: [] });
    }) as typeof fetch;

    await fetchAlphaCards(
        { source: 'both', window: '24h', n: 20 },
        undefined,
        'STTESTADDRESS0000000000000000000000000000'
    );
    await fetchAlphaCards(
        { source: 'both', window: '24h', n: 20 },
        JSON.stringify({ txId: 'paytx' }),
        'STTESTADDRESS0000000000000000000000000000'
    );

    globalThis.fetch = originalFetch;

    assert.equal(captured.length, 2);

    const unpaidHeaders = (captured[0].init?.headers || {}) as Record<string, string>;
    assert.equal(unpaidHeaders['X-Caller-Address'], 'STTESTADDRESS0000000000000000000000000000');
    assert.equal(unpaidHeaders['X-Payment'], undefined);

    const paidHeaders = (captured[1].init?.headers || {}) as Record<string, string>;
    assert.equal(paidHeaders['X-Caller-Address'], 'STTESTADDRESS0000000000000000000000000000');
    assert.equal(paidHeaders['X-Payment'], JSON.stringify({ txId: 'paytx' }));
});

test('getAlphaCard and getCampaign only return null for 404 responses', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];

    try {
        globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            requests.push(url);

            if (url.endsWith('/v1/alpha/cards/missing')) {
                return new Response('missing', { status: 404 });
            }
            if (url.endsWith('/v1/alpha/cards/broken')) {
                return new Response(JSON.stringify({ error: 'alpha backend down' }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/campaigns/missing')) {
                return new Response('missing', { status: 404 });
            }
            if (url.endsWith('/v1/campaigns/broken')) {
                return new Response(JSON.stringify({ error: 'campaign backend down' }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }

            return mockOkJson({});
        }) as typeof fetch;

        await assert.doesNotReject(async () => {
            assert.equal(await getAlphaCard('missing'), null);
            assert.equal(await getCampaign('missing'), null);
        });

        await assert.rejects(() => getAlphaCard('broken'), /alpha backend down/);
        await assert.rejects(() => getCampaign('broken'), /campaign backend down/);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requests, [
        'http://localhost:3001/v1/alpha/cards/missing',
        'http://localhost:3001/v1/campaigns/missing',
        'http://localhost:3001/v1/alpha/cards/broken',
        'http://localhost:3001/v1/campaigns/broken',
    ]);
});
