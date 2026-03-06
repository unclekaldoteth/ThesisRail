import {
    CampaignEvent,
    getCampaignEvents,
    getPendingOnchainCampaignEvents,
    updateCampaignEventOnchainStatus,
} from '../storage/store';
import {
    fetchStacksTxById,
    classifyTxLifecycleStatus,
    normalizeStacksAddress,
    parseUintReprToNumber,
    StacksTxPayload,
} from './stacksApi';

export interface ReconcileSummary {
    checked: number;
    updated: number;
    confirmed: number;
    failed: number;
    pending: number;
}

let reconcilerTimer: NodeJS.Timeout | null = null;

function getExpectedContractId(): string | null {
    const address = process.env.CONTRACT_ADDRESS?.trim();
    const name = process.env.CONTRACT_NAME?.trim();
    if (!address || !name) return null;
    return `${address}.${name}`;
}

function getFailureReasonForConfirmedTx(event: CampaignEvent, tx: StacksTxPayload): string | null {
    if (tx.tx_type !== 'contract_call') {
        return 'Expected contract-call transaction';
    }

    if (event.expected_sender && normalizeStacksAddress(tx.sender_address || '') !== normalizeStacksAddress(event.expected_sender)) {
        return 'Transaction sender does not match expected caller';
    }

    const contractCall = tx.contract_call;
    if (!contractCall) {
        return 'Contract call payload is missing';
    }

    if (event.expected_function && contractCall.function_name !== event.expected_function) {
        return 'Contract function does not match expected action';
    }

    const expectedContractId = getExpectedContractId();
    if (expectedContractId && contractCall.contract_id !== expectedContractId) {
        return 'Contract id does not match configured escrow contract';
    }

    const args = Array.isArray(contractCall.function_args) ? contractCall.function_args : [];
    if (event.expected_campaign_onchain_id) {
        const parsedCampaignId = parseUintReprToNumber(args[0]?.repr);
        if (!parsedCampaignId || parsedCampaignId !== event.expected_campaign_onchain_id) {
            return 'Onchain campaign id argument mismatch';
        }
    }

    if (event.expected_task_onchain_id) {
        const parsedTaskId = parseUintReprToNumber(args[1]?.repr);
        if (!parsedTaskId || parsedTaskId !== event.expected_task_onchain_id) {
            return 'Onchain task id argument mismatch';
        }
    }

    return null;
}

async function reconcileEvent(event: CampaignEvent): Promise<'confirmed' | 'failed' | 'pending' | 'no_change'> {
    if (!event.tx_id) return 'no_change';

    const tx = await fetchStacksTxById(event.tx_id);
    const lifecycle = classifyTxLifecycleStatus(tx);

    if (lifecycle === 'pending' || lifecycle === 'not_found') {
        return 'pending';
    }

    if (lifecycle === 'failed') {
        updateCampaignEventOnchainStatus(
            event.campaign_id,
            event.id,
            'failed',
            tx?.tx_status || 'Onchain tx failed'
        );
        return 'failed';
    }

    const failureReason = tx ? getFailureReasonForConfirmedTx(event, tx) : 'Transaction not found';
    if (failureReason) {
        updateCampaignEventOnchainStatus(event.campaign_id, event.id, 'failed', failureReason);
        return 'failed';
    }

    updateCampaignEventOnchainStatus(event.campaign_id, event.id, 'confirmed');
    return 'confirmed';
}

async function reconcileEvents(events: CampaignEvent[]): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
        checked: 0,
        updated: 0,
        confirmed: 0,
        failed: 0,
        pending: 0,
    };

    for (const event of events) {
        summary.checked += 1;
        const result = await reconcileEvent(event);
        if (result === 'pending') {
            summary.pending += 1;
            continue;
        }
        if (result === 'confirmed') {
            summary.updated += 1;
            summary.confirmed += 1;
            continue;
        }
        if (result === 'failed') {
            summary.updated += 1;
            summary.failed += 1;
            continue;
        }
    }

    return summary;
}

export async function reconcilePendingCampaignEvents(limit = 100): Promise<ReconcileSummary> {
    const events = getPendingOnchainCampaignEvents(limit);
    return reconcileEvents(events);
}

export async function reconcileCampaignEvents(campaignId: string, limit = 100): Promise<ReconcileSummary> {
    const events = getCampaignEvents(campaignId)
        .filter((event) => event.tx_id && event.onchain_status === 'pending')
        .slice(0, Math.max(1, limit));
    return reconcileEvents(events);
}

export function startOnchainReconciler(): void {
    if (process.env.RECONCILER_ENABLED === 'false') return;
    if (reconcilerTimer) return;

    const intervalMsRaw = Number.parseInt(process.env.RECONCILER_INTERVAL_MS || '15000', 10);
    const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0 ? intervalMsRaw : 15000;

    reconcilerTimer = setInterval(() => {
        void reconcilePendingCampaignEvents().catch((error) => {
            console.error('[Reconciler] Background reconcile failed:', error);
        });
    }, intervalMs);

    void reconcilePendingCampaignEvents().catch((error) => {
        console.error('[Reconciler] Initial reconcile failed:', error);
    });

    console.log(`[Reconciler] Started (interval=${intervalMs}ms)`);
}

export function stopOnchainReconciler(): void {
    if (!reconcilerTimer) return;
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
}
