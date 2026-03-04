'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getAlphaCard, convertToCampaign, AlphaCard } from '@/lib/api';
import { useWallet } from '@/components/ClientProviders';

function AlphaScoreBadge({ score }: { score: number }) {
    const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
    return <div className={`alpha-score ${level}`} style={{ width: 64, height: 64, fontSize: '1.3rem' }}>{score}</div>;
}

export default function AlphaDetailScreen() {
    const params = useParams();
    const router = useRouter();
    const { address } = useWallet();
    const [card, setCard] = useState<AlphaCard | null>(null);
    const [loading, setLoading] = useState(true);
    const [converting, setConverting] = useState(false);

    useEffect(() => {
        const load = async () => {
            if (params.id) {
                const data = await getAlphaCard(params.id as string);
                setCard(data);
            }
            setLoading(false);
        };
        void load();
    }, [params.id]);

    const handleConvert = async () => {
        if (!card) return;
        setConverting(true);
        try {
            if (!address) {
                throw new Error('Wallet address not found. Connect wallet first.');
            }
            const campaign = await convertToCampaign(card.id, address);
            router.push(`/campaign?id=${campaign.id}`);
        } catch (error) {
            console.error('Convert failed:', error);
        } finally {
            setConverting(false);
        }
    };

    if (loading) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    if (!card) {
        return (
            <div className="empty-state">
                <h3>Alpha Card Not Found</h3>
                <p>This card may have expired or the ID is invalid. Fetch new alpha signals first.</p>
                <button className="btn btn-secondary" onClick={() => router.push('/')} style={{ marginTop: '16px' }}>
                    Back to Dashboard
                </button>
            </div>
        );
    }

    return (
        <>
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/')} style={{ marginBottom: '24px' }}>
                Back to Alpha Dashboard
            </button>

            <div className="card" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '24px', marginBottom: '24px' }}>
                    <AlphaScoreBadge score={card.alpha_score} />
                    <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                            <span className="alpha-card-source">{card.source}</span>
                            <span className="alpha-tag time-window">Time Window: {card.time_window}</span>
                        </div>
                        <h2 style={{ fontSize: '1.2rem', lineHeight: 1.4 }}>{card.source_title}</h2>
                        <p style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '4px' }}>
                            by {card.source_author} · {new Date(card.created_at).toLocaleString()}
                        </p>
                    </div>
                </div>
            </div>

            <div className="alpha-detail-grid">
                <div>
                    <div className="detail-section">
                        <h3>Operational Format (Claim -&gt; Evidence -&gt; Action -&gt; Invalidation)</h3>
                        <div className="evidence-list">
                            <div className="evidence-item" style={{ color: 'var(--text-secondary)' }}>
                                <strong style={{ minWidth: '110px' }}>Claim</strong>
                                <span>{card.thesis}</span>
                            </div>
                            <div className="evidence-item" style={{ color: 'var(--text-secondary)' }}>
                                <strong style={{ minWidth: '110px' }}>Evidence</strong>
                                {card.evidence_links[0] ? (
                                    <a href={card.evidence_links[0]} target="_blank" rel="noopener noreferrer">
                                        {card.evidence_links[0]}
                                    </a>
                                ) : (
                                    <span>No evidence link provided.</span>
                                )}
                            </div>
                            <div className="evidence-item" style={{ color: 'var(--text-secondary)' }}>
                                <strong style={{ minWidth: '110px' }}>Action</strong>
                                <span>{card.content_angles[0] || 'Convert to Campaign, deploy Escrow, then execute Milestone tasks with Proof.'}</span>
                            </div>
                            <div className="evidence-item" style={{ color: 'var(--text-secondary)' }}>
                                <strong style={{ minWidth: '110px' }}>Invalidation</strong>
                                <span>{card.invalidation_rule}</span>
                            </div>
                        </div>
                    </div>

                    <div className="detail-section">
                        <h3>Thesis</h3>
                        <div className="detail-content">{card.thesis}</div>
                    </div>

                    <div className="detail-section">
                        <h3>Catalyst</h3>
                        <div className="detail-content">{card.catalyst}</div>
                    </div>

                    <div className="detail-section">
                        <h3>Evidence</h3>
                        <ul className="evidence-list">
                            {card.evidence_links.map((link, i) => (
                                <li key={i} className="evidence-item">
                                    <span>Link</span>
                                    <a href={link} target="_blank" rel="noopener noreferrer">{link.length > 72 ? `${link.substring(0, 72)}...` : link}</a>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div className="detail-section">
                        <h3>Action Angles</h3>
                        <ul className="evidence-list">
                            {card.content_angles.map((angle, i) => (
                                <li key={i} className="evidence-item" style={{ color: 'var(--text-secondary)' }}>
                                    <span>Angle</span> {angle}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                <div>
                    <div className="detail-section">
                        <h3>Risk</h3>
                        <ul className="risk-list">
                            {card.risks.map((risk, i) => (
                                <li key={i} className="risk-item">{risk}</li>
                            ))}
                        </ul>
                    </div>

                    <div className="detail-section">
                        <h3>Invalidation</h3>
                        <div className="card" style={{ background: 'var(--accent-danger-dim)', borderColor: 'var(--accent-danger)', padding: '16px' }}>
                            <p style={{ color: 'var(--accent-danger)', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
                                {card.invalidation_rule}
                            </p>
                        </div>
                    </div>

                    <div className="card" style={{ background: 'var(--accent-primary-dim)', borderColor: 'var(--accent-primary)', textAlign: 'center', padding: '32px' }}>
                        <h3 style={{ color: 'var(--accent-primary)', marginBottom: '12px', textTransform: 'none', fontSize: '1rem' }}>
                            Execution Path
                        </h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '20px' }}>
                            Convert this signal into campaign Milestones with defined payout, deadline, criteria, and Escrow accountability.
                        </p>
                        <button
                            className="btn btn-primary btn-lg"
                            onClick={handleConvert}
                            disabled={converting}
                            style={{ width: '100%' }}
                        >
                            {converting ? 'Converting...' : 'Convert to Campaign'}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
