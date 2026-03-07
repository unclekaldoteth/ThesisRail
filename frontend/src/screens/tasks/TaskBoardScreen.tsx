'use client';

import { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/components/ClientProviders';
import {
    cancelTask,
    getCampaigns,
    getCampaignEvents,
    reconcileCampaign,
    claimTask,
    submitProof,
    approveTask,
    closeCampaign,
    withdrawCampaign,
    Campaign,
    CampaignEvent,
    Task,
} from '@/lib/api';

function TaskStatusBadge({ status }: { status: string }) {
    const labels: Record<string, string> = {
        open: '● Open',
        claimed: '◐ Claimed',
        proof_submitted: '◑ Proof Submitted',
        approved: '✓ Approved',
        cancelled: '× Cancelled',
    };
    return <span className={`task-status ${status}`}>{labels[status] || status}</span>;
}

type OnchainAction = 'claim' | 'submit' | 'approve' | 'cancel';
type OnchainStage = 'idle' | 'broadcasted' | 'confirmed' | 'failed';
type TxWaitOutcome = 'success' | 'failed' | 'pending';

interface OnchainTxState {
    status: OnchainStage;
    txId?: string;
    note?: string;
}

type TaskOnchainMap = Record<OnchainAction, OnchainTxState>;

const DEFAULT_ONCHAIN_STATE: TaskOnchainMap = {
    claim: { status: 'idle' },
    submit: { status: 'idle' },
    approve: { status: 'idle' },
    cancel: { status: 'idle' },
};

const EXPLORER_BASE = 'https://explorer.hiro.so';
const EXPLORER_CHAIN = (process.env.NEXT_PUBLIC_NETWORK || 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';

function toStatusRank(status: Task['status']): number {
    switch (status) {
        case 'open': return 0;
        case 'claimed': return 1;
        case 'proof_submitted': return 2;
        case 'approved': return 3;
        case 'cancelled': return -1;
        default: return 0;
    }
}

function MilestoneFlow({ status }: { status: Task['status'] }) {
    if (status === 'cancelled') {
        return (
            <div className="stage-flow">
                <span className="stage-chip cancelled">Cancelled</span>
            </div>
        );
    }

    const rank = toStatusRank(status);
    const steps = [
        { key: 'open', label: 'Open', rank: 0 },
        { key: 'claimed', label: 'Claimed', rank: 1 },
        { key: 'proof_submitted', label: 'Proof', rank: 2 },
        { key: 'approved', label: 'Paid', rank: 3 },
    ] as const;

    return (
        <div className="stage-flow">
            {steps.map((step) => {
                const stateClass = rank > step.rank ? 'done' : rank === step.rank ? 'active' : 'pending';
                return (
                    <span key={step.key} className={`stage-chip ${stateClass}`}>
                        {step.label}
                    </span>
                );
            })}
        </div>
    );
}

function TxStatusRow({
    txState,
}: {
    txState: TaskOnchainMap;
}) {
    const rows: Array<{ key: OnchainAction; label: string }> = [
        { key: 'claim', label: 'Claim Task' },
        { key: 'submit', label: 'Submit Proof' },
        { key: 'approve', label: 'Approve & Pay' },
        { key: 'cancel', label: 'Cancel Task' },
    ];

    return (
        <div className="tx-status-wrap">
            {rows.map((row) => {
                const entry = txState[row.key];
                const txId = entry.txId?.startsWith('0x') ? entry.txId : entry.txId ? `0x${entry.txId}` : '';
                return (
                    <div key={row.key} className="tx-status-row">
                        <span className="tx-label">{row.label}</span>
                        <span className={`tx-chip ${entry.status}`}>
                            {entry.status === 'idle' && 'idle'}
                            {entry.status === 'broadcasted' && 'broadcasted'}
                            {entry.status === 'confirmed' && 'confirmed'}
                            {entry.status === 'failed' && 'failed'}
                        </span>
                        {txId && (
                            <a
                                href={`${EXPLORER_BASE}/txid/${txId}?chain=${EXPLORER_CHAIN}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="tx-link"
                            >
                                {txId.substring(0, 10)}...
                            </a>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function TaskCardComponent({
    task,
    campaign,
    role,
    callerAddress,
    onAction,
    txState,
    onTrackTx,
}: {
    task: Task;
    campaign: Campaign;
    role: 'owner' | 'executor';
    callerAddress: string | null;
    onAction: () => Promise<void>;
    txState: TaskOnchainMap;
    onTrackTx: (taskId: string, action: OnchainAction, txId: string) => Promise<TxWaitOutcome>;
}) {
    const [proofInput, setProofInput] = useState('');
    const [actionLoading, setActionLoading] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const campaignRunnable = campaign.status === 'funded' || campaign.status === 'active';
    const normalizedCaller = callerAddress?.trim().toUpperCase() ?? null;
    const normalizedOwner = campaign.owner?.trim().toUpperCase() ?? null;
    const normalizedExecutor = task.executor?.trim().toUpperCase() ?? null;

    const handleClaim = async () => {
        setActionLoading(true);
        setActionError(null);
        try {
            if (!callerAddress) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (normalizedCaller && normalizedOwner && normalizedCaller === normalizedOwner) {
                throw new Error('Owner wallet cannot claim tasks. Switch to a different executor wallet.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callClaimTask } = await import('@/lib/wallet');
            const onchainTaskId = Math.max(campaign.tasks.findIndex((t) => t.id === task.id) + 1, 1);
            const txId = await callClaimTask(campaign.onchain_id, onchainTaskId);
            if (!txId) {
                throw new Error('claim-task transaction failed.');
            }
            const outcome = await onTrackTx(task.id, 'claim', txId);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Claim transaction is still pending onchain. Retry after confirmation.'
                        : 'Claim transaction failed onchain. Retry Claim Task.'
                );
            }
            await claimTask(campaign.id, task.id, callerAddress, txId);
            await onAction();
        } catch (e) {
            console.error(e);
            setActionError(e instanceof Error ? e.message : 'Claim failed.');
        } finally {
            setActionLoading(false);
        }
    };

    const handleSubmitProof = async () => {
        setActionLoading(true);
        setActionError(null);
        try {
            if (!callerAddress) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (normalizedExecutor && normalizedCaller && normalizedExecutor !== normalizedCaller) {
                throw new Error('Task is claimed by another executor wallet.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callSubmitProof } = await import('@/lib/wallet');
            const onchainTaskId = Math.max(campaign.tasks.findIndex((t) => t.id === task.id) + 1, 1);
            const proofText = proofInput || 'Deliverable completed';
            const txId = await callSubmitProof(campaign.onchain_id, onchainTaskId, proofText);
            if (!txId) {
                throw new Error('submit-proof transaction failed.');
            }
            const outcome = await onTrackTx(task.id, 'submit', txId);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Submit Proof transaction is still pending onchain. Retry after confirmation.'
                        : 'Submit Proof transaction failed onchain. Retry Submit Proof.'
                );
            }
            await submitProof(campaign.id, task.id, callerAddress, txId, undefined, proofText);
            await onAction();
        } catch (e) {
            console.error(e);
            setActionError(e instanceof Error ? e.message : 'Submit Proof failed.');
        } finally {
            setActionLoading(false);
        }
    };

    const handleApprove = async () => {
        setActionLoading(true);
        setActionError(null);
        try {
            if (!callerAddress) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (normalizedCaller && normalizedOwner && normalizedCaller !== normalizedOwner) {
                throw new Error('Only the campaign owner wallet can approve tasks.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            // Call onchain approve
            const { callApproveTask } = await import('@/lib/wallet');
            const onchainTaskId = Math.max(campaign.tasks.findIndex((t) => t.id === task.id) + 1, 1);
            const txId = await callApproveTask(campaign.onchain_id, onchainTaskId);
            if (!txId) {
                throw new Error('approve-task transaction failed.');
            }
            const outcome = await onTrackTx(task.id, 'approve', txId);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Approve transaction is still pending onchain. Retry after confirmation.'
                        : 'Approve transaction failed onchain. Retry Approve & Pay.'
                );
            }
            // Update backend
            await approveTask(campaign.id, task.id, callerAddress, txId);
            await onAction();
        } catch (e) {
            console.error(e);
            setActionError(e instanceof Error ? e.message : 'Approve & Pay failed.');
        } finally {
            setActionLoading(false);
        }
    };

    const handleCancelTask = async () => {
        setActionLoading(true);
        setActionError(null);
        try {
            if (!callerAddress) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (normalizedCaller && normalizedOwner && normalizedCaller !== normalizedOwner) {
                throw new Error('Only the campaign owner wallet can cancel tasks.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callCancelTask } = await import('@/lib/wallet');
            const onchainTaskId = Math.max(campaign.tasks.findIndex((t) => t.id === task.id) + 1, 1);
            const txId = await callCancelTask(campaign.onchain_id, onchainTaskId);
            if (!txId) {
                throw new Error('cancel-task transaction failed.');
            }
            const outcome = await onTrackTx(task.id, 'cancel', txId);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Cancel transaction is still pending onchain. Retry after confirmation.'
                        : 'Cancel transaction failed onchain. Task can only be cancelled after its deadline.'
                );
            }
            await cancelTask(campaign.id, task.id, callerAddress, txId);
            await onAction();
        } catch (e) {
            console.error(e);
            setActionError(e instanceof Error ? e.message : 'Cancel task failed.');
        } finally {
            setActionLoading(false);
        }
    };

    return (
        <div className="task-card">
            <div className="task-header">
                <div>
                    <h3 style={{ fontSize: '0.95rem', marginBottom: '4px' }}>{task.title}</h3>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                        Campaign: {campaign.title.substring(0, 50)}...
                    </span>
                    {task.milestone && (
                        <div style={{ marginTop: '6px' }}>
                            <span className="task-status open">{task.milestone}</span>
                        </div>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="task-payout">{(task.payout / 1000000).toFixed(2)} USDCx</span>
                    <TaskStatusBadge status={task.status} />
                </div>
            </div>

            <p className="task-description">{task.description}</p>

            <div style={{
                display: 'flex', gap: '16px',
                fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-tertiary)',
                marginBottom: '16px',
            }}>
                <span>Deadline: {new Date(task.deadline).toLocaleDateString()}</span>
                <span>Criteria: {task.acceptance_criteria.substring(0, 80)}...</span>
                {task.executor && <span>Executor: {task.executor.substring(0, 10)}...</span>}
            </div>

            <MilestoneFlow status={task.status} />
            <TxStatusRow txState={txState} />

            {/* Proof display */}
            {task.proof_description && (
                <div className="card" style={{ background: 'var(--accent-secondary-dim)', marginBottom: '12px', padding: '12px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--accent-secondary)' }}>PROOF:</span>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '4px' }}>{task.proof_description}</p>
                </div>
            )}

            {/* Payout confirmation */}
            {task.status === 'approved' && (
                <div className="card" style={{ background: 'var(--accent-primary-dim)', padding: '12px', marginBottom: '12px' }}>
                    <p style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                        Payout of {(task.payout / 1000000).toFixed(2)} USDCx transferred to executor
                    </p>
                    {task.approved_at && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                            Approved: {new Date(task.approved_at).toLocaleString()}
                        </span>
                    )}
                </div>
            )}

            {task.status === 'cancelled' && (
                <div className="card" style={{ background: 'var(--accent-danger-dim)', padding: '12px', marginBottom: '12px' }}>
                    <p style={{ color: 'var(--accent-danger)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                        Task cancelled. Reserved payout was released back to campaign escrow.
                    </p>
                    {task.cancelled_at && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                            Cancelled: {new Date(task.cancelled_at).toLocaleString()}
                        </span>
                    )}
                </div>
            )}

            {/* Actions based on role and status */}
            <div className="task-actions">
                {/* Executor: Claim */}
                {role === 'executor' && task.status === 'open' && campaignRunnable && (
                    <button className="btn btn-primary btn-sm" onClick={handleClaim} disabled={actionLoading}>
                        {actionLoading ? '...' : 'Claim Task'}
                    </button>
                )}

                {/* Executor: Submit Proof */}
                {role === 'executor' && task.status === 'claimed' && campaignRunnable && (
                    <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
                        <input
                            className="form-input"
                            placeholder="Describe your deliverable..."
                            value={proofInput}
                            onChange={(e) => setProofInput(e.target.value)}
                            style={{ flex: 1, fontSize: '0.8rem' }}
                        />
                        <button className="btn btn-primary btn-sm" onClick={handleSubmitProof} disabled={actionLoading}>
                            {actionLoading ? '...' : 'Submit Proof'}
                        </button>
                    </div>
                )}

                {/* Owner: Approve */}
                {role === 'owner' && task.status === 'proof_submitted' && campaignRunnable && (
                    <button className="btn btn-primary btn-sm" onClick={handleApprove} disabled={actionLoading}>
                        {actionLoading ? '...' : 'Approve & Pay'}
                    </button>
                )}

                {/* Owner: Cancel expired open task */}
                {role === 'owner' && task.status === 'open' && campaignRunnable && (
                    <button className="btn btn-secondary btn-sm" onClick={handleCancelTask} disabled={actionLoading}>
                        {actionLoading ? '...' : 'Cancel Expired Task'}
                    </button>
                )}
            </div>
            {actionError && (
                <p style={{ marginTop: '8px', color: 'var(--accent-danger)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                    {actionError}
                </p>
            )}
        </div>
    );
}

export default function TaskBoardPage() {
    const { role, setRole, address } = useWallet();
    const router = useRouter();
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [campaignActionLoading, setCampaignActionLoading] = useState<string | null>(null);
    const [campaignActionMessage, setCampaignActionMessage] = useState<string | null>(null);
    const [campaignActionError, setCampaignActionError] = useState<string | null>(null);
    const [taskTxState, setTaskTxState] = useState<Record<string, TaskOnchainMap>>({});
    const [campaignEvents, setCampaignEvents] = useState<Record<string, CampaignEvent[]>>({});

    const updateTaskTxState = useCallback((taskId: string, action: OnchainAction, update: Partial<OnchainTxState>) => {
        setTaskTxState((prev) => {
            const current = prev[taskId] || DEFAULT_ONCHAIN_STATE;
            return {
                ...prev,
                [taskId]: {
                    ...current,
                    [action]: {
                        ...current[action],
                        ...update,
                    },
                },
            };
        });
    }, []);

    const trackOnchainTx = useCallback(async (taskId: string, action: OnchainAction, txId: string): Promise<TxWaitOutcome> => {
        updateTaskTxState(taskId, action, {
            status: 'broadcasted',
            txId,
            note: 'Broadcasted',
        });

        const { waitForTxSuccess } = await import('@/lib/wallet');
        const outcome = await waitForTxSuccess(txId, 90000, 3000);
        if (outcome === 'success') {
            updateTaskTxState(taskId, action, { status: 'confirmed', note: 'Confirmed onchain' });
            return 'success';
        }
        if (outcome === 'failed') {
            updateTaskTxState(taskId, action, { status: 'failed', note: 'Execution failed onchain' });
            return 'failed';
        }
        updateTaskTxState(taskId, action, { status: 'failed', note: 'No confirmation within timeout window' });
        return 'pending';
    }, [updateTaskTxState]);

    const handleTrackTx = useCallback(async (taskId: string, action: OnchainAction, txId: string) => {
        return trackOnchainTx(taskId, action, txId);
    }, [trackOnchainTx]);

    const loadEventsByCampaign = useCallback(async (items: Campaign[]): Promise<Record<string, CampaignEvent[]>> => {
        const eligible = items.filter((campaign) => campaign.status !== 'draft');
        if (eligible.length === 0) return {};

        const entries = await Promise.all(
            eligible.map(async (campaign) => {
                try {
                    const events = await getCampaignEvents(campaign.id);
                    return [campaign.id, events] as const;
                } catch (error) {
                    console.error(`Failed to load events for campaign ${campaign.id}:`, error);
                    return [campaign.id, []] as const;
                }
            })
        );
        return Object.fromEntries(entries);
    }, []);

    const loadData = useCallback(async () => {
        try {
            const data = await getCampaigns();
            const eventsByCampaign = await loadEventsByCampaign(data);
            startTransition(() => {
                setCampaigns(data);
                setCampaignEvents(eventsByCampaign);
            });
        } catch (error) {
            console.error('Failed to refresh campaigns:', error);
        }
    }, [loadEventsByCampaign]);

    useEffect(() => {
        let cancelled = false;

        const loadInitialData = async () => {
            try {
                const data = await getCampaigns();
                const eventsByCampaign = await loadEventsByCampaign(data);
                if (cancelled) return;
                startTransition(() => {
                    setCampaigns(data);
                    setCampaignEvents(eventsByCampaign);
                    setLoading(false);
                });
            } catch (error) {
                console.error('Failed to load campaigns:', error);
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [loadEventsByCampaign]);

    const allTasks = useMemo(() => (
        campaigns.flatMap((c) => c.tasks.map((t) => ({ task: t, campaign: c })))
    ), [campaigns]);

    const filteredTasks = useMemo(() => (
        role === 'executor'
            ? allTasks.filter(
                ({ task, campaign }) =>
                    ['funded', 'active'].includes(campaign.status) && ['open', 'claimed'].includes(task.status)
            )
            : allTasks
    ), [allTasks, role]);

    const ownerCampaigns = useMemo(
        () => campaigns.filter((campaign) => campaign.status !== 'draft'),
        [campaigns]
    );

    const handleCloseCampaign = async (campaign: Campaign) => {
        setCampaignActionLoading(`close-${campaign.id}`);
        setCampaignActionError(null);
        setCampaignActionMessage('Broadcasting close-campaign transaction...');
        try {
            if (!address) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callCloseCampaign, waitForTxSuccess } = await import('@/lib/wallet');
            const txId = await callCloseCampaign(campaign.onchain_id);
            if (!txId) {
                throw new Error('close-campaign transaction failed.');
            }
            const outcome = await waitForTxSuccess(txId, 90000, 3000);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Close campaign transaction is still pending. Retry after confirmation.'
                        : 'Close campaign transaction failed onchain. Retry Close Campaign.'
                );
            }
            setCampaignActionMessage('Close confirmed onchain. Syncing backend state...');
            await closeCampaign(campaign.id, address, txId);
            await loadData();
            setCampaignActionMessage('Campaign closed successfully.');
        } catch (error) {
            console.error(error);
            setCampaignActionError(error instanceof Error ? error.message : 'Close campaign failed.');
        } finally {
            setCampaignActionLoading(null);
        }
    };

    const handleWithdrawCampaign = async (campaign: Campaign) => {
        setCampaignActionLoading(`withdraw-${campaign.id}`);
        setCampaignActionError(null);
        setCampaignActionMessage('Broadcasting withdraw-remaining transaction...');
        try {
            if (!address) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callWithdrawRemaining, waitForTxSuccess } = await import('@/lib/wallet');
            const txId = await callWithdrawRemaining(campaign.onchain_id, campaign.remaining_balance);
            if (!txId) {
                throw new Error('withdraw-remaining transaction failed.');
            }
            const outcome = await waitForTxSuccess(txId, 90000, 3000);
            if (outcome !== 'success') {
                throw new Error(
                    outcome === 'pending'
                        ? 'Withdraw transaction is still pending. Retry after confirmation.'
                        : 'Withdraw transaction failed onchain. Retry Withdraw Remaining.'
                );
            }
            setCampaignActionMessage('Withdraw confirmed onchain. Syncing backend state...');
            await withdrawCampaign(campaign.id, address, campaign.remaining_balance, txId);
            await loadData();
            setCampaignActionMessage('Remaining escrow withdrawn successfully.');
        } catch (error) {
            console.error(error);
            setCampaignActionError(error instanceof Error ? error.message : 'Withdraw remaining failed.');
        } finally {
            setCampaignActionLoading(null);
        }
    };

    const handleReconcileCampaign = async (campaign: Campaign) => {
        setCampaignActionLoading(`reconcile-${campaign.id}`);
        setCampaignActionError(null);
        setCampaignActionMessage('Reconciling onchain timeline status...');
        try {
            if (!address) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            const events = await reconcileCampaign(campaign.id, address);
            startTransition(() => {
                setCampaignEvents((prev) => ({ ...prev, [campaign.id]: events }));
            });
            setCampaignActionMessage('Onchain timeline sync completed.');
        } catch (error) {
            console.error(error);
            setCampaignActionError(error instanceof Error ? error.message : 'Reconciliation failed.');
        } finally {
            setCampaignActionLoading(null);
        }
    };

    if (loading) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    return (
        <>
            <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                    <h2>Task Board</h2>
                    <p>Claim Task, submit Proof, approve Milestone, and settle via Escrow payout.</p>
                </div>
                <div className="role-switcher">
                    <button className={`role-btn ${role === 'owner' ? 'active' : ''}`} onClick={() => setRole('owner')}>
                        Owner
                    </button>
                    <button className={`role-btn ${role === 'executor' ? 'active' : ''}`} onClick={() => setRole('executor')}>
                        Executor
                    </button>
                </div>
            </div>

            {/* Role Info */}
            <div className="card" style={{ marginBottom: '24px', padding: '16px' }}>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {role === 'owner'
                        ? 'Owner mode: review Proof submissions and approve payout.'
                        : 'Executor mode: claim Milestone tasks and submit Proof for review.'}
                </p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '8px' }}>
                    Onchain states: broadcasted -&gt; confirmed. Each action chip links to Hiro explorer txid.
                </p>
                {campaignActionMessage && (
                    <p style={{ marginTop: '10px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                        {campaignActionMessage}
                    </p>
                )}
                {campaignActionError && (
                    <p style={{ marginTop: '8px', color: 'var(--accent-danger)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                        {campaignActionError}
                    </p>
                )}
            </div>

            {role === 'owner' && ownerCampaigns.length > 0 && (
                <div className="task-list" style={{ marginBottom: '24px' }}>
                    {ownerCampaigns.map((campaign) => {
                        const timeline = (campaignEvents[campaign.id] || []).slice(-6).reverse();
                        return (
                            <div key={campaign.id} className="task-card">
                                <div className="task-header">
                                    <h3 style={{ fontSize: '0.95rem' }}>{campaign.title}</h3>
                                    <span className={`task-status ${campaign.status}`}>{campaign.status}</span>
                                </div>
                                <p className="task-description">
                                    Escrow balance: {(campaign.remaining_balance / 1000000).toFixed(2)} USDCx
                                </p>
                                <div className="task-actions">
                                    {campaign.status !== 'closed' && (
                                        <button
                                            className="btn btn-secondary btn-sm"
                                            onClick={() => handleCloseCampaign(campaign)}
                                            disabled={campaignActionLoading === `close-${campaign.id}`}
                                        >
                                            {campaignActionLoading === `close-${campaign.id}` ? 'Closing...' : 'Close Campaign'}
                                        </button>
                                    )}
                                    {campaign.status === 'closed' && campaign.remaining_balance > 0 && (
                                        <button
                                            className="btn btn-primary btn-sm"
                                            onClick={() => handleWithdrawCampaign(campaign)}
                                            disabled={campaignActionLoading === `withdraw-${campaign.id}`}
                                        >
                                            {campaignActionLoading === `withdraw-${campaign.id}` ? 'Withdrawing...' : 'Withdraw Remaining'}
                                        </button>
                                    )}
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => handleReconcileCampaign(campaign)}
                                        disabled={campaignActionLoading === `reconcile-${campaign.id}`}
                                    >
                                        {campaignActionLoading === `reconcile-${campaign.id}` ? 'Syncing...' : 'Sync Onchain'}
                                    </button>
                                </div>
                                <div
                                    style={{
                                        marginTop: '12px',
                                        borderTop: '1px solid rgba(255,255,255,0.08)',
                                        paddingTop: '10px',
                                    }}
                                >
                                    <p
                                        style={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: '0.72rem',
                                            color: 'var(--text-tertiary)',
                                            marginBottom: '8px',
                                        }}
                                    >
                                        Campaign Timeline
                                    </p>
                                    {timeline.length > 0 ? (
                                        <div style={{ display: 'grid', gap: '6px' }}>
                                            {timeline.map((event) => (
                                                <div
                                                    key={event.id}
                                                    style={{
                                                        display: 'flex',
                                                        justifyContent: 'space-between',
                                                        gap: '10px',
                                                        alignItems: 'center',
                                                    }}
                                                >
                                                    <div style={{ minWidth: 0 }}>
                                                        <p
                                                            style={{
                                                                fontFamily: 'var(--font-mono)',
                                                                fontSize: '0.7rem',
                                                                color: 'var(--text-secondary)',
                                                                whiteSpace: 'nowrap',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                            }}
                                                        >
                                                            {event.message}
                                                        </p>
                                                        <p
                                                            style={{
                                                                fontFamily: 'var(--font-mono)',
                                                                fontSize: '0.65rem',
                                                                color: 'var(--text-tertiary)',
                                                            }}
                                                        >
                                                            {new Date(event.created_at).toLocaleString()}
                                                        </p>
                                                    </div>
                                                    <span className={`tx-chip ${event.onchain_status === 'unknown' ? 'idle' : event.onchain_status}`}>
                                                        {event.onchain_status}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p
                                            style={{
                                                fontFamily: 'var(--font-mono)',
                                                fontSize: '0.68rem',
                                                color: 'var(--text-tertiary)',
                                            }}
                                        >
                                            No timeline events yet.
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Stats */}
            <div className="stats-row" style={{ marginBottom: '24px' }}>
                <div className="stat-card">
                    <div className="stat-value">{allTasks.filter(t => t.task.status === 'open').length}</div>
                    <div className="stat-label">Open</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{allTasks.filter(t => t.task.status === 'claimed').length}</div>
                    <div className="stat-label">Claimed</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{allTasks.filter(t => t.task.status === 'proof_submitted').length}</div>
                    <div className="stat-label">Proof Submitted</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{allTasks.filter(t => t.task.status === 'approved').length}</div>
                    <div className="stat-label">Approved</div>
                </div>
            </div>

            {/* Task List */}
            {filteredTasks.length > 0 ? (
                <div className="task-list">
                    {filteredTasks.map(({ task, campaign }) => (
                        <TaskCardComponent
                            key={task.id}
                            task={task}
                            campaign={campaign}
                            role={role}
                            callerAddress={address}
                            onAction={loadData}
                            txState={taskTxState[task.id] || DEFAULT_ONCHAIN_STATE}
                            onTrackTx={handleTrackTx}
                        />
                    ))}
                </div>
            ) : (
                <div className="empty-state">
                    <h3>No Tasks Available</h3>
                    <p>
                        {campaigns.length === 0
                            ? 'No campaigns created yet. Fetch alpha and convert to a campaign first.'
                            : role === 'executor'
                                ? 'No open tasks available to claim right now.'
                                : 'All tasks are in their final state.'}
                    </p>
                    {campaigns.length === 0 && (
                        <button className="btn btn-secondary" onClick={() => router.push('/')} style={{ marginTop: '16px' }}>
                            ← Go to Alpha Dashboard
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
