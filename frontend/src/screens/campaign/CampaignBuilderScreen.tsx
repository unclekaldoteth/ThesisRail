'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { getCampaign, getCampaigns, fundCampaign, updateCampaignTask, Campaign, Task } from '@/lib/api';

interface TaskDraftForm {
    milestone: string;
    title: string;
    description: string;
    payout_stx: string;
    deadline_date: string;
    acceptance_criteria: string;
}

function isoToDateInput(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

function createTaskDraft(task: Task): TaskDraftForm {
    return {
        milestone: task.milestone || '',
        title: task.title || '',
        description: task.description || '',
        payout_stx: (task.payout / 1000000).toFixed(6).replace(/\.?0+$/, ''),
        deadline_date: isoToDateInput(task.deadline),
        acceptance_criteria: task.acceptance_criteria || '',
    };
}

function CampaignBuilderInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const contractName = process.env.NEXT_PUBLIC_CONTRACT_NAME || 'thesis-rail-escrow-v4';
    const [campaign, setCampaign] = useState<Campaign | null>(null);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [deploying, setDeploying] = useState(false);
    const [deployed, setDeployed] = useState(false);
    const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraftForm>>({});
    const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
    const [taskEditorMessage, setTaskEditorMessage] = useState<string | null>(null);

    useEffect(() => {
        const load = async () => {
            const id = searchParams.get('id');
            if (id) {
                const data = await getCampaign(id);
                setCampaign(data);
            }
            const allCampaigns = await getCampaigns();
            setCampaigns(allCampaigns);
            setLoading(false);
        };
        load();
    }, [searchParams]);

    useEffect(() => {
        if (!campaign) {
            setTaskDrafts({});
            return;
        }
        const drafts: Record<string, TaskDraftForm> = {};
        campaign.tasks.forEach((task) => {
            drafts[task.id] = createTaskDraft(task);
        });
        setTaskDrafts(drafts);
    }, [campaign]);

    const handleDeploy = async () => {
        if (!campaign) return;
        setDeploying(true);
        try {
            const {
                callCreateCampaign,
                callFundCampaign,
                callAddTask,
                getNextCampaignId,
                waitForCreateCampaignId,
            } = await import('@/lib/wallet');
            const predictedOnchainId = campaign.onchain_id || (await getNextCampaignId());
            if (!predictedOnchainId) {
                throw new Error('Unable to resolve next onchain campaign id.');
            }

            // Step 1: Create campaign onchain
            const createTxId = await callCreateCampaign(campaign.metadata_hash);
            if (!createTxId) {
                throw new Error('create-campaign transaction failed.');
            }
            const confirmedOnchainId = await waitForCreateCampaignId(createTxId);
            const onchainCampaignId = confirmedOnchainId || predictedOnchainId;

            // Step 2: Fund the escrow
            const totalPayout = campaign.tasks.reduce((sum, t) => sum + t.payout, 0);
            const fundTxId = await callFundCampaign(onchainCampaignId, totalPayout);

            // Step 3: Register tasks as onchain milestones
            for (const task of campaign.tasks) {
                const deadline = Math.floor(new Date(task.deadline).getTime() / 1000);
                await callAddTask(onchainCampaignId, task.payout, deadline, task.acceptance_criteria);
            }

            // Step 4: Update backend
            await fundCampaign(campaign.id, totalPayout, fundTxId || createTxId || undefined, onchainCampaignId);

            // Refresh campaign data
            const updated = await getCampaign(campaign.id);
            setCampaign(updated);
            setDeployed(true);
        } catch (error) {
            console.error('Deploy failed:', error);
        } finally {
            setDeploying(false);
        }
    };

    const handleTaskDraftChange = (taskId: string, field: keyof TaskDraftForm, value: string) => {
        setTaskDrafts((prev) => ({
            ...prev,
            [taskId]: {
                ...prev[taskId],
                [field]: value,
            },
        }));
    };

    const handleSaveTask = async (taskId: string) => {
        if (!campaign) return;
        const draft = taskDrafts[taskId];
        if (!draft) return;

        const payoutStx = Number.parseFloat(draft.payout_stx);
        if (!Number.isFinite(payoutStx) || payoutStx <= 0) {
            setTaskEditorMessage('Payout must be a positive STX amount.');
            return;
        }

        const payoutMicroStx = Math.round(payoutStx * 1000000);
        const deadline = Date.parse(draft.deadline_date);
        if (!Number.isFinite(deadline)) {
            setTaskEditorMessage('Deadline must be a valid date.');
            return;
        }

        if (!draft.acceptance_criteria.trim()) {
            setTaskEditorMessage('Acceptance criteria cannot be empty.');
            return;
        }

        setSavingTaskId(taskId);
        setTaskEditorMessage(null);
        try {
            const updatedTask = await updateCampaignTask(campaign.id, taskId, {
                milestone: draft.milestone,
                title: draft.title,
                description: draft.description,
                payout: payoutMicroStx,
                deadline: new Date(deadline).toISOString(),
                acceptance_criteria: draft.acceptance_criteria,
            });

            setCampaign((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    tasks: prev.tasks.map((task) => (task.id === taskId ? updatedTask : task)),
                };
            });
            setTaskEditorMessage(`Saved ${updatedTask.milestone}.`);
        } catch (error) {
            console.error('Task update failed:', error);
            setTaskEditorMessage('Failed to save task changes.');
        } finally {
            setSavingTaskId(null);
        }
    };

    if (loading) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    // If no specific campaign, show campaigns list
    if (!campaign) {
        return (
            <>
                <div className="page-header">
                    <h2>Campaigns</h2>
                    <p>Convert signal into operational Milestones with payout accountability.</p>
                </div>

                {campaigns.length > 0 ? (
                    <div className="task-list">
                        {campaigns.map((c) => (
                            <div key={c.id} className="task-card" onClick={() => router.push(`/campaign?id=${c.id}`)} style={{ cursor: 'pointer' }}>
                                <div className="task-header">
                                    <h3 style={{ fontSize: '1rem' }}>{c.title}</h3>
                                    <span className={`task-status ${c.status}`}>{c.status}</span>
                                </div>
                                <p className="task-description">{c.description}</p>
                                <div style={{ display: 'flex', gap: '16px', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                                    <span style={{ color: 'var(--accent-primary)' }}>{c.tasks.length} tasks</span>
                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                        Funded: {(c.total_funded / 1000000).toFixed(2)} STX
                                    </span>
                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                        Created: {new Date(c.created_at).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="empty-state">
                        <h3>No Campaigns Yet</h3>
                        <p>Fetch alpha signals and convert one to a campaign to get started.</p>
                        <button className="btn btn-secondary" onClick={() => router.push('/')} style={{ marginTop: '16px' }}>
                            ← Go to Alpha Dashboard
                        </button>
                    </div>
                )}
            </>
        );
    }

    const totalPayout = campaign.tasks.reduce((sum, t) => sum + t.payout, 0);

    return (
        <>
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/campaign')} style={{ marginBottom: '24px' }}>
                All Campaigns
            </button>

            <div className="page-header">
                <h2>Campaign Builder</h2>
                <p>{campaign.title}</p>
            </div>

            {/* Campaign Stats */}
            <div className="stats-row" style={{ marginBottom: '32px' }}>
                <div className="stat-card">
                    <div className="stat-value">{campaign.tasks.length}</div>
                    <div className="stat-label">Tasks</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{(totalPayout / 1000000).toFixed(2)}</div>
                    <div className="stat-label">Total STX</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value" style={{
                        color: campaign.status === 'funded' ? 'var(--accent-primary)' : 'var(--accent-warning)'
                    }}>
                        {campaign.status.toUpperCase()}
                    </div>
                    <div className="stat-label">Status</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{(campaign.remaining_balance / 1000000).toFixed(2)}</div>
                    <div className="stat-label">Remaining STX</div>
                </div>
            </div>

            {/* Task List */}
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '16px' }}>
                Work Orders {campaign.status === 'draft' ? '(Editable)' : ''}
            </h3>
            {taskEditorMessage && (
                <p style={{ marginBottom: '12px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--accent-primary)' }}>
                    {taskEditorMessage}
                </p>
            )}

            <div className="task-list" style={{ marginBottom: '32px' }}>
                {campaign.tasks.map((task, index) => (
                    <div key={task.id} className="task-card">
                        <div className="task-header">
                            <h3 style={{ fontSize: '0.95rem' }}>
                                <span style={{ color: 'var(--text-tertiary)', marginRight: '8px' }}>#{index + 1}</span>
                                {task.title}
                            </h3>
                            <span className="task-payout">{(task.payout / 1000000).toFixed(2)} STX</span>
                        </div>
                        {'milestone' in task && task.milestone && (
                            <div style={{ marginBottom: '8px' }}>
                                <span className="task-status open">{task.milestone}</span>
                            </div>
                        )}
                        {campaign.status === 'draft' ? (
                            <div style={{ display: 'grid', gap: '10px' }}>
                                <div className="form-group">
                                    <label className="form-label">Milestone</label>
                                    <input
                                        className="form-input"
                                        value={taskDrafts[task.id]?.milestone || ''}
                                        onChange={(e) => handleTaskDraftChange(task.id, 'milestone', e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Title</label>
                                    <input
                                        className="form-input"
                                        value={taskDrafts[task.id]?.title || ''}
                                        onChange={(e) => handleTaskDraftChange(task.id, 'title', e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Description</label>
                                    <textarea
                                        className="form-textarea"
                                        value={taskDrafts[task.id]?.description || ''}
                                        onChange={(e) => handleTaskDraftChange(task.id, 'description', e.target.value)}
                                    />
                                </div>
                                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                    <div className="form-group" style={{ minWidth: '180px' }}>
                                        <label className="form-label">Payout (STX)</label>
                                        <input
                                            className="form-input"
                                            type="number"
                                            min="0.000001"
                                            step="0.000001"
                                            value={taskDrafts[task.id]?.payout_stx || ''}
                                            onChange={(e) => handleTaskDraftChange(task.id, 'payout_stx', e.target.value)}
                                        />
                                    </div>
                                    <div className="form-group" style={{ minWidth: '180px' }}>
                                        <label className="form-label">Deadline</label>
                                        <input
                                            className="form-input"
                                            type="date"
                                            value={taskDrafts[task.id]?.deadline_date || ''}
                                            onChange={(e) => handleTaskDraftChange(task.id, 'deadline_date', e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Acceptance Criteria</label>
                                    <textarea
                                        className="form-textarea"
                                        value={taskDrafts[task.id]?.acceptance_criteria || ''}
                                        onChange={(e) => handleTaskDraftChange(task.id, 'acceptance_criteria', e.target.value)}
                                    />
                                </div>
                                <div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => handleSaveTask(task.id)}
                                        disabled={savingTaskId === task.id}
                                    >
                                        {savingTaskId === task.id ? 'Saving...' : 'Save Work Order'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <p className="task-description">{task.description}</p>
                                <div style={{ display: 'flex', gap: '16px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                                    <span>Deadline: {new Date(task.deadline).toLocaleDateString()}</span>
                                    <span>Criteria: {task.acceptance_criteria.substring(0, 60)}...</span>
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>

            {/* Deploy CTA */}
            {campaign.status === 'draft' && (
                <div className="card" style={{ background: 'var(--accent-primary-dim)', borderColor: 'var(--accent-primary)', textAlign: 'center', padding: '32px' }}>
                    <h3 style={{ color: 'var(--accent-primary)', marginBottom: '8px' }}>
                        Deploy Escrow
                    </h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '8px' }}>
                        This will create the campaign onchain and fund the escrow with {(totalPayout / 1000000).toFixed(2)} STX.
                    </p>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', marginBottom: '20px' }}>
                        Contract: {contractName} · Network: Stacks Testnet
                    </p>
                    <button
                        className="btn btn-primary btn-lg"
                        onClick={handleDeploy}
                        disabled={deploying}
                        style={{ minWidth: '280px' }}
                    >
                        {deploying ? 'Deploying...' : 'Deploy Escrow'}
                    </button>
                </div>
            )}

            {deployed && (
                <div className="toast success">
                    ✓ Campaign deployed &amp; funded onchain!
                    <button className="btn btn-primary btn-sm" onClick={() => router.push('/tasks')} style={{ marginLeft: '12px' }}>
                        Go to Task Board →
                    </button>
                </div>
            )}

            {campaign.status === 'funded' && (
                <div className="card" style={{ textAlign: 'center', padding: '24px' }}>
                    <p style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>
                        ✓ Campaign funded with {(campaign.total_funded / 1000000).toFixed(2)} STX
                    </p>
                    <button className="btn btn-secondary" onClick={() => router.push('/tasks')}>
                        Go to Task Board →
                    </button>
                </div>
            )}
        </>
    );
}

export default function CampaignBuilderPage() {
    return (
        <Suspense fallback={<div className="loading-spinner"><div className="spinner" /></div>}>
            <CampaignBuilderInner />
        </Suspense>
    );
}
