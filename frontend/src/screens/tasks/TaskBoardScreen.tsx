'use client';

import { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/components/ClientProviders';
import {
    getCampaigns,
    claimTask,
    submitProof,
    approveTask,
    closeCampaign,
    withdrawCampaign,
    Campaign,
    Task,
} from '@/lib/api';

function TaskStatusBadge({ status }: { status: string }) {
    const labels: Record<string, string> = {
        open: '● Open',
        claimed: '◐ Claimed',
        proof_submitted: '◑ Proof Submitted',
        approved: '✓ Approved',
        rejected: '✗ Rejected',
    };
    return <span className={`task-status ${status}`}>{labels[status] || status}</span>;
}

type OnchainAction = 'claim' | 'submit' | 'approve';
type OnchainStage = 'idle' | 'broadcasted' | 'confirmed' | 'failed';

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
};

const STACKS_API_BASE_URL = (
    process.env.NEXT_PUBLIC_STACKS_API_URL || 'https://api.testnet.hiro.so'
).replace(/\/$/, '');
const EXPLORER_BASE = 'https://explorer.hiro.so';
const EXPLORER_CHAIN = (process.env.NEXT_PUBLIC_NETWORK || 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';

function toStatusRank(status: Task['status']): number {
    switch (status) {
        case 'open': return 0;
        case 'claimed': return 1;
        case 'proof_submitted': return 2;
        case 'approved': return 3;
        case 'rejected': return 1;
        default: return 0;
    }
}

function MilestoneFlow({ status }: { status: Task['status'] }) {
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
    onAction,
    txState,
    onTrackTx,
}: {
    task: Task;
    campaign: Campaign;
    role: 'owner' | 'executor';
    onAction: () => Promise<void>;
    txState: TaskOnchainMap;
    onTrackTx: (taskId: string, action: OnchainAction, txId: string) => void;
}) {
    const [proofInput, setProofInput] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    const handleClaim = async () => {
        setActionLoading(true);
        try {
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callClaimTask } = await import('@/lib/wallet');
            const onchainTaskId = Math.max(campaign.tasks.findIndex((t) => t.id === task.id) + 1, 1);
            const txId = await callClaimTask(campaign.onchain_id, onchainTaskId);
            if (!txId) {
                throw new Error('claim-task transaction failed.');
            }
            onTrackTx(task.id, 'claim', txId);
            await claimTask(campaign.id, task.id);
            await onAction();
        } catch (e) {
            console.error(e);
        } finally {
            setActionLoading(false);
        }
    };

    const handleSubmitProof = async () => {
        setActionLoading(true);
        try {
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
            onTrackTx(task.id, 'submit', txId);
            await submitProof(campaign.id, task.id, undefined, proofText);
            await onAction();
        } catch (e) {
            console.error(e);
        } finally {
            setActionLoading(false);
        }
    };

    const handleApprove = async () => {
        setActionLoading(true);
        try {
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
            onTrackTx(task.id, 'approve', txId);
            // Update backend
            await approveTask(campaign.id, task.id);
            await onAction();
        } catch (e) {
            console.error(e);
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
                    <span className="task-payout">{(task.payout / 1000000).toFixed(2)} STX</span>
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
                        Payout of {(task.payout / 1000000).toFixed(2)} STX transferred to executor
                    </p>
                    {task.approved_at && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                            Approved: {new Date(task.approved_at).toLocaleString()}
                        </span>
                    )}
                </div>
            )}

            {/* Actions based on role and status */}
            <div className="task-actions">
                {/* Executor: Claim */}
                {role === 'executor' && task.status === 'open' && (
                    <button className="btn btn-primary btn-sm" onClick={handleClaim} disabled={actionLoading}>
                        {actionLoading ? '...' : 'Claim Task'}
                    </button>
                )}

                {/* Executor: Submit Proof */}
                {role === 'executor' && task.status === 'claimed' && (
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
                {role === 'owner' && task.status === 'proof_submitted' && (
                    <button className="btn btn-primary btn-sm" onClick={handleApprove} disabled={actionLoading}>
                        {actionLoading ? '...' : 'Approve & Pay'}
                    </button>
                )}
            </div>
        </div>
    );
}

export default function TaskBoardPage() {
    const { role, setRole } = useWallet();
    const router = useRouter();
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [campaignActionLoading, setCampaignActionLoading] = useState<string | null>(null);
    const [taskTxState, setTaskTxState] = useState<Record<string, TaskOnchainMap>>({});

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

    const fetchTxStatus = useCallback(async (txId: string): Promise<'success' | 'failed' | 'pending'> => {
        const normalized = txId.trim();
        const candidates = normalized.startsWith('0x')
            ? [normalized, normalized.substring(2)]
            : [normalized, `0x${normalized}`];

        for (const candidate of candidates) {
            try {
                const res = await fetch(`${STACKS_API_BASE_URL}/extended/v1/tx/${candidate}`);
                if (!res.ok) continue;
                const data = await res.json() as { tx_status?: string };
                const status = String(data.tx_status || '');
                if (status === 'success') return 'success';
                if (status === 'abort_by_response' || status === 'abort_by_post_condition') return 'failed';
                return 'pending';
            } catch {
                continue;
            }
        }
        return 'pending';
    }, []);

    const trackOnchainTx = useCallback(async (taskId: string, action: OnchainAction, txId: string) => {
        updateTaskTxState(taskId, action, {
            status: 'broadcasted',
            txId,
            note: 'Broadcasted',
        });

        const timeoutMs = 90000;
        const pollMs = 3000;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
            const status = await fetchTxStatus(txId);
            if (status === 'success') {
                updateTaskTxState(taskId, action, { status: 'confirmed', note: 'Confirmed onchain' });
                return;
            }
            if (status === 'failed') {
                updateTaskTxState(taskId, action, { status: 'failed', note: 'Execution failed onchain' });
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        updateTaskTxState(taskId, action, { status: 'failed', note: 'No confirmation within timeout window' });
    }, [fetchTxStatus, updateTaskTxState]);

    const handleTrackTx = useCallback((taskId: string, action: OnchainAction, txId: string) => {
        void trackOnchainTx(taskId, action, txId);
    }, [trackOnchainTx]);

    const loadData = useCallback(async () => {
        try {
            const data = await getCampaigns();
            startTransition(() => {
                setCampaigns(data);
            });
        } catch (error) {
            console.error('Failed to refresh campaigns:', error);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadInitialData = async () => {
            try {
                const data = await getCampaigns();
                if (cancelled) return;
                startTransition(() => {
                    setCampaigns(data);
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
    }, []);

    const allTasks = useMemo(() => (
        campaigns.flatMap((c) => c.tasks.map((t) => ({ task: t, campaign: c })))
    ), [campaigns]);

    const filteredTasks = useMemo(() => (
        role === 'executor'
            ? allTasks.filter(({ task }) => ['open', 'claimed'].includes(task.status))
            : allTasks
    ), [allTasks, role]);

    const ownerCampaigns = useMemo(
        () => campaigns.filter((campaign) => campaign.status !== 'draft'),
        [campaigns]
    );

    const handleCloseCampaign = async (campaign: Campaign) => {
        setCampaignActionLoading(`close-${campaign.id}`);
        try {
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callCloseCampaign } = await import('@/lib/wallet');
            await callCloseCampaign(campaign.onchain_id);
            await closeCampaign(campaign.id);
            await loadData();
        } catch (error) {
            console.error(error);
        } finally {
            setCampaignActionLoading(null);
        }
    };

    const handleWithdrawCampaign = async (campaign: Campaign) => {
        setCampaignActionLoading(`withdraw-${campaign.id}`);
        try {
            if (!campaign.onchain_id) {
                throw new Error('Campaign has no onchain_id. Deploy Escrow first.');
            }
            const { callWithdrawRemaining } = await import('@/lib/wallet');
            await callWithdrawRemaining(campaign.onchain_id, campaign.remaining_balance);
            await withdrawCampaign(campaign.id, campaign.remaining_balance);
            await loadData();
        } catch (error) {
            console.error(error);
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
            </div>

            {role === 'owner' && ownerCampaigns.length > 0 && (
                <div className="task-list" style={{ marginBottom: '24px' }}>
                    {ownerCampaigns.map((campaign) => (
                        <div key={campaign.id} className="task-card">
                            <div className="task-header">
                                <h3 style={{ fontSize: '0.95rem' }}>{campaign.title}</h3>
                                <span className={`task-status ${campaign.status}`}>{campaign.status}</span>
                            </div>
                            <p className="task-description">
                                Escrow balance: {(campaign.remaining_balance / 1000000).toFixed(2)} STX
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
                            </div>
                        </div>
                    ))}
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
