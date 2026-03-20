'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { getCampaign, getCampaigns, fundCampaign, updateCampaignTask, Campaign, Task } from '@/lib/api';
import { useWallet } from '@/components/ClientProviders';

interface TaskDraftForm {
    milestone: string;
    title: string;
    description: string;
    payout_stx: string;
    deadline_date: string;
    acceptance_criteria: string;
}

function normalizeWalletAddress(value: string | null | undefined): string | null {
    const normalized = (value || '').trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
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

interface DeployProgress {
    version: 1;
    campaignId: string;
    totalTasks: number;
    taskFingerprint: string;
    onchainCampaignId?: number;
    createTxId?: string;
    createConfirmed: boolean;
    fundTxId?: string;
    fundConfirmed: boolean;
    taskConfirmedCount: number;
    taskTxIds: string[];
    updatedAt: string;
}

function deployProgressStorageKey(campaignId: string): string {
    return `thesisrail:deploy-progress:${campaignId}`;
}

function buildTaskFingerprint(tasks: Task[]): string {
    return tasks
        .map((task) => `${task.id}:${task.payout}:${Date.parse(task.deadline)}:${task.acceptance_criteria}`)
        .join('|');
}

function createInitialDeployProgress(campaign: Campaign): DeployProgress {
    return {
        version: 1,
        campaignId: campaign.id,
        totalTasks: campaign.tasks.length,
        taskFingerprint: buildTaskFingerprint(campaign.tasks),
        onchainCampaignId: campaign.onchain_id,
        createTxId: undefined,
        createConfirmed: false,
        fundTxId: undefined,
        fundConfirmed: false,
        taskConfirmedCount: 0,
        taskTxIds: [],
        updatedAt: new Date().toISOString(),
    };
}

function loadDeployProgress(campaign: Campaign): DeployProgress | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(deployProgressStorageKey(campaign.id));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DeployProgress>;
        if (!parsed || parsed.version !== 1 || parsed.campaignId !== campaign.id) return null;
        const progress: DeployProgress = {
            ...createInitialDeployProgress(campaign),
            ...parsed,
            taskTxIds: Array.isArray(parsed.taskTxIds) ? parsed.taskTxIds.filter((value): value is string => typeof value === 'string') : [],
            taskConfirmedCount: Number.isFinite(parsed.taskConfirmedCount) ? Number(parsed.taskConfirmedCount) : 0,
            totalTasks: Number.isFinite(parsed.totalTasks) ? Number(parsed.totalTasks) : campaign.tasks.length,
            taskFingerprint: typeof parsed.taskFingerprint === 'string' ? parsed.taskFingerprint : buildTaskFingerprint(campaign.tasks),
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
        progress.taskConfirmedCount = Math.max(0, Math.min(progress.taskConfirmedCount, campaign.tasks.length));
        if (progress.taskTxIds.length > campaign.tasks.length) {
            progress.taskTxIds = progress.taskTxIds.slice(0, campaign.tasks.length);
        }
        return progress;
    } catch {
        return null;
    }
}

function persistDeployProgress(progress: DeployProgress): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
        deployProgressStorageKey(progress.campaignId),
        JSON.stringify({ ...progress, updatedAt: new Date().toISOString() })
    );
}

function clearDeployProgress(campaignId: string): void {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(deployProgressStorageKey(campaignId));
}

function CampaignBuilderInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { address } = useWallet();
    const contractName = process.env.NEXT_PUBLIC_CONTRACT_NAME || 'thesis-rail-escrow-v7';
    const [campaign, setCampaign] = useState<Campaign | null>(null);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [deploying, setDeploying] = useState(false);
    const [deployed, setDeployed] = useState(false);
    const [deployStatusMessage, setDeployStatusMessage] = useState<string | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraftForm>>({});
    const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
    const [taskEditorMessage, setTaskEditorMessage] = useState<string | null>(null);
    const normalizedCaller = normalizeWalletAddress(address);
    const isOwnerWallet = Boolean(campaign && normalizedCaller && normalizeWalletAddress(campaign.owner) === normalizedCaller);
    const canEditDraftCampaign = Boolean(campaign && campaign.status === 'draft' && isOwnerWallet);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setLoading(true);
            setLoadError(null);
            try {
                const id = searchParams.get('id');
                const [selectedCampaign, allCampaigns] = await Promise.all([
                    id ? getCampaign(id) : Promise.resolve(null),
                    getCampaigns(),
                ]);
                if (cancelled) return;

                setCampaign(selectedCampaign);
                setCampaigns(allCampaigns);
                if (id && !selectedCampaign) {
                    setLoadError('Campaign not found or no longer available.');
                }
            } catch (error) {
                console.error('Failed to load campaign builder data:', error);
                if (cancelled) return;
                setCampaign(null);
                setCampaigns([]);
                setLoadError(error instanceof Error ? error.message : 'Failed to load campaign data.');
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void load();
        return () => {
            cancelled = true;
        };
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

    useEffect(() => {
        if (!campaign) return;
        if (campaign.status !== 'draft') {
            clearDeployProgress(campaign.id);
        }
    }, [campaign]);

    const handleDeploy = async () => {
        if (!campaign) return;
        setDeploying(true);
        setDeployError(null);
        setDeployStatusMessage('Preparing onchain deployment...');
        try {
            if (!address) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            if (!isOwnerWallet) {
                throw new Error('Connect the campaign owner wallet before deploying this escrow.');
            }
            const {
                callCreateCampaign,
                callFundCampaign,
                callAddTask,
                waitForCreateCampaignId,
                waitForTxSuccess,
            } = await import('@/lib/wallet');
            const totalPayout = campaign.tasks.reduce((sum, t) => sum + t.payout, 0);
            const currentFingerprint = buildTaskFingerprint(campaign.tasks);
            let progress = loadDeployProgress(campaign) || createInitialDeployProgress(campaign);
            const hasConfirmedProgress = progress.createConfirmed || progress.fundConfirmed || progress.taskConfirmedCount > 0;

            if (progress.taskFingerprint !== currentFingerprint || progress.totalTasks !== campaign.tasks.length) {
                if (hasConfirmedProgress) {
                    throw new Error(
                        'Work order settings changed after onchain deployment started. Create a new campaign for a clean redeploy.'
                    );
                }
                progress = createInitialDeployProgress(campaign);
                persistDeployProgress(progress);
            }

            if (hasConfirmedProgress || progress.createTxId || progress.fundTxId || progress.taskTxIds.some((txId) => txId.length > 0)) {
                setDeployStatusMessage('Resuming from previous deployment progress...');
            }

            let onchainCampaignId: number | null = progress.onchainCampaignId || campaign.onchain_id || null;

            // Step 1: create-campaign (resume-safe)
            if (!progress.createConfirmed) {
                if (progress.createTxId) {
                    setDeployStatusMessage('Checking previous create-campaign transaction...');
                    const priorCreateOutcome = await waitForTxSuccess(progress.createTxId);
                    if (priorCreateOutcome === 'success') {
                        progress.createConfirmed = true;
                        persistDeployProgress(progress);
                    } else if (priorCreateOutcome === 'failed') {
                        progress.createTxId = undefined;
                        persistDeployProgress(progress);
                    } else {
                        throw new Error('Previous create-campaign transaction is still pending. Retry Deploy Escrow after confirmation.');
                    }
                }

                if (!progress.createConfirmed) {
                    setDeployStatusMessage('Broadcasting create-campaign transaction...');
                    const createTxId = await callCreateCampaign(campaign.metadata_hash);
                    if (!createTxId) {
                        throw new Error('create-campaign transaction failed.');
                    }

                    progress.createTxId = createTxId;
                    persistDeployProgress(progress);

                    const createOutcome = await waitForTxSuccess(createTxId);
                    if (createOutcome !== 'success') {
                        const reason = createOutcome === 'pending' ? 'still pending' : 'failed';
                        if (createOutcome === 'failed') {
                            progress.createTxId = undefined;
                            persistDeployProgress(progress);
                        }
                        throw new Error(`create-campaign transaction ${reason}. Retry Deploy Escrow after confirmation.`);
                    }
                    progress.createConfirmed = true;
                    persistDeployProgress(progress);
                }
            }

            if (!onchainCampaignId) {
                if (!progress.createTxId) {
                    throw new Error('Create transaction id is missing. Retry deployment from the create step.');
                }
                setDeployStatusMessage('Create confirmed. Resolving onchain campaign id...');
                const confirmedOnchainId = await waitForCreateCampaignId(progress.createTxId);
                if (!confirmedOnchainId) {
                    throw new Error(
                        'Create transaction confirmed but campaign id is not indexed yet. Retry after the Stacks API catches up.'
                    );
                }
                onchainCampaignId = confirmedOnchainId;
                progress.onchainCampaignId = confirmedOnchainId;
                persistDeployProgress(progress);
            }

            // Step 2: fund-campaign (resume-safe)
            if (!progress.fundConfirmed) {
                if (progress.fundTxId) {
                    setDeployStatusMessage('Checking previous fund-campaign transaction...');
                    const priorFundOutcome = await waitForTxSuccess(progress.fundTxId);
                    if (priorFundOutcome === 'success') {
                        progress.fundConfirmed = true;
                        persistDeployProgress(progress);
                    } else if (priorFundOutcome === 'failed') {
                        progress.fundTxId = undefined;
                        persistDeployProgress(progress);
                    } else {
                        throw new Error('Previous fund-campaign transaction is still pending. Retry Deploy Escrow after confirmation.');
                    }
                }

                if (!progress.fundConfirmed) {
                    setDeployStatusMessage('Broadcasting fund-campaign transaction...');
                    const fundTxId = await callFundCampaign(onchainCampaignId, totalPayout);
                    if (!fundTxId) {
                        throw new Error('fund-campaign transaction failed.');
                    }
                    progress.fundTxId = fundTxId;
                    persistDeployProgress(progress);

                    const fundOutcome = await waitForTxSuccess(fundTxId);
                    if (fundOutcome !== 'success') {
                        const reason = fundOutcome === 'pending' ? 'still pending' : 'failed';
                        if (fundOutcome === 'failed') {
                            progress.fundTxId = undefined;
                            persistDeployProgress(progress);
                        }
                        throw new Error(`fund-campaign transaction ${reason}. Retry Deploy Escrow after confirmation.`);
                    }
                    progress.fundConfirmed = true;
                    persistDeployProgress(progress);
                }
            }

            // Step 3: add-task for each milestone (resume-safe)
            while (progress.taskConfirmedCount < campaign.tasks.length) {
                const taskIndex = progress.taskConfirmedCount;
                const task = campaign.tasks[taskIndex];
                const deadline = Math.floor(new Date(task.deadline).getTime() / 1000);
                const existingTaskTxId = progress.taskTxIds[taskIndex];

                if (existingTaskTxId) {
                    setDeployStatusMessage(`Checking milestone ${taskIndex + 1}/${campaign.tasks.length} transaction...`);
                    const priorTaskOutcome = await waitForTxSuccess(existingTaskTxId);
                    if (priorTaskOutcome === 'success') {
                        progress.taskConfirmedCount += 1;
                        persistDeployProgress(progress);
                        continue;
                    }
                    if (priorTaskOutcome === 'failed') {
                        progress.taskTxIds[taskIndex] = '';
                        persistDeployProgress(progress);
                    } else {
                        throw new Error(
                            `Milestone ${taskIndex + 1} transaction is still pending. Retry Deploy Escrow after confirmation.`
                        );
                    }
                }

                setDeployStatusMessage(`Registering milestone ${taskIndex + 1}/${campaign.tasks.length} onchain...`);
                const addTaskTxId = await callAddTask(onchainCampaignId, task.payout, deadline, task.acceptance_criteria);
                if (!addTaskTxId) {
                    throw new Error(`add-task transaction failed for ${task.milestone || `task ${taskIndex + 1}`}.`);
                }
                progress.taskTxIds[taskIndex] = addTaskTxId;
                persistDeployProgress(progress);

                const addTaskOutcome = await waitForTxSuccess(addTaskTxId);
                if (addTaskOutcome !== 'success') {
                    const reason = addTaskOutcome === 'pending' ? 'still pending' : 'failed';
                    if (addTaskOutcome === 'failed') {
                        progress.taskTxIds[taskIndex] = '';
                        persistDeployProgress(progress);
                    }
                    throw new Error(`add-task transaction ${reason} for ${task.milestone || `task ${taskIndex + 1}`}. Retry Deploy Escrow.`);
                }
                progress.taskConfirmedCount += 1;
                persistDeployProgress(progress);
            }

            // Step 4: Update backend
            setDeployStatusMessage('Onchain steps confirmed. Syncing backend campaign state...');
            await fundCampaign(campaign.id, totalPayout, progress.fundTxId, onchainCampaignId, address);

            // Refresh campaign data
            const updated = await getCampaign(campaign.id);
            setCampaign(updated);
            setDeployed(true);
            setDeployStatusMessage('Escrow deployed and funded successfully.');
            clearDeployProgress(campaign.id);
        } catch (error) {
            console.error('Deploy failed:', error);
            const message = error instanceof Error ? error.message : 'Deployment failed.';
            setDeployError(message);
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
        if (!address) {
            setTaskEditorMessage('Wallet address not found. Connect wallet first.');
            return;
        }
        if (!isOwnerWallet) {
            setTaskEditorMessage('Connect the campaign owner wallet to edit this draft campaign.');
            return;
        }
        const draft = taskDrafts[taskId];
        if (!draft) return;

        const payoutStx = Number.parseFloat(draft.payout_stx);
        if (!Number.isFinite(payoutStx) || payoutStx <= 0) {
            setTaskEditorMessage('Payout must be a positive USDCx amount.');
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
            }, address);

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
            setTaskEditorMessage(error instanceof Error ? error.message : 'Failed to save task changes.');
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
                {loadError && campaigns.length > 0 && (
                    <div className="card" style={{ marginBottom: '16px', padding: '16px', borderColor: 'var(--accent-warning)' }}>
                        <p style={{ color: 'var(--accent-warning)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                            {loadError}
                        </p>
                    </div>
                )}

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
                                        Funded: {(c.total_funded / 1000000).toFixed(2)} USDCx
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
                        <h3>{loadError ? 'Campaign Data Unavailable' : 'No Campaigns Yet'}</h3>
                        <p>
                            {loadError
                                ? 'The campaign list failed to load, so this is not an empty-project state.'
                                : 'Fetch alpha signals and convert one to a campaign to get started.'}
                        </p>
                        {loadError && (
                            <p style={{ marginTop: '8px', fontSize: '0.8rem' }}>
                                {loadError}
                            </p>
                        )}
                        <button className="btn btn-secondary" onClick={() => router.push('/alpha')} style={{ marginTop: '16px' }}>
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
                    <div className="stat-label">Total USDCx</div>
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
                    <div className="stat-label">Remaining USDCx</div>
                </div>
            </div>

            {/* Task List */}
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '16px' }}>
                Work Orders {campaign.status === 'draft' ? '(Editable)' : ''}
            </h3>
            {campaign.status === 'draft' && !isOwnerWallet && (
                <div className="card" style={{ marginBottom: '16px', padding: '16px', borderColor: 'var(--accent-warning)' }}>
                    <p style={{ color: 'var(--accent-warning)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                        Connect the campaign owner wallet to edit draft work orders or deploy this escrow.
                    </p>
                </div>
            )}
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
                            <span className="task-payout">{(task.payout / 1000000).toFixed(2)} USDCx</span>
                        </div>
                        {'milestone' in task && task.milestone && (
                            <div style={{ marginBottom: '8px' }}>
                                <span className="task-status open">{task.milestone}</span>
                            </div>
                        )}
                        {campaign.status === 'draft' && canEditDraftCampaign ? (
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
                                        <label className="form-label">Payout (USDCx)</label>
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
            {campaign.status === 'draft' && canEditDraftCampaign && (
                <div className="card" style={{ background: 'var(--accent-primary-dim)', borderColor: 'var(--accent-primary)', textAlign: 'center', padding: '32px' }}>
                    <h3 style={{ color: 'var(--accent-primary)', marginBottom: '8px' }}>
                        Deploy Escrow
                    </h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '8px' }}>
                        This will create the campaign onchain and fund the escrow with {(totalPayout / 1000000).toFixed(2)} USDCx.
                    </p>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', marginBottom: '20px' }}>
                        Contract: {contractName} · Network: Stacks Testnet
                    </p>
                    {deployStatusMessage && (
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', marginBottom: '10px' }}>
                            {deployStatusMessage}
                        </p>
                    )}
                    {deployError && (
                        <p style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>
                            {deployError}
                        </p>
                    )}
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
            {campaign.status === 'draft' && !canEditDraftCampaign && (
                <div className="card" style={{ textAlign: 'center', padding: '24px' }}>
                    <p style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>
                        Draft escrow deployment is only available to the campaign owner wallet.
                    </p>
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
                        ✓ Campaign funded with {(campaign.total_funded / 1000000).toFixed(2)} USDCx
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
