/**
 * Campaign API Routes
 * POST /v1/campaigns/convert — free, converts alpha card to campaign + tasks
 * GET  /v1/campaigns — list all campaigns
 * GET  /v1/campaigns/:id — get campaign detail
 * POST /v1/campaigns/:id/fund — mark campaign as funded
 * POST /v1/campaigns/:id/tasks/:taskId/claim — claim a task
 * POST /v1/campaigns/:id/tasks/:taskId/submit — submit proof
 * POST /v1/campaigns/:id/tasks/:taskId/approve — approve task + trigger payout
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getAlphaCard } from '../storage/store';
import type { AlphaCard } from '../scoring/alphaScorer';
import { beginMutationIdempotency, sendIdempotentResponse } from '../middleware/idempotency';
import { reconcileCampaignEvents } from '../onchain/reconciler';
import { fetchStacksTxById, parseUintReprToNumber } from '../onchain/stacksApi';
import {
    storeCampaign,
    getCampaign,
    getAllCampaigns,
    getCampaignEvents,
    appendCampaignEvent,
    updateCampaign,
    updateTask,
    Campaign,
    Task,
} from '../storage/store';

export const campaignRouter = Router();
const STACKS_ADDRESS_REGEX = /^S[A-Z0-9]{20,80}$/;

function readParam(value: string | string[] | undefined): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string' && value[0].length > 0) {
        return value[0];
    }
    return null;
}

function readBodyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 0 ? compact : null;
}

function normalizeAddress(value: string): string {
    return value.trim().toUpperCase();
}

function isStacksAddress(value: string): boolean {
    return STACKS_ADDRESS_REGEX.test(value);
}

function readCallerAddress(req: Request): string | null {
    const fromPrimary = readBodyString(req.header('x-caller-address'));
    if (fromPrimary) return normalizeAddress(fromPrimary);
    const fromAlt = readBodyString(req.header('x-wallet-address'));
    if (fromAlt) return normalizeAddress(fromAlt);
    return null;
}

function requireCallerAddress(req: Request, res: Response): string | null {
    const caller = readCallerAddress(req);
    if (!caller || !isStacksAddress(caller)) {
        res.status(401).json({
            error: 'Missing or invalid caller address. Include a valid STX address in X-Caller-Address header.',
        });
        return null;
    }
    return caller;
}

function requireCampaignOwner(campaign: Campaign, caller: string, res: Response): boolean {
    if (normalizeAddress(campaign.owner) !== normalizeAddress(caller)) {
        res.status(403).json({ error: 'Only campaign owner can perform this action' });
        return false;
    }
    return true;
}

function readPositiveInt(value: unknown): number | null {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function readIsoDate(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toISOString();
}

function normalizeText(value: string, fallback: string, maxLen: number): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    const resolved = compact.length > 0 ? compact : fallback;
    if (resolved.length <= maxLen) return resolved;
    return `${resolved.substring(0, maxLen - 3)}...`;
}

function normalizeList(values: string[], fallback: string, maxItems: number, maxLen: number): string[] {
    const unique = Array.from(
        new Set(
            values
                .map((value) => normalizeText(value, '', maxLen))
                .filter((value) => value.length > 0)
        )
    ).slice(0, maxItems);
    if (unique.length > 0) return unique;
    return [fallback];
}

function canExecuteTasks(campaign: Campaign): boolean {
    return campaign.status === 'funded' || campaign.status === 'active';
}

function getTaskOnchainId(campaign: Campaign, taskId: string): number | null {
    const index = campaign.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    return index + 1;
}

function resolveEventOnchainStatus(txId: string | null): 'pending' | 'unknown' {
    return txId ? 'pending' : 'unknown';
}

async function verifyFundTransaction(
    txId: string,
    caller: string,
    onchainId: number
): Promise<{ ok: true; fundedAmount: number } | { ok: false; reason: string }> {
    const tx = await fetchStacksTxById(txId);
    if (!tx) {
        return { ok: false, reason: 'Unable to load fund transaction from Stacks API' };
    }

    if (tx.tx_status !== 'success') {
        return { ok: false, reason: 'Fund transaction is not confirmed as success yet' };
    }

    if (tx.tx_type !== 'contract_call') {
        return { ok: false, reason: 'Fund transaction must be a contract-call tx' };
    }

    if (normalizeAddress(tx.sender_address || '') !== normalizeAddress(caller)) {
        return { ok: false, reason: 'Fund transaction sender does not match caller address' };
    }

    const contractCall = tx.contract_call;
    if (!contractCall || contractCall.function_name !== 'fund-campaign') {
        return { ok: false, reason: 'Transaction is not a fund-campaign call' };
    }

    const expectedContractAddress = process.env.CONTRACT_ADDRESS;
    const expectedContractName = process.env.CONTRACT_NAME;
    const expectedContractId = expectedContractAddress && expectedContractName
        ? `${expectedContractAddress}.${expectedContractName}`
        : null;
    if (expectedContractId && contractCall.contract_id && contractCall.contract_id !== expectedContractId) {
        return { ok: false, reason: 'Transaction contract does not match configured escrow contract' };
    }

    const args = Array.isArray(contractCall.function_args) ? contractCall.function_args : [];
    const txCampaignId = parseUintReprToNumber(args[0]?.repr);
    const txAmount = parseUintReprToNumber(args[1]?.repr);
    if (!txCampaignId || txCampaignId !== onchainId) {
        return { ok: false, reason: 'Transaction campaign id does not match onchain_id' };
    }
    if (!txAmount) {
        return { ok: false, reason: 'Unable to parse funded amount from transaction arguments' };
    }

    return { ok: true, fundedAmount: txAmount };
}

function deadlineInDays(days: number): string {
    return new Date(Date.now() + days * 24 * 3600000).toISOString();
}

function payoutPlanMicroStx(alphaScore: number): [number, number, number] {
    if (alphaScore >= 80) return [700000, 500000, 300000];
    if (alphaScore >= 60) return [600000, 400000, 250000];
    return [500000, 350000, 200000];
}

function generateTasks(alphaCard: AlphaCard): Task[] {
    const campaignId = ''; // Will be set after campaign creation
    const [payout1, payout2, payout3] = payoutPlanMicroStx(alphaCard.alpha_score);
    const evidence = normalizeList(alphaCard.evidence_links, 'https://example.com/evidence', 2, 200);
    const angles = normalizeList(
        alphaCard.content_angles,
        'Create one execution angle tied to the thesis and catalyst.',
        3,
        180
    );
    const risks = normalizeList(alphaCard.risks, 'Execution risk is undefined. Add explicit risk assumptions.', 2, 160);
    const thesis = normalizeText(alphaCard.thesis, 'No thesis provided', 180);
    const catalyst = normalizeText(alphaCard.catalyst, 'No catalyst provided', 140);
    const invalidation = normalizeText(alphaCard.invalidation_rule, 'No invalidation rule provided', 220);

    return [
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 1: Thesis Brief',
            title: 'Thesis + Catalyst Brief',
            description: `Prepare an operational brief from the signal. Claim: "${thesis}". Catalyst window: ${catalyst}.`,
            payout: payout1,
            deadline: deadlineInDays(2),
            acceptance_criteria: `Deliver a brief with sections: Thesis, Catalyst, Evidence, Risk, Invalidation. Include evidence links: ${evidence.join(' | ')}.`,
            status: 'open',
        },
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 2: Asset Build',
            title: 'Create Campaign Assets',
            description: `Produce assets mapped to action angles: ${angles.join(' | ')}.`,
            payout: payout2,
            deadline: deadlineInDays(4),
            acceptance_criteria: `Submit at least 3 assets. Each asset must include linked Evidence, one Risk note (${risks[0]}), and one Invalidation condition.`,
            status: 'open',
        },
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 3: Distribution + Proof',
            title: 'Distribute and Submit Proof Pack',
            description: 'Execute distribution, then submit Proof bundle for owner approval and Escrow payout.',
            payout: payout3,
            deadline: deadlineInDays(6),
            acceptance_criteria: `Submit Proof bundle (links/screenshots/hash) and operational summary: claim -> evidence -> action -> invalidation. Invalidation rule: ${invalidation}.`,
            status: 'open',
        },
    ];
}

// POST /v1/campaigns/convert — Convert alpha card to campaign
campaignRouter.post('/convert', (req: Request, res: Response) => {
    const { alpha_id, owner } = req.body;
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;

    if (!alpha_id) {
        res.status(400).json({ error: 'alpha_id is required' });
        return;
    }

    const requestedOwner = readBodyString(owner);
    if (requestedOwner) {
        const normalizedRequestedOwner = normalizeAddress(requestedOwner);
        if (!isStacksAddress(normalizedRequestedOwner)) {
            res.status(400).json({ error: 'owner must be a valid STX address' });
            return;
        }
        if (normalizedRequestedOwner !== caller) {
            res.status(403).json({ error: 'owner must match X-Caller-Address' });
            return;
        }
    }

    const alphaCard = getAlphaCard(alpha_id);
    if (!alphaCard) {
        res.status(404).json({ error: 'Alpha card not found. Fetch alpha cards first.' });
        return;
    }

    const campaignId = uuidv4();
    const tasks = generateTasks(alphaCard);
    tasks.forEach((t) => (t.campaign_id = campaignId));

    const totalPayout = tasks.reduce((sum, t) => sum + t.payout, 0);
    const proposal = {
        claim: alphaCard.thesis,
        evidence: alphaCard.evidence_links.slice(0, 5),
        action: tasks.map((task) => `${task.milestone}: ${task.title}`),
        invalidation: alphaCard.invalidation_rule,
    };

    const campaign: Campaign = {
        id: campaignId,
        owner: caller,
        alpha_id,
        title: `Campaign: ${alphaCard.thesis.substring(0, 80)}`,
        description: `Content campaign derived from alpha signal. Thesis: ${alphaCard.thesis}. Catalyst: ${alphaCard.catalyst}.`,
        total_funded: 0,
        remaining_balance: 0,
        status: 'draft',
        tasks,
        metadata_hash: `0x${Buffer.from(alphaCard.thesis).toString('hex').substring(0, 64)}`,
        created_at: new Date().toISOString(),
    };

    storeCampaign(campaign);
    appendCampaignEvent({
        campaign_id: campaign.id,
        actor: caller,
        event_type: 'campaign.converted',
        message: 'Campaign created from Alpha signal and work orders generated.',
        onchain_status: 'unknown',
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        campaign,
        proposal,
        summary: {
            total_tasks: tasks.length,
            total_payout_required: totalPayout,
            total_payout_stx: totalPayout / 1000000,
            estimated_timeline_days: 7,
        },
    });
});

// GET /v1/campaigns — list all
campaignRouter.get('/', (_req: Request, res: Response) => {
    const campaigns = getAllCampaigns();
    res.json({ status: 200, count: campaigns.length, campaigns });
});

// GET /v1/campaigns/:id
campaignRouter.get('/:id', (req: Request, res: Response) => {
    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    res.json({ status: 200, campaign });
});

// GET /v1/campaigns/:id/events
campaignRouter.get('/:id/events', (req: Request, res: Response) => {
    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    const events = getCampaignEvents(campaignId);
    res.json({
        status: 200,
        campaign_id: campaignId,
        count: events.length,
        events,
    });
});

// POST /v1/campaigns/:id/reconcile — manual onchain reconciliation for pending tx-linked events
campaignRouter.post('/:id/reconcile', async (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;

    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;

    try {
        const summary = await reconcileCampaignEvents(campaign.id, 200);
        const events = getCampaignEvents(campaign.id);
        sendIdempotentResponse(res, idempotency, 200, {
            status: 200,
            campaign_id: campaign.id,
            reconciliation: summary,
            events,
        });
    } catch (error) {
        console.error('[Campaign API] Reconcile error:', error);
        res.status(500).json({ error: 'Failed to reconcile onchain events' });
    }
});

// PATCH /v1/campaigns/:id/tasks/:taskId — edit draft task details before deploy
campaignRouter.patch('/:id/tasks/:taskId', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;

    const campaignId = readParam(req.params.id);
    const taskId = readParam(req.params.taskId);
    if (!campaignId || !taskId) {
        res.status(400).json({ error: 'Invalid campaign id or task id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;

    if (campaign.status !== 'draft') {
        res.status(400).json({ error: 'Only draft campaign tasks can be edited before deploy' });
        return;
    }

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }

    const body = (req.body && typeof req.body === 'object')
        ? (req.body as Record<string, unknown>)
        : {};
    const updates: Partial<Task> = {};

    if ('milestone' in body) {
        const milestone = readBodyString(body.milestone);
        if (!milestone) {
            res.status(400).json({ error: 'milestone must be a non-empty string' });
            return;
        }
        updates.milestone = milestone;
    }

    if ('title' in body) {
        const title = readBodyString(body.title);
        if (!title) {
            res.status(400).json({ error: 'title must be a non-empty string' });
            return;
        }
        updates.title = title;
    }

    if ('description' in body) {
        const description = readBodyString(body.description);
        if (!description) {
            res.status(400).json({ error: 'description must be a non-empty string' });
            return;
        }
        updates.description = description;
    }

    if ('acceptance_criteria' in body) {
        const acceptanceCriteria = readBodyString(body.acceptance_criteria);
        if (!acceptanceCriteria) {
            res.status(400).json({ error: 'acceptance_criteria must be a non-empty string' });
            return;
        }
        updates.acceptance_criteria = acceptanceCriteria;
    }

    if ('payout' in body) {
        const payout = readPositiveInt(body.payout);
        if (payout === null) {
            res.status(400).json({ error: 'payout must be a positive integer (uSTX)' });
            return;
        }
        updates.payout = payout;
    }

    if ('deadline' in body) {
        const deadline = readIsoDate(body.deadline);
        if (!deadline) {
            res.status(400).json({ error: 'deadline must be a valid ISO date string' });
            return;
        }
        updates.deadline = deadline;
    }

    if (Object.keys(updates).length === 0) {
        res.status(400).json({
            error: 'No editable task fields provided. Use milestone, title, description, payout, deadline, acceptance_criteria.',
        });
        return;
    }

    const updated = updateTask(campaign.id, task.id, updates);
    appendCampaignEvent({
        campaign_id: campaign.id,
        task_id: task.id,
        actor: caller,
        event_type: 'task.updated',
        message: 'Draft task details updated in campaign builder.',
        onchain_status: 'unknown',
    });
    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        task: updated,
        message: 'Task updated successfully',
    });
});

// POST /v1/campaigns/:id/fund — Fund the campaign (record on-chain tx)
campaignRouter.post('/:id/fund', async (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;

    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;
    if (campaign.status === 'closed') {
        res.status(400).json({ error: 'Campaign is already closed and cannot be funded' });
        return;
    }
    if (campaign.status === 'active') {
        res.status(400).json({ error: 'Campaign is already active. Additional funding is not supported in MVP.' });
        return;
    }

    const { tx_id, onchain_id } = req.body;
    const txId = readBodyString(tx_id);
    const resolvedOnchainId = Number.parseInt(String(onchain_id ?? campaign.onchain_id ?? ''), 10);
    const totalPayout = campaign.tasks.reduce((sum, t) => sum + t.payout, 0);

    if (!txId) {
        res.status(400).json({ error: 'tx_id is required for fund verification' });
        return;
    }

    if (!Number.isFinite(resolvedOnchainId) || resolvedOnchainId <= 0) {
        res.status(400).json({ error: 'onchain_id is required and must be a positive integer' });
        return;
    }

    if (
        campaign.status === 'funded' &&
        campaign.fund_tx_id === txId &&
        campaign.onchain_id === resolvedOnchainId
    ) {
        sendIdempotentResponse(res, idempotency, 200, {
            status: 200,
            campaign,
            message: 'Campaign already funded (idempotent replay)',
        });
        return;
    }
    if (campaign.status === 'funded') {
        res.status(400).json({ error: 'Campaign is already funded. Provide the original tx_id to replay safely.' });
        return;
    }

    const verification = await verifyFundTransaction(txId, caller, resolvedOnchainId);
    if (!verification.ok) {
        res.status(400).json({ error: `Fund verification failed: ${verification.reason}` });
        return;
    }

    if (verification.fundedAmount < totalPayout) {
        res.status(400).json({
            error: `Fund amount is below required task payout total. Required=${totalPayout}, funded=${verification.fundedAmount}`,
        });
        return;
    }

    const updated = updateCampaign(campaign.id, {
        status: 'funded',
        total_funded: verification.fundedAmount,
        remaining_balance: verification.fundedAmount,
        onchain_id: resolvedOnchainId,
        fund_tx_id: txId,
    });
    appendCampaignEvent({
        campaign_id: campaign.id,
        actor: caller,
        event_type: 'campaign.funded',
        message: `Escrow funded and verified onchain (${(verification.fundedAmount / 1000000).toFixed(2)} STX).`,
        tx_id: txId,
        expected_function: 'fund-campaign',
        expected_sender: caller,
        expected_campaign_onchain_id: resolvedOnchainId,
        onchain_status: 'confirmed',
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        campaign: updated,
        message: 'Campaign funded successfully',
    });
});

// POST /v1/campaigns/:id/tasks/:taskId/claim
campaignRouter.post('/:id/tasks/:taskId/claim', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;
    const txId = readBodyString((req.body as Record<string, unknown> | undefined)?.tx_id);

    const campaignId = readParam(req.params.id);
    const taskId = readParam(req.params.taskId);
    if (!campaignId || !taskId) {
        res.status(400).json({ error: 'Invalid campaign id or task id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!canExecuteTasks(campaign)) {
        res.status(400).json({ error: `Campaign must be funded before claim. Current status: ${campaign.status}` });
        return;
    }

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'open') {
        res.status(400).json({ error: `Task is already ${task.status}` });
        return;
    }
    if (normalizeAddress(campaign.owner) === caller) {
        res.status(403).json({ error: 'Campaign owner cannot claim own task' });
        return;
    }
    if (Date.parse(task.deadline) < Date.now()) {
        res.status(400).json({ error: 'Task deadline has passed and can no longer be claimed' });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'claimed',
        executor: caller,
        claimed_at: new Date().toISOString(),
    });
    if (campaign.status === 'funded') {
        updateCampaign(campaign.id, { status: 'active' });
    }
    appendCampaignEvent({
        campaign_id: campaign.id,
        task_id: task.id,
        actor: caller,
        event_type: 'task.claimed',
        message: 'Executor claimed milestone task.',
        tx_id: txId || undefined,
        expected_function: txId ? 'claim-task' : undefined,
        expected_sender: txId ? caller : undefined,
        expected_campaign_onchain_id: txId ? campaign.onchain_id : undefined,
        expected_task_onchain_id: txId ? getTaskOnchainId(campaign, task.id) || undefined : undefined,
        onchain_status: resolveEventOnchainStatus(txId),
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        task: updated,
        onchain: { tx_id: txId, status: resolveEventOnchainStatus(txId) },
        message: 'Task claimed successfully',
    });
});

// POST /v1/campaigns/:id/tasks/:taskId/submit
campaignRouter.post('/:id/tasks/:taskId/submit', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;

    const body = (req.body && typeof req.body === 'object')
        ? (req.body as Record<string, unknown>)
        : {};
    const proofHash = readBodyString(body.proof_hash);
    const proofDescription = readBodyString(body.proof_description);
    const txId = readBodyString(body.tx_id);
    const campaignId = readParam(req.params.id);
    const taskId = readParam(req.params.taskId);
    if (!campaignId || !taskId) {
        res.status(400).json({ error: 'Invalid campaign id or task id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!canExecuteTasks(campaign)) {
        res.status(400).json({ error: `Campaign must be funded before submit. Current status: ${campaign.status}` });
        return;
    }

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'claimed') {
        res.status(400).json({ error: `Task must be claimed first. Current status: ${task.status}` });
        return;
    }
    if (!task.executor || normalizeAddress(task.executor) !== caller) {
        res.status(403).json({ error: 'Only the task executor can submit proof' });
        return;
    }
    if (Date.parse(task.deadline) < Date.now()) {
        res.status(400).json({ error: 'Task deadline has passed and can no longer accept proof' });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'proof_submitted',
        proof_hash: proofHash || `0x${Date.now().toString(16)}`,
        proof_description: proofDescription || 'Proof submitted',
        submitted_at: new Date().toISOString(),
    });
    appendCampaignEvent({
        campaign_id: campaign.id,
        task_id: task.id,
        actor: caller,
        event_type: 'task.proof_submitted',
        message: 'Executor submitted proof for milestone review.',
        tx_id: txId || undefined,
        expected_function: txId ? 'submit-proof' : undefined,
        expected_sender: txId ? caller : undefined,
        expected_campaign_onchain_id: txId ? campaign.onchain_id : undefined,
        expected_task_onchain_id: txId ? getTaskOnchainId(campaign, task.id) || undefined : undefined,
        onchain_status: resolveEventOnchainStatus(txId),
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        task: updated,
        onchain: { tx_id: txId, status: resolveEventOnchainStatus(txId) },
        message: 'Proof submitted successfully',
    });
});

// POST /v1/campaigns/:id/tasks/:taskId/approve — Approve + trigger payout
campaignRouter.post('/:id/tasks/:taskId/approve', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;
    const txId = readBodyString((req.body as Record<string, unknown> | undefined)?.tx_id);

    const campaignId = readParam(req.params.id);
    const taskId = readParam(req.params.taskId);
    if (!campaignId || !taskId) {
        res.status(400).json({ error: 'Invalid campaign id or task id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;
    if (!canExecuteTasks(campaign)) {
        res.status(400).json({ error: `Campaign must be funded before approval. Current status: ${campaign.status}` });
        return;
    }

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'proof_submitted') {
        res.status(400).json({ error: `Task must have proof submitted. Current status: ${task.status}` });
        return;
    }
    if (campaign.remaining_balance < task.payout) {
        res.status(400).json({
            error: `Campaign escrow balance is insufficient. Required=${task.payout}, remaining=${campaign.remaining_balance}`,
        });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'approved',
        approved_at: new Date().toISOString(),
    });

    // Update campaign balance
    const updatedCampaign = updateCampaign(campaign.id, {
        remaining_balance: campaign.remaining_balance - task.payout,
        status: campaign.status === 'funded' ? 'active' : campaign.status,
    });
    appendCampaignEvent({
        campaign_id: campaign.id,
        task_id: task.id,
        actor: caller,
        event_type: 'task.approved',
        message: 'Owner approved proof and triggered escrow payout.',
        tx_id: txId || undefined,
        expected_function: txId ? 'approve-task' : undefined,
        expected_sender: txId ? caller : undefined,
        expected_campaign_onchain_id: txId ? campaign.onchain_id : undefined,
        expected_task_onchain_id: txId ? getTaskOnchainId(campaign, task.id) || undefined : undefined,
        onchain_status: resolveEventOnchainStatus(txId),
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        task: updated,
        campaign: updatedCampaign,
        onchain: { tx_id: txId, status: resolveEventOnchainStatus(txId) },
        payout: {
            amount: task.payout,
            amount_stx: task.payout / 1000000,
            executor: task.executor,
            message: 'Payout triggered — execute onchain approve-task to transfer STX',
        },
    });
});

// POST /v1/campaigns/:id/close
campaignRouter.post('/:id/close', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;
    const txId = readBodyString((req.body as Record<string, unknown> | undefined)?.tx_id);

    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;
    if (campaign.status === 'closed') {
        sendIdempotentResponse(res, idempotency, 200, {
            status: 200,
            campaign,
            message: 'Campaign already closed',
        });
        return;
    }
    if (!canExecuteTasks(campaign)) {
        res.status(400).json({ error: `Only funded/active campaigns can be closed. Current status: ${campaign.status}` });
        return;
    }
    const pendingTasks = campaign.tasks.filter((task) => task.status === 'claimed' || task.status === 'proof_submitted');
    if (pendingTasks.length > 0) {
        res.status(400).json({ error: 'Cannot close campaign while tasks are claimed or awaiting proof approval' });
        return;
    }

    const updated = updateCampaign(campaign.id, { status: 'closed' });
    appendCampaignEvent({
        campaign_id: campaign.id,
        actor: caller,
        event_type: 'campaign.closed',
        message: 'Owner closed campaign lifecycle.',
        tx_id: txId || undefined,
        expected_function: txId ? 'close-campaign' : undefined,
        expected_sender: txId ? caller : undefined,
        expected_campaign_onchain_id: txId ? campaign.onchain_id : undefined,
        onchain_status: resolveEventOnchainStatus(txId),
    });
    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        campaign: updated,
        onchain: { tx_id: txId, status: resolveEventOnchainStatus(txId) },
        message: 'Campaign closed',
    });
});

// POST /v1/campaigns/:id/withdraw
campaignRouter.post('/:id/withdraw', (req: Request, res: Response) => {
    const caller = requireCallerAddress(req, res);
    if (!caller) return;
    const idempotency = beginMutationIdempotency(req, res, caller);
    if (!idempotency) return;
    const txId = readBodyString((req.body as Record<string, unknown> | undefined)?.tx_id);

    const campaignId = readParam(req.params.id);
    if (!campaignId) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }
    if (!requireCampaignOwner(campaign, caller, res)) return;

    if (campaign.status !== 'closed') {
        res.status(400).json({ error: 'Campaign must be closed before withdrawal' });
        return;
    }

    const amount = Number.parseInt(String(req.body.amount || campaign.remaining_balance), 10);
    if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'Invalid withdrawal amount' });
        return;
    }

    if (amount > campaign.remaining_balance) {
        res.status(400).json({ error: 'Withdrawal amount exceeds remaining balance' });
        return;
    }

    const updated = updateCampaign(campaign.id, {
        remaining_balance: campaign.remaining_balance - amount,
    });
    appendCampaignEvent({
        campaign_id: campaign.id,
        actor: caller,
        event_type: 'campaign.withdrawn',
        message: `Owner withdrew remaining escrow (${(amount / 1000000).toFixed(2)} STX).`,
        tx_id: txId || undefined,
        expected_function: txId ? 'withdraw-remaining' : undefined,
        expected_sender: txId ? caller : undefined,
        expected_campaign_onchain_id: txId ? campaign.onchain_id : undefined,
        onchain_status: resolveEventOnchainStatus(txId),
    });

    sendIdempotentResponse(res, idempotency, 200, {
        status: 200,
        campaign: updated,
        onchain: { tx_id: txId, status: resolveEventOnchainStatus(txId) },
        withdrawal: {
            amount,
            amount_stx: amount / 1000000,
            message: 'Remaining balance withdrawn. Execute onchain withdraw-remaining for settlement.',
        },
    });
});
