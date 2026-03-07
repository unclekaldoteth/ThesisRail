/**
 * ThesisRail API Client
 * Handles all backend API communication including x402 payment flow.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface AlphaCard {
    id: string;
    alpha_score: number;
    thesis: string;
    catalyst: string;
    time_window: string;
    evidence_links: string[];
    risks: string[];
    invalidation_rule: string;
    content_angles: string[];
    source: 'reddit' | 'youtube';
    source_title: string;
    source_author: string;
    created_at: string;
}

export interface Campaign {
    id: string;
    owner: string;
    alpha_id: string;
    title: string;
    description: string;
    total_funded: number;
    remaining_balance: number;
    status: 'draft' | 'funded' | 'active' | 'closed';
    tasks: Task[];
    metadata_hash: string;
    created_at: string;
    onchain_id?: number;
    fund_tx_id?: string;
}

export interface Task {
    id: string;
    campaign_id: string;
    milestone: string;
    title: string;
    description: string;
    payout: number;
    deadline: string;
    acceptance_criteria: string;
    status: 'open' | 'claimed' | 'proof_submitted' | 'approved' | 'cancelled';
    executor?: string;
    proof_hash?: string;
    proof_description?: string;
    claimed_at?: string;
    submitted_at?: string;
    approved_at?: string;
    cancelled_at?: string;
}

export interface TaskDraftUpdate {
    milestone?: string;
    title?: string;
    description?: string;
    payout?: number;
    deadline?: string;
    acceptance_criteria?: string;
}

export interface CampaignEvent {
    id: string;
    campaign_id: string;
    task_id?: string;
    actor?: string;
    event_type: string;
    message: string;
    tx_id?: string;
    onchain_status: 'unknown' | 'pending' | 'confirmed' | 'failed';
    onchain_reason?: string;
    created_at: string;
    updated_at: string;
}

export interface PaymentRequirements {
    version: string;
    network: string;
    token: string;
    amount: string;
    receiver: string;
    description: string;
    resource: string;
    scheme: string;
    asset_contract?: string;
}

export interface X402Response {
    status: 402;
    paymentRequirements: PaymentRequirements;
}

export type FetchAlphaCardsResult =
    | {
        state: 'payment_required';
        requirements: PaymentRequirements;
        reason?: string;
        message?: string;
    }
    | {
        state: 'loaded';
        cards: AlphaCard[];
    };

async function parseJsonBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return { message: text } satisfies Record<string, string>;
    }
}

function resolveErrorMessage(data: unknown, fallback: string): string {
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        if (typeof record.error === 'string' && record.error.trim().length > 0) return record.error;
        if (typeof record.message === 'string' && record.message.trim().length > 0) return record.message;
    }
    return fallback;
}

async function requireOkJson(res: Response, context: string): Promise<Record<string, unknown>> {
    const data = await parseJsonBody(res);
    if (!res.ok) {
        throw new Error(resolveErrorMessage(data, `${context} failed (HTTP ${res.status})`));
    }
    if (data && typeof data === 'object') {
        return data as Record<string, unknown>;
    }
    return {};
}

function requireCallerAddress(callerAddress: string | null | undefined): string {
    const normalized = (callerAddress || '').trim();
    if (!normalized) {
        throw new Error('Wallet address is required. Connect wallet first.');
    }
    return normalized;
}

function callerJsonHeaders(callerAddress: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-Caller-Address': requireCallerAddress(callerAddress),
    };
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => typeof entry !== 'undefined')
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
}

function fnv1a32(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeKeyPart(input: string): string {
    const normalized = input.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized.length > 0 ? normalized : 'mutation';
}

function buildIdempotencyKey(action: string, payload: unknown): string {
    const normalizedAction = normalizeKeyPart(action);
    const payloadHash = fnv1a32(stableSerialize(payload));
    const key = `tr:${normalizedAction}:${payloadHash}`;
    return key.length <= 128 ? key : key.slice(0, 128);
}

function mutationJsonHeaders(callerAddress: string, action: string, payload: unknown): Record<string, string> {
    return {
        ...callerJsonHeaders(callerAddress),
        'X-Idempotency-Key': buildIdempotencyKey(action, payload),
    };
}

function decodePaymentRequirementsHeader(value: string | null): PaymentRequirements | null {
    if (!value) return null;
    try {
        const decoded = atob(value);
        const parsed = JSON.parse(decoded) as PaymentRequirements;
        if (parsed && typeof parsed === 'object' && typeof parsed.receiver === 'string' && typeof parsed.amount === 'string') {
            return parsed;
        }
    } catch {
        return null;
    }
    return null;
}

// Fetch alpha cards (x402 enforced)
export async function fetchAlphaCards(
    params: { source?: string; window?: string; n?: number },
    paymentProof?: string,
    callerAddress?: string
): Promise<FetchAlphaCardsResult> {
    const searchParams = new URLSearchParams();
    if (params.source) searchParams.set('source', params.source);
    if (params.window) searchParams.set('window', params.window);
    if (params.n) searchParams.set('n', String(params.n));

    const headers: Record<string, string> = {};
    if (paymentProof) {
        headers['X-Payment'] = paymentProof;
        if (callerAddress && callerAddress.trim().length > 0) {
            headers['X-Caller-Address'] = callerAddress.trim();
        }
    }

    const res = await fetch(`${API_BASE}/v1/alpha/cards?${searchParams}`, { headers });

    if (res.status === 402) {
        const data = await res.json() as {
            paymentRequirements?: PaymentRequirements;
            reason?: string;
            message?: string;
        };
        const fromHeader = decodePaymentRequirementsHeader(res.headers.get('x-payment-required'));
        const requirements = fromHeader || data.paymentRequirements;
        if (!requirements) {
            throw new Error('Payment required but requirements payload is missing.');
        }
        return {
            state: 'payment_required',
            requirements,
            reason: data.reason,
            message: data.message,
        };
    }

    if (!res.ok) {
        throw new Error(`Failed to fetch alpha cards (HTTP ${res.status})`);
    }

    const data = await res.json() as { cards?: AlphaCard[] };
    return {
        state: 'loaded',
        cards: Array.isArray(data.cards) ? data.cards : [],
    };
}

// Get single alpha card
export async function getAlphaCard(id: string): Promise<AlphaCard | null> {
    const res = await fetch(`${API_BASE}/v1/alpha/cards/${id}`);
    if (!res.ok) return null;
    const data = await requireOkJson(res, 'Get alpha card');
    return (data.card as AlphaCard) || null;
}

// Convert alpha to campaign
export async function convertToCampaign(alphaId: string, callerAddress: string): Promise<Campaign> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { alpha_id: alphaId, owner: caller };
    const res = await fetch(`${API_BASE}/v1/campaigns/convert`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'campaign.convert', requestBody),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Convert to campaign');
    return data.campaign as Campaign;
}

// Fund campaign
export async function fundCampaign(
    campaignId: string,
    amount: number,
    txId: string | undefined,
    onchainId: number | undefined,
    callerAddress: string
): Promise<Campaign> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { amount, tx_id: txId, onchain_id: onchainId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/fund`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'campaign.fund', { campaignId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Fund campaign');
    return data.campaign as Campaign;
}

// Get all campaigns
export async function getCampaigns(): Promise<Campaign[]> {
    const res = await fetch(`${API_BASE}/v1/campaigns`);
    const data = await requireOkJson(res, 'Get campaigns');
    return (data.campaigns as Campaign[]) || [];
}

// Get single campaign
export async function getCampaign(id: string): Promise<Campaign | null> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${id}`);
    if (!res.ok) return null;
    const data = await requireOkJson(res, 'Get campaign');
    return (data.campaign as Campaign) || null;
}

// Get campaign events/audit timeline
export async function getCampaignEvents(campaignId: string): Promise<CampaignEvent[]> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/events`);
    const data = await requireOkJson(res, 'Get campaign events');
    return (data.events as CampaignEvent[]) || [];
}

// Trigger backend reconciliation worker for one campaign and return updated events
export async function reconcileCampaign(campaignId: string, callerAddress: string): Promise<CampaignEvent[]> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { campaign_id: campaignId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/reconcile`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'campaign.reconcile', requestBody),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Reconcile campaign');
    return (data.events as CampaignEvent[]) || [];
}

// Claim task
export async function claimTask(
    campaignId: string,
    taskId: string,
    callerAddress: string,
    txId: string
): Promise<Task> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'task.claim', { campaignId, taskId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Claim task');
    return data.task as Task;
}

// Submit proof
export async function submitProof(
    campaignId: string,
    taskId: string,
    callerAddress: string,
    txId: string,
    proofHash?: string,
    proofDescription?: string
): Promise<Task> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { proof_hash: proofHash, proof_description: proofDescription, tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'task.submit-proof', { campaignId, taskId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Submit proof');
    return data.task as Task;
}

// Cancel task
export async function cancelTask(
    campaignId: string,
    taskId: string,
    callerAddress: string,
    txId: string
): Promise<Task> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'task.cancel', { campaignId, taskId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Cancel task');
    return data.task as Task;
}

// Approve task
export async function approveTask(
    campaignId: string,
    taskId: string,
    callerAddress: string,
    txId: string
): Promise<Task> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/approve`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'task.approve', { campaignId, taskId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Approve task');
    return data.task as Task;
}

// Update draft task fields in campaign builder
export async function updateCampaignTask(
    campaignId: string,
    taskId: string,
    updates: TaskDraftUpdate,
    callerAddress: string
): Promise<Task> {
    const caller = requireCallerAddress(callerAddress);
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: mutationJsonHeaders(caller, 'task.update-draft', { campaignId, taskId, updates }),
        body: JSON.stringify(updates),
    });
    const data = await requireOkJson(res, 'Update campaign task');
    return data.task as Task;
}

// Close campaign
export async function closeCampaign(campaignId: string, callerAddress: string, txId: string): Promise<Campaign> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/close`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'campaign.close', { campaignId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Close campaign');
    return data.campaign as Campaign;
}

// Withdraw campaign remaining balance
export async function withdrawCampaign(
    campaignId: string,
    callerAddress: string,
    amount: number | undefined,
    txId: string
): Promise<Campaign> {
    const caller = requireCallerAddress(callerAddress);
    const requestBody = { amount, tx_id: txId };
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/withdraw`, {
        method: 'POST',
        headers: mutationJsonHeaders(caller, 'campaign.withdraw', { campaignId, ...requestBody }),
        body: JSON.stringify(requestBody),
    });
    const data = await requireOkJson(res, 'Withdraw remaining');
    return data.campaign as Campaign;
}
