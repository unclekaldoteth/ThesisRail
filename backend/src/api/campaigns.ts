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
import {
    storeCampaign,
    getCampaign,
    getAllCampaigns,
    updateCampaign,
    updateTask,
    Campaign,
    Task,
} from '../storage/store';

export const campaignRouter = Router();

function readParam(value: string | string[] | undefined): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string' && value[0].length > 0) {
        return value[0];
    }
    return null;
}

function generateTasks(alphaCard: any): Task[] {
    const campaignId = ''; // Will be set after campaign creation
    return [
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 1',
            title: 'Thesis Brief + Execution Plan',
            description: `Turn the signal into an execution brief. Claim: "${alphaCard.thesis}". Include evidence links, action plan, and explicit invalidation guardrails.`,
            payout: 500000, // 0.5 STX
            deadline: new Date(Date.now() + 3 * 24 * 3600000).toISOString(),
            acceptance_criteria: 'Deliver a brief with Thesis, Catalyst, Evidence, Risk, and Invalidation sections. Include at least 3 evidence links.',
            status: 'open',
        },
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 2',
            title: 'Content Asset Production',
            description: `Produce platform-ready assets from the approved thesis and catalyst window. Every asset must map to a concrete action angle and risk disclosure.`,
            payout: 300000, // 0.3 STX
            deadline: new Date(Date.now() + 5 * 24 * 3600000).toISOString(),
            acceptance_criteria: 'Submit at least 3 assets with acceptance checklist, evidence reference, and invalidation note for each angle.',
            status: 'open',
        },
        {
            id: uuidv4(),
            campaign_id: campaignId,
            milestone: 'Milestone 3',
            title: 'Distribution + Proof Pack',
            description: `Execute distribution, collect Proof for every publish action, and produce a final report with accountable outcomes.`,
            payout: 200000, // 0.2 STX
            deadline: new Date(Date.now() + 7 * 24 * 3600000).toISOString(),
            acceptance_criteria: 'Submit proof bundle (links/screenshots/hash) and operational summary: claim -> evidence -> action -> invalidation.',
            status: 'open',
        },
    ];
}

// POST /v1/campaigns/convert — Convert alpha card to campaign
campaignRouter.post('/convert', (req: Request, res: Response) => {
    const { alpha_id, owner } = req.body;

    if (!alpha_id) {
        res.status(400).json({ error: 'alpha_id is required' });
        return;
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
        owner: owner || 'demo-owner',
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

    res.json({
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

// POST /v1/campaigns/:id/fund — Fund the campaign (record on-chain tx)
campaignRouter.post('/:id/fund', (req: Request, res: Response) => {
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

    const { amount, tx_id, onchain_id } = req.body;
    const resolvedOnchainId = Number.parseInt(String(onchain_id ?? campaign.onchain_id ?? ''), 10);
    const totalPayout = campaign.tasks.reduce((sum, t) => sum + t.payout, 0);

    if (!Number.isFinite(resolvedOnchainId) || resolvedOnchainId <= 0) {
        res.status(400).json({ error: 'onchain_id is required and must be a positive integer' });
        return;
    }

    const updated = updateCampaign(campaign.id, {
        status: 'funded',
        total_funded: amount || totalPayout,
        remaining_balance: amount || totalPayout,
        onchain_id: resolvedOnchainId,
    });

    res.json({ status: 200, campaign: updated, message: 'Campaign funded successfully' });
});

// POST /v1/campaigns/:id/tasks/:taskId/claim
campaignRouter.post('/:id/tasks/:taskId/claim', (req: Request, res: Response) => {
    const { executor } = req.body;
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

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'open') {
        res.status(400).json({ error: `Task is already ${task.status}` });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'claimed',
        executor: executor || 'demo-executor',
        claimed_at: new Date().toISOString(),
    });

    res.json({ status: 200, task: updated, message: 'Task claimed successfully' });
});

// POST /v1/campaigns/:id/tasks/:taskId/submit
campaignRouter.post('/:id/tasks/:taskId/submit', (req: Request, res: Response) => {
    const { proof_hash, proof_description } = req.body;
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

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'claimed') {
        res.status(400).json({ error: `Task must be claimed first. Current status: ${task.status}` });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'proof_submitted',
        proof_hash: proof_hash || `0x${Date.now().toString(16)}`,
        proof_description: proof_description || 'Proof submitted',
        submitted_at: new Date().toISOString(),
    });

    res.json({ status: 200, task: updated, message: 'Proof submitted successfully' });
});

// POST /v1/campaigns/:id/tasks/:taskId/approve — Approve + trigger payout
campaignRouter.post('/:id/tasks/:taskId/approve', (req: Request, res: Response) => {
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

    const task = campaign.tasks.find((t) => t.id === taskId);
    if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (task.status !== 'proof_submitted') {
        res.status(400).json({ error: `Task must have proof submitted. Current status: ${task.status}` });
        return;
    }

    const updated = updateTask(campaign.id, task.id, {
        status: 'approved',
        approved_at: new Date().toISOString(),
    });

    // Update campaign balance
    updateCampaign(campaign.id, {
        remaining_balance: campaign.remaining_balance - task.payout,
    });

    res.json({
        status: 200,
        task: updated,
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

    const updated = updateCampaign(campaign.id, { status: 'closed' });
    res.json({ status: 200, campaign: updated, message: 'Campaign closed' });
});

// POST /v1/campaigns/:id/withdraw
campaignRouter.post('/:id/withdraw', (req: Request, res: Response) => {
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

    res.json({
        status: 200,
        campaign: updated,
        withdrawal: {
            amount,
            amount_stx: amount / 1000000,
            message: 'Remaining balance withdrawn. Execute onchain withdraw-remaining for settlement.',
        },
    });
});
