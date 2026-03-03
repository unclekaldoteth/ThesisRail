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
    status: 'open' | 'claimed' | 'proof_submitted' | 'approved' | 'rejected';
    executor?: string;
    proof_hash?: string;
    proof_description?: string;
    claimed_at?: string;
    submitted_at?: string;
    approved_at?: string;
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
}

export interface X402Response {
    status: 402;
    paymentRequirements: PaymentRequirements;
}

// Fetch alpha cards (x402 enforced)
export async function fetchAlphaCards(
    params: { source?: string; window?: string; n?: number },
    paymentProof?: string
): Promise<{ cards: AlphaCard[] } | { paymentRequired: true; requirements: PaymentRequirements }> {
    const searchParams = new URLSearchParams();
    if (params.source) searchParams.set('source', params.source);
    if (params.window) searchParams.set('window', params.window);
    if (params.n) searchParams.set('n', String(params.n));

    const headers: Record<string, string> = {};
    if (paymentProof) {
        headers['X-Payment'] = paymentProof;
    }

    const res = await fetch(`${API_BASE}/v1/alpha/cards?${searchParams}`, { headers });

    if (res.status === 402) {
        const data = await res.json();
        return { paymentRequired: true, requirements: data.paymentRequirements };
    }

    const data = await res.json();
    return { cards: data.cards };
}

// Get single alpha card
export async function getAlphaCard(id: string): Promise<AlphaCard | null> {
    const res = await fetch(`${API_BASE}/v1/alpha/cards/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.card;
}

// Convert alpha to campaign
export async function convertToCampaign(alphaId: string, owner?: string): Promise<Campaign> {
    const res = await fetch(`${API_BASE}/v1/campaigns/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alpha_id: alphaId, owner }),
    });
    const data = await res.json();
    return data.campaign;
}

// Fund campaign
export async function fundCampaign(campaignId: string, amount: number, txId?: string, onchainId?: number): Promise<Campaign> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, tx_id: txId, onchain_id: onchainId }),
    });
    const data = await res.json();
    return data.campaign;
}

// Get all campaigns
export async function getCampaigns(): Promise<Campaign[]> {
    const res = await fetch(`${API_BASE}/v1/campaigns`);
    const data = await res.json();
    return data.campaigns;
}

// Get single campaign
export async function getCampaign(id: string): Promise<Campaign | null> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.campaign;
}

// Claim task
export async function claimTask(campaignId: string, taskId: string, executor?: string): Promise<Task> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executor }),
    });
    const data = await res.json();
    return data.task;
}

// Submit proof
export async function submitProof(campaignId: string, taskId: string, proofHash?: string, proofDescription?: string): Promise<Task> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proof_hash: proofHash, proof_description: proofDescription }),
    });
    const data = await res.json();
    return data.task;
}

// Approve task
export async function approveTask(campaignId: string, taskId: string): Promise<Task> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/tasks/${taskId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return data.task;
}

// Close campaign
export async function closeCampaign(campaignId: string): Promise<Campaign> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return data.campaign;
}

// Withdraw campaign remaining balance
export async function withdrawCampaign(campaignId: string, amount?: number): Promise<Campaign> {
    const res = await fetch(`${API_BASE}/v1/campaigns/${campaignId}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
    });
    const data = await res.json();
    return data.campaign;
}
