/**
 * Reddit Ingestion Module
 * Fetches posts from Reddit's public JSON API for crypto/web3 alpha signals.
 */

export interface RedditPost {
    id: string;
    title: string;
    selftext: string;
    score: number;
    url: string;
    permalink: string;
    subreddit: string;
    author: string;
    created_utc: number;
    num_comments: number;
    upvote_ratio: number;
    link_flair_text: string | null;
}

const TARGET_SUBREDDITS = [
    'cryptocurrency',
    'CryptoMarkets',
    'defi',
    'web3',
    'ethfinance',
    'Bitcoin',
];

interface RedditListingChild {
    data?: {
        id?: unknown;
        title?: unknown;
        selftext?: unknown;
        score?: unknown;
        url?: unknown;
        permalink?: unknown;
        subreddit?: unknown;
        author?: unknown;
        created_utc?: unknown;
        num_comments?: unknown;
        upvote_ratio?: unknown;
        link_flair_text?: unknown;
    };
}

interface RedditListingResponse {
    data?: {
        children?: RedditListingChild[];
    };
}

function asString(value: unknown, fallback: string = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function fetchSubreddit(subreddit: string, window: string, limit: number): Promise<RedditPost[]> {
    const timeFilter = window === '24h' ? 'day' : window === '7d' ? 'week' : 'day';

    try {
        const response = await fetch(
            `https://www.reddit.com/r/${subreddit}/top.json?t=${timeFilter}&limit=${limit}`,
            {
                headers: {
                    'User-Agent': 'ThesisRail/1.0 (hackathon demo)',
                },
            }
        );

        if (!response.ok) {
            console.warn(`[Reddit] Failed to fetch /r/${subreddit}: ${response.status}`);
            return [];
        }

        const data = (await response.json()) as RedditListingResponse;
        const children = Array.isArray(data.data?.children) ? data.data.children : [];
        const posts: RedditPost[] = children.map((child) => {
            const payload = child.data ?? {};
            const permalink = asString(payload.permalink, '');

            return {
                id: asString(payload.id),
                title: asString(payload.title, 'Untitled'),
                selftext: asString(payload.selftext).substring(0, 500),
                score: asNumber(payload.score),
                url: asString(payload.url),
                permalink: `https://reddit.com${permalink}`,
                subreddit: asString(payload.subreddit),
                author: asString(payload.author, 'unknown'),
                created_utc: asNumber(payload.created_utc),
                num_comments: asNumber(payload.num_comments),
                upvote_ratio: asNumber(payload.upvote_ratio),
                link_flair_text: typeof payload.link_flair_text === 'string' ? payload.link_flair_text : null,
            };
        });

        return posts;
    } catch (error) {
        console.error(`[Reddit] Error fetching /r/${subreddit}:`, error);
        return [];
    }
}

export async function fetchRedditAlpha(window: string = '24h', limit: number = 20): Promise<RedditPost[]> {
    const perSub = Math.ceil(limit / TARGET_SUBREDDITS.length);
    const promises = TARGET_SUBREDDITS.map((sub) => fetchSubreddit(sub, window, perSub));
    const results = await Promise.all(promises);
    const allPosts = results.flat();

    // Sort by engagement score (score * upvote_ratio + comments)
    allPosts.sort((a, b) => {
        const scoreA = a.score * a.upvote_ratio + a.num_comments * 2;
        const scoreB = b.score * b.upvote_ratio + b.num_comments * 2;
        return scoreB - scoreA;
    });

    return allPosts.slice(0, limit);
}
