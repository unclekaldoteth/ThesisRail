import type { Campaign, Task } from '@/lib/api';

export interface TaskBoardEntry {
    campaign: Campaign;
    task: Task;
}

export function normalizeWalletAddress(value: string | null | undefined): string | null {
    const normalized = (value || '').trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
}

export function isCampaignExecutionOpen(status: Campaign['status']): boolean {
    return status === 'funded' || status === 'active';
}

export function isTaskTerminal(status: Task['status']): boolean {
    return status === 'approved' || status === 'cancelled';
}

export function isTaskPastDeadline(task: Pick<Task, 'deadline'>, now: number = Date.now()): boolean {
    const deadlineMs = Date.parse(task.deadline);
    return Number.isFinite(deadlineMs) && now > deadlineMs;
}

export function canCloseCampaign(campaign: Campaign): boolean {
    return isCampaignExecutionOpen(campaign.status)
        && campaign.tasks.every((task) => isTaskTerminal(task.status));
}

export function getVisibleTaskEntries(
    campaigns: Campaign[],
    role: 'owner' | 'executor',
    callerAddress: string | null | undefined
): TaskBoardEntry[] {
    const normalizedCaller = normalizeWalletAddress(callerAddress);
    if (!normalizedCaller) return [];

    const allTasks = campaigns.flatMap((campaign) =>
        campaign.tasks.map((task) => ({ campaign, task }))
    );

    if (role === 'executor') {
        return allTasks.filter(({ task, campaign }) =>
            isCampaignExecutionOpen(campaign.status) && (
                (task.status === 'open' && normalizeWalletAddress(campaign.owner) !== normalizedCaller) ||
                (task.status === 'claimed' && normalizeWalletAddress(task.executor) === normalizedCaller)
            )
        );
    }

    return allTasks.filter(({ campaign }) =>
        isCampaignExecutionOpen(campaign.status) &&
        normalizeWalletAddress(campaign.owner) === normalizedCaller
    );
}
