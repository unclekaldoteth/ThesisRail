/**
 * File-Backed Storage Layer
 * Uses in-memory maps for runtime speed and persists snapshots to JSON on mutation.
 */

import fs from 'node:fs';
import path from 'node:path';
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
    fund_tx_id?: string;
}

export type OnchainSyncStatus = 'unknown' | 'pending' | 'confirmed' | 'failed';

export interface CampaignEvent {
    id: string;
    campaign_id: string;
    task_id?: string;
    actor?: string;
    event_type: string;
    message: string;
    tx_id?: string;
    expected_function?: string;
    expected_sender?: string;
    expected_campaign_onchain_id?: number;
    expected_task_onchain_id?: number;
    onchain_status: OnchainSyncStatus;
    onchain_reason?: string;
    created_at: string;
    updated_at: string;
}

export interface CampaignEventInput {
    campaign_id: string;
    task_id?: string;
    actor?: string;
    event_type: string;
    message: string;
    tx_id?: string;
    expected_function?: string;
    expected_sender?: string;
    expected_campaign_onchain_id?: number;
    expected_task_onchain_id?: number;
    onchain_status?: OnchainSyncStatus;
    onchain_reason?: string;
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

interface AlphaQueryCache {
    cards: AlphaCard[];
    cached_at: number;
}

interface PersistedStateV1 {
    version: 1;
    alpha_cards: Record<string, AlphaCard>;
    alpha_cards_by_query: Record<string, AlphaQueryCache>;
    campaigns: Record<string, Campaign>;
    campaign_events: Record<string, CampaignEvent[]>;
}

const DEFAULT_STATE: PersistedStateV1 = {
    version: 1,
    alpha_cards: {},
    alpha_cards_by_query: {},
    campaigns: {},
    campaign_events: {},
};

// Runtime stores
const alphaCards = new Map<string, AlphaCard>();
const alphaCardsByQuery = new Map<string, AlphaQueryCache>();
const campaigns = new Map<string, Campaign>();
const campaignEventsByCampaign = new Map<string, CampaignEvent[]>();
let initialized = false;
let resolvedStorageFile = '';

function resolveStorageFile(): string {
    const configured = process.env.STORAGE_FILE?.trim();
    if (configured && configured.length > 0) return path.resolve(configured);
    return path.resolve(process.cwd(), 'data', 'store.json');
}

function ensureStorageDirectory(filePath: string): void {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
}

function loadFromDisk(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<PersistedStateV1>;

        alphaCards.clear();
        alphaCardsByQuery.clear();
        campaigns.clear();
        campaignEventsByCampaign.clear();

        const alphaRecord = parsed.alpha_cards || {};
        Object.entries(alphaRecord).forEach(([id, card]) => {
            alphaCards.set(id, card);
        });

        const queryRecord = parsed.alpha_cards_by_query || {};
        Object.entries(queryRecord).forEach(([cacheKey, entry]) => {
            if (!entry || !Array.isArray(entry.cards) || typeof entry.cached_at !== 'number') return;
            alphaCardsByQuery.set(cacheKey, entry);
        });

        const campaignRecord = parsed.campaigns || {};
        Object.entries(campaignRecord).forEach(([id, campaign]) => {
            campaigns.set(id, campaign);
        });

        const eventRecord = parsed.campaign_events || {};
        Object.entries(eventRecord).forEach(([campaignId, events]) => {
            if (!Array.isArray(events)) return;
            campaignEventsByCampaign.set(
                campaignId,
                events
                    .filter((event): event is CampaignEvent => Boolean(event && typeof event === 'object'))
                    .map((event) => ({
                        ...event,
                        onchain_status: event.onchain_status || 'unknown',
                        updated_at: event.updated_at || event.created_at || new Date().toISOString(),
                    }))
            );
        });
    } catch (error) {
        console.error('[Storage] Failed to load state file, starting with empty store:', error);
    }
}

function ensureInitialized(): void {
    if (initialized) return;
    resolvedStorageFile = resolveStorageFile();
    ensureStorageDirectory(resolvedStorageFile);
    loadFromDisk(resolvedStorageFile);
    initialized = true;
}

function buildSnapshot(): PersistedStateV1 {
    const alpha_cards: Record<string, AlphaCard> = {};
    alphaCards.forEach((value, key) => {
        alpha_cards[key] = value;
    });

    const alpha_cards_by_query: Record<string, AlphaQueryCache> = {};
    alphaCardsByQuery.forEach((value, key) => {
        alpha_cards_by_query[key] = value;
    });

    const campaignMap: Record<string, Campaign> = {};
    campaigns.forEach((value, key) => {
        campaignMap[key] = value;
    });

    const campaign_events: Record<string, CampaignEvent[]> = {};
    campaignEventsByCampaign.forEach((value, key) => {
        campaign_events[key] = value;
    });

    return {
        version: 1,
        alpha_cards,
        alpha_cards_by_query,
        campaigns: campaignMap,
        campaign_events,
    };
}

function persistState(): void {
    ensureInitialized();
    const snapshot = buildSnapshot();
    const tempPath = `${resolvedStorageFile}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tempPath, resolvedStorageFile);
}

// Alpha Cards
export function storeAlphaCards(cards: AlphaCard[]): void {
    ensureInitialized();
    cards.forEach((card) => alphaCards.set(card.id, card));
    persistState();
}

export function getAlphaCard(id: string): AlphaCard | undefined {
    ensureInitialized();
    return alphaCards.get(id);
}

export function getAllAlphaCards(): AlphaCard[] {
    ensureInitialized();
    return Array.from(alphaCards.values());
}

export function buildAlphaCacheKey(source: string, window: string, n: number): string {
    return `${source}|${window}|${n}`;
}

export function storeAlphaCardsForQuery(cacheKey: string, cards: AlphaCard[]): void {
    ensureInitialized();
    alphaCardsByQuery.set(cacheKey, { cards, cached_at: Date.now() });
    persistState();
}

export function getAlphaCardsForQuery(cacheKey: string): { cards: AlphaCard[]; cached_at: number } | undefined {
    ensureInitialized();
    return alphaCardsByQuery.get(cacheKey);
}

export function isAlphaQueryCached(cacheKey: string, maxAgeMs: number): boolean {
    ensureInitialized();
    const cached = alphaCardsByQuery.get(cacheKey);
    if (!cached) return false;
    return Date.now() - cached.cached_at <= maxAgeMs;
}

// Campaigns
export function storeCampaign(campaign: Campaign): void {
    ensureInitialized();
    campaigns.set(campaign.id, campaign);
    persistState();
}

export function getCampaign(id: string): Campaign | undefined {
    ensureInitialized();
    return campaigns.get(id);
}

export function getAllCampaigns(): Campaign[] {
    ensureInitialized();
    return Array.from(campaigns.values());
}

export function updateCampaign(id: string, updates: Partial<Campaign>): Campaign | undefined {
    ensureInitialized();
    const campaign = campaigns.get(id);
    if (!campaign) return undefined;
    const updated = { ...campaign, ...updates };
    campaigns.set(id, updated);
    persistState();
    return updated;
}

// Tasks within campaigns
export function updateTask(campaignId: string, taskId: string, updates: Partial<Task>): Task | undefined {
    ensureInitialized();
    const campaign = campaigns.get(campaignId);
    if (!campaign) return undefined;

    const taskIndex = campaign.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return undefined;

    campaign.tasks[taskIndex] = { ...campaign.tasks[taskIndex], ...updates };
    campaigns.set(campaignId, campaign);
    persistState();
    return campaign.tasks[taskIndex];
}

export function resetStorageForTests(): void {
    ensureInitialized();
    alphaCards.clear();
    alphaCardsByQuery.clear();
    campaigns.clear();
    campaignEventsByCampaign.clear();
    const snapshot = JSON.stringify(DEFAULT_STATE, null, 2);
    fs.writeFileSync(resolvedStorageFile, snapshot, 'utf8');
}

export function appendCampaignEvent(input: CampaignEventInput): CampaignEvent {
    ensureInitialized();
    const now = new Date().toISOString();
    const event: CampaignEvent = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        campaign_id: input.campaign_id,
        task_id: input.task_id,
        actor: input.actor,
        event_type: input.event_type,
        message: input.message,
        tx_id: input.tx_id,
        expected_function: input.expected_function,
        expected_sender: input.expected_sender,
        expected_campaign_onchain_id: input.expected_campaign_onchain_id,
        expected_task_onchain_id: input.expected_task_onchain_id,
        onchain_status: input.onchain_status || 'unknown',
        onchain_reason: input.onchain_reason,
        created_at: now,
        updated_at: now,
    };
    const current = campaignEventsByCampaign.get(input.campaign_id) || [];
    current.push(event);
    campaignEventsByCampaign.set(input.campaign_id, current);
    persistState();
    return event;
}

export function getCampaignEvents(campaignId: string): CampaignEvent[] {
    ensureInitialized();
    return (campaignEventsByCampaign.get(campaignId) || [])
        .slice()
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getAllCampaignEvents(): CampaignEvent[] {
    ensureInitialized();
    return Array.from(campaignEventsByCampaign.values()).flat();
}

export function getPendingOnchainCampaignEvents(limit = 100): CampaignEvent[] {
    ensureInitialized();
    const pending = getAllCampaignEvents()
        .filter((event) => event.tx_id && event.onchain_status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return pending.slice(0, Math.max(1, limit));
}

export function updateCampaignEventOnchainStatus(
    campaignId: string,
    eventId: string,
    status: OnchainSyncStatus,
    reason?: string
): CampaignEvent | undefined {
    ensureInitialized();
    const current = campaignEventsByCampaign.get(campaignId);
    if (!current || current.length === 0) return undefined;

    const eventIndex = current.findIndex((event) => event.id === eventId);
    if (eventIndex === -1) return undefined;

    const updated: CampaignEvent = {
        ...current[eventIndex],
        onchain_status: status,
        onchain_reason: reason,
        updated_at: new Date().toISOString(),
    };
    current[eventIndex] = updated;
    campaignEventsByCampaign.set(campaignId, current);
    persistState();
    return updated;
}
