/**
 * In-Memory Storage Layer
 * Simple Map-based storage for hackathon demo — no database required.
 */

import { AlphaCard } from '../scoring/alphaScorer';

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

// In-memory stores
const alphaCards = new Map<string, AlphaCard>();
const alphaCardsByQuery = new Map<string, { cards: AlphaCard[]; cached_at: number }>();
const campaigns = new Map<string, Campaign>();

// Alpha Cards
export function storeAlphaCards(cards: AlphaCard[]): void {
    cards.forEach((card) => alphaCards.set(card.id, card));
}

export function getAlphaCard(id: string): AlphaCard | undefined {
    return alphaCards.get(id);
}

export function getAllAlphaCards(): AlphaCard[] {
    return Array.from(alphaCards.values());
}

export function buildAlphaCacheKey(source: string, window: string, n: number): string {
    return `${source}|${window}|${n}`;
}

export function storeAlphaCardsForQuery(cacheKey: string, cards: AlphaCard[]): void {
    alphaCardsByQuery.set(cacheKey, { cards, cached_at: Date.now() });
}

export function getAlphaCardsForQuery(cacheKey: string): { cards: AlphaCard[]; cached_at: number } | undefined {
    return alphaCardsByQuery.get(cacheKey);
}

export function isAlphaQueryCached(cacheKey: string, maxAgeMs: number): boolean {
    const cached = alphaCardsByQuery.get(cacheKey);
    if (!cached) return false;
    return Date.now() - cached.cached_at <= maxAgeMs;
}

// Campaigns
export function storeCampaign(campaign: Campaign): void {
    campaigns.set(campaign.id, campaign);
}

export function getCampaign(id: string): Campaign | undefined {
    return campaigns.get(id);
}

export function getAllCampaigns(): Campaign[] {
    return Array.from(campaigns.values());
}

export function updateCampaign(id: string, updates: Partial<Campaign>): Campaign | undefined {
    const campaign = campaigns.get(id);
    if (!campaign) return undefined;
    const updated = { ...campaign, ...updates };
    campaigns.set(id, updated);
    return updated;
}

// Tasks within campaigns
export function updateTask(campaignId: string, taskId: string, updates: Partial<Task>): Task | undefined {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return undefined;

    const taskIndex = campaign.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return undefined;

    campaign.tasks[taskIndex] = { ...campaign.tasks[taskIndex], ...updates };
    campaigns.set(campaignId, campaign);
    return campaign.tasks[taskIndex];
}
