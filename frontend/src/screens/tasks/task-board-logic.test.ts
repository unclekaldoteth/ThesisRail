import assert from 'node:assert/strict';
import test from 'node:test';
import type { Campaign, Task } from '@/lib/api';
import {
    canCloseCampaign,
    getVisibleTaskEntries,
    isTaskPastDeadline,
    normalizeWalletAddress,
} from './task-board-logic';

const OWNER = 'st1owner11111111111111111111111111111111111';
const EXECUTOR = 'ST1EXECUTOR11111111111111111111111111111111';

function buildTask(overrides: Partial<Task> = {}): Task {
    return {
        id: overrides.id || 'task-1',
        campaign_id: overrides.campaign_id || 'campaign-1',
        milestone: overrides.milestone || 'Milestone 1',
        title: overrides.title || 'Title',
        description: overrides.description || 'Description',
        payout: overrides.payout || 1000000,
        deadline: overrides.deadline || '2026-03-25T00:00:00.000Z',
        acceptance_criteria: overrides.acceptance_criteria || 'Criteria',
        status: overrides.status || 'open',
        executor: overrides.executor,
        proof_hash: overrides.proof_hash,
        proof_description: overrides.proof_description,
        claimed_at: overrides.claimed_at,
        submitted_at: overrides.submitted_at,
        approved_at: overrides.approved_at,
        cancelled_at: overrides.cancelled_at,
    };
}

function buildCampaign(overrides: Partial<Campaign> = {}): Campaign {
    return {
        id: overrides.id || 'campaign-1',
        owner: overrides.owner || OWNER,
        alpha_id: overrides.alpha_id || 'alpha-1',
        title: overrides.title || 'Campaign',
        description: overrides.description || 'Description',
        total_funded: overrides.total_funded || 3000000,
        remaining_balance: overrides.remaining_balance || 3000000,
        status: overrides.status || 'funded',
        tasks: overrides.tasks || [buildTask()],
        metadata_hash: overrides.metadata_hash || '0x1234',
        created_at: overrides.created_at || '2026-03-20T00:00:00.000Z',
        onchain_id: overrides.onchain_id,
        fund_tx_id: overrides.fund_tx_id,
    };
}

test('normalizeWalletAddress uppercases and trims addresses', () => {
    assert.equal(
        normalizeWalletAddress(`  ${OWNER}  `),
        OWNER.toUpperCase()
    );
    assert.equal(normalizeWalletAddress('   '), null);
});

test('getVisibleTaskEntries hides draft and closed campaigns from owner task list', () => {
    const actionableCampaign = buildCampaign({
        id: 'campaign-funded',
        status: 'funded',
        tasks: [buildTask({ id: 'task-funded' })],
    });
    const draftCampaign = buildCampaign({
        id: 'campaign-draft',
        status: 'draft',
        tasks: [buildTask({ id: 'task-draft', campaign_id: 'campaign-draft' })],
    });
    const closedCampaign = buildCampaign({
        id: 'campaign-closed',
        status: 'closed',
        tasks: [buildTask({ id: 'task-closed', campaign_id: 'campaign-closed', status: 'approved' })],
    });

    const visible = getVisibleTaskEntries(
        [actionableCampaign, draftCampaign, closedCampaign],
        'owner',
        OWNER
    );

    assert.deepEqual(visible.map(({ task }) => task.id), ['task-funded']);
});

test('getVisibleTaskEntries only shows executor-safe work', () => {
    const openTask = buildTask({ id: 'task-open' });
    const claimedByExecutor = buildTask({
        id: 'task-claimed',
        status: 'claimed',
        executor: EXECUTOR,
    });
    const claimedByOther = buildTask({
        id: 'task-other',
        status: 'claimed',
        executor: 'ST1OTHER111111111111111111111111111111111',
    });

    const campaign = buildCampaign({
        tasks: [openTask, claimedByExecutor, claimedByOther],
    });

    const visible = getVisibleTaskEntries([campaign], 'executor', EXECUTOR);

    assert.deepEqual(visible.map(({ task }) => task.id), ['task-open', 'task-claimed']);
});

test('isTaskPastDeadline only unlocks cancellation after the deadline passes', () => {
    const task = buildTask({ deadline: '2026-03-20T12:00:00.000Z' });

    assert.equal(isTaskPastDeadline(task, Date.parse('2026-03-20T11:59:59.000Z')), false);
    assert.equal(isTaskPastDeadline(task, Date.parse('2026-03-20T12:00:01.000Z')), true);
});

test('canCloseCampaign requires every task to be approved or cancelled', () => {
    const closable = buildCampaign({
        status: 'active',
        tasks: [
            buildTask({ id: 'task-approved', status: 'approved' }),
            buildTask({ id: 'task-cancelled', status: 'cancelled' }),
        ],
    });
    const blocked = buildCampaign({
        status: 'active',
        tasks: [
            buildTask({ id: 'task-approved', status: 'approved' }),
            buildTask({ id: 'task-open', status: 'open' }),
        ],
    });

    assert.equal(canCloseCampaign(closable), true);
    assert.equal(canCloseCampaign(blocked), false);
});
