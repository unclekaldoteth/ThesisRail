import assert from 'node:assert/strict';
import test from 'node:test';
import {
    claimTask,
    closeCampaign,
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

test('claim/submit/close/reconcile calls include idempotency and tx payloads', async () => {
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
        undefined,
        'proof',
        'tx-submit-1'
    );
    await closeCampaign('campaign-1', 'STTESTADDRESS0000000000000000000000000000', 'tx-close-1');
    await reconcileCampaign('campaign-1', 'STTESTADDRESS0000000000000000000000000000');
    await getCampaignEvents('campaign-1');

    globalThis.fetch = originalFetch;

    assert.equal(captured.length, 5);

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

    const closeReq = captured[2];
    assert.ok(closeReq.url.endsWith('/v1/campaigns/campaign-1/close'));
    assert.equal(closeReq.init?.body, JSON.stringify({ tx_id: 'tx-close-1' }));

    const reconcileReq = captured[3];
    assert.ok(reconcileReq.url.endsWith('/v1/campaigns/campaign-1/reconcile'));
    assert.equal(reconcileReq.init?.body, JSON.stringify({ campaign_id: 'campaign-1' }));

    const eventsReq = captured[4];
    assert.ok(eventsReq.url.endsWith('/v1/campaigns/campaign-1/events'));
});

