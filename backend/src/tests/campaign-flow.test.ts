import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../index';
import { resetStorageForTests, storeAlphaCards } from '../storage/store';

const OWNER = 'ST1OWNER11111111111111111111111111111111111';
const EXECUTOR = 'ST1EXECUTOR11111111111111111111111111111111';
const CONTRACT_ID = 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v5';

function jsonHeaders(caller: string, idempotencyKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-Caller-Address': caller,
        'X-Idempotency-Key': idempotencyKey,
    };
}

function txPayload(
    txId: string,
    sender: string,
    functionName: string,
    args: string[]
): Record<string, unknown> {
    return {
        tx_id: txId,
        tx_status: 'success',
        tx_type: 'contract_call',
        sender_address: sender,
        contract_call: {
            contract_id: CONTRACT_ID,
            function_name: functionName,
            function_args: args.map((repr) => ({ repr })),
        },
    };
}

test('campaign lifecycle + reconciliation regression', async (t) => {
    process.env.STORAGE_FILE = '/tmp/thesisrail-campaign-regression-store.json';
    process.env.CONTRACT_ADDRESS = 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM';
    process.env.CONTRACT_NAME = 'thesis-rail-escrow-v5';
    process.env.RECONCILER_ENABLED = 'false';

    resetStorageForTests();
    storeAlphaCards([
        {
            id: 'alpha-reg-1',
            alpha_score: 88,
            thesis: 'Stablecoin payment rails demand is accelerating.',
            catalyst: 'Major exchange listing and treasury integrations',
            time_window: '7d',
            evidence_links: ['https://example.com/evidence-1'],
            risks: ['Regulatory policy risk'],
            invalidation_rule: 'Invalidate if integration volume stalls for 2 weeks.',
            content_angles: ['Institutional use case', 'Cross-border execution'],
            source: 'reddit',
            source_title: 'Signal thread',
            source_author: 'alpha_user',
            created_at: new Date().toISOString(),
        },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;

        if (url.includes('/extended/v1/tx/')) {
            const txId = url.split('/extended/v1/tx/')[1].replace(/^0x/, '');
            const payloadMap: Record<string, Record<string, unknown>> = {
                fundtx: txPayload('0xfundtx', OWNER, 'fund-campaign', ['u1', 'u1500000']),
                claimtx: txPayload('0xclaimtx', EXECUTOR, 'claim-task', ['u1', 'u1']),
                submittx: txPayload('0xsubmittx', EXECUTOR, 'submit-proof', ['u1', 'u1', '0x1234']),
                approvetx: txPayload('0xapprovetx', OWNER, 'approve-task', ['u1', 'u1']),
                closetx: txPayload('0xclosetx', OWNER, 'close-campaign', ['u1']),
                withdrawtx: txPayload('0xwithdrawtx', OWNER, 'withdraw-remaining', ['u1', 'u100000']),
            };

            const found = payloadMap[txId.toLowerCase()];
            if (found) {
                return new Response(JSON.stringify(found), {
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
    await new Promise<void>((resolve) => {
        server.listen(0, () => resolve());
    });
    t.after(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const convertRes = await fetch(`${baseUrl}/v1/campaigns/convert`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-convert'),
        body: JSON.stringify({ alpha_id: 'alpha-reg-1', owner: OWNER }),
    });
    assert.equal(convertRes.status, 200);
    const convertJson = await convertRes.json() as { campaign: { id: string; tasks: Array<{ id: string }> } };
    const campaignId = convertJson.campaign.id;
    const taskId = convertJson.campaign.tasks[0].id;

    const fundRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/fund`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-fund'),
        body: JSON.stringify({ tx_id: 'fundtx', onchain_id: 1 }),
    });
    assert.equal(fundRes.status, 200);

    const claimRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: jsonHeaders(EXECUTOR, 'k-claim'),
        body: JSON.stringify({ tx_id: 'claimtx' }),
    });
    assert.equal(claimRes.status, 200);

    const submitRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: jsonHeaders(EXECUTOR, 'k-submit'),
        body: JSON.stringify({ tx_id: 'submittx', proof_description: 'Proof pack submitted' }),
    });
    assert.equal(submitRes.status, 200);

    const approveRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/tasks/${taskId}/approve`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-approve'),
        body: JSON.stringify({ tx_id: 'approvetx' }),
    });
    assert.equal(approveRes.status, 200);

    const closeRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/close`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-close'),
        body: JSON.stringify({ tx_id: 'closetx' }),
    });
    assert.equal(closeRes.status, 200);

    const withdrawRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/withdraw`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-withdraw'),
        body: JSON.stringify({ amount: 100000, tx_id: 'withdrawtx' }),
    });
    assert.equal(withdrawRes.status, 200);

    const eventsBeforeRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/events`);
    assert.equal(eventsBeforeRes.status, 200);
    const eventsBeforeJson = await eventsBeforeRes.json() as { events: Array<{ event_type: string; onchain_status: string }> };
    assert.ok(eventsBeforeJson.events.length >= 7);
    assert.ok(eventsBeforeJson.events.some((event) => event.event_type === 'campaign.funded'));
    assert.ok(eventsBeforeJson.events.some((event) => event.onchain_status === 'pending'));

    const reconcileRes = await fetch(`${baseUrl}/v1/campaigns/${campaignId}/reconcile`, {
        method: 'POST',
        headers: jsonHeaders(OWNER, 'k-reconcile'),
        body: JSON.stringify({ campaign_id: campaignId }),
    });
    assert.equal(reconcileRes.status, 200);
    const reconcileJson = await reconcileRes.json() as {
        reconciliation: { confirmed: number; failed: number };
        events: Array<{ tx_id?: string; onchain_status: string }>;
    };

    assert.ok(reconcileJson.reconciliation.confirmed >= 5);
    assert.equal(reconcileJson.reconciliation.failed, 0);
    const txLinked = reconcileJson.events.filter((event) => Boolean(event.tx_id));
    assert.ok(txLinked.every((event) => event.onchain_status === 'confirmed'));
});
