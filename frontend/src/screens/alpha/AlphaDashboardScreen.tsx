'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/components/ClientProviders';
import { fetchAlphaCards, convertToCampaign, AlphaCard, PaymentRequirements } from '@/lib/api';

type PaidFetchState = 'idle' | 'requesting' | 'payment_required' | 'paying' | 'loaded' | 'error';

const paidFetchLabels: Record<PaidFetchState, string> = {
  idle: 'Ready',
  requesting: 'Requesting',
  payment_required: 'Payment Required',
  paying: 'Paying',
  loaded: 'Paid / Loaded',
  error: 'Error',
};

function AlphaScoreBadge({ score }: { score: number }) {
  const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return <div className={`alpha-score ${level}`}>{score}</div>;
}

function toShortText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.substring(0, maxLen - 3)}...`;
}

function AlphaCardComponent({
  card,
  onOpen,
  onConvert,
  isConverting,
}: {
  card: AlphaCard;
  onOpen: () => void;
  onConvert: () => void;
  isConverting: boolean;
}) {
  const firstEvidence = card.evidence_links[0] || 'No evidence link';
  const firstAction = card.content_angles[0] || 'Convert to Campaign and execute Milestones with Proof.';
  const riskSummary = card.risks[0] || 'Execution risk not clearly defined';

  return (
    <div className="alpha-card" onClick={onOpen}>
      <div className="alpha-card-header">
        <AlphaScoreBadge score={card.alpha_score} />
        <span className="alpha-card-source">{card.source}</span>
      </div>

      <span className="alpha-op-key" style={{ marginBottom: '4px', display: 'inline-block' }}>Thesis</span>
      <div className="alpha-card-thesis">{card.thesis}</div>

      <div className="alpha-card-meta">
        <span className="alpha-tag catalyst">Catalyst: {toShortText(card.catalyst, 52)}</span>
        <span className="alpha-tag time-window">Time Window: {card.time_window}</span>
      </div>

      <div className="alpha-op-grid">
        <div className="alpha-op-row">
          <span className="alpha-op-key">Claim</span>
          <span className="alpha-op-value">{toShortText(card.thesis, 100)}</span>
        </div>
        <div className="alpha-op-row">
          <span className="alpha-op-key">Evidence</span>
          <a
            href={firstEvidence}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="alpha-op-value-link"
          >
            {toShortText(firstEvidence, 64)}
          </a>
        </div>
        <div className="alpha-op-row">
          <span className="alpha-op-key">Action</span>
          <span className="alpha-op-value">{toShortText(firstAction, 100)}</span>
        </div>
        <div className="alpha-op-row">
          <span className="alpha-op-key">Invalidation</span>
          <span className="alpha-op-value">{toShortText(card.invalidation_rule, 100)}</span>
        </div>
        <div className="alpha-op-row">
          <span className="alpha-op-key">Risk</span>
          <span className="alpha-op-value">{toShortText(riskSummary, 100)}</span>
        </div>
      </div>

      <div className="alpha-card-footer">
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
          by {card.source_author}
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            Thesis Detail
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onConvert();
            }}
            disabled={isConverting}
          >
            {isConverting ? 'Converting...' : 'Convert to Campaign'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({
  requirements,
  onPay,
  onCancel,
  isPaying,
}: {
  requirements: PaymentRequirements;
  onPay: () => void;
  onCancel: () => void;
  isPaying: boolean;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ color: 'var(--accent-warning)' }}>402 Payment Required</h2>
        <div className="modal-body">
          <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.85rem' }}>
            Paid request required for alpha retrieval. Retry with payment proof to receive Alpha Cards.
          </p>
          <div className="payment-detail"><span className="label">Protocol</span><span className="value">x402</span></div>
          <div className="payment-detail"><span className="label">Network</span><span className="value">{requirements.network}</span></div>
          <div className="payment-detail"><span className="label">Token</span><span className="value">{requirements.token}</span></div>
          <div className="payment-detail"><span className="label">Amount</span><span className="value">{(parseInt(requirements.amount, 10) / 1000000).toFixed(2)} STX</span></div>
          <div className="payment-detail"><span className="label">Receiver</span><span className="value mono" style={{ fontSize: '0.7rem' }}>{requirements.receiver.substring(0, 12)}...{requirements.receiver.substring(requirements.receiver.length - 6)}</span></div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={isPaying}>Cancel</button>
          <button className="btn btn-primary" onClick={onPay} disabled={isPaying}>
            {isPaying ? 'Processing...' : 'Pay & Fetch Alpha'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AlphaDashboardScreen() {
  const { isConnected, address } = useWallet();
  const router = useRouter();
  const [cards, setCards] = useState<AlphaCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState('both');
  const [window, setWindow] = useState('24h');
  const [n, setN] = useState(20);
  const [niche] = useState('crypto-web3-alpha');
  const [paymentRequirements, setPaymentRequirements] = useState<PaymentRequirements | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [convertingCardId, setConvertingCardId] = useState<string | null>(null);
  const [paidFetchState, setPaidFetchState] = useState<PaidFetchState>('idle');
  const [paidFetchMessage, setPaidFetchMessage] = useState('Ready for paid signal retrieval.');

  const handleFetchAlpha = useCallback(async (paymentProof?: string) => {
    setPaidFetchState('requesting');
    setPaidFetchMessage(paymentProof ? 'Retrying with payment proof...' : 'Requesting paid alpha signals...');
    setLoading(true);
    try {
      const result = await fetchAlphaCards({ source, window, n }, paymentProof);
      if (result.state === 'payment_required') {
        const invalidProof = result.reason === 'invalid_payment_proof';
        setPaymentRequirements(result.requirements);
        setPaidFetchState('payment_required');
        setPaidFetchMessage(
          invalidProof
            ? 'Payment proof is not confirmed yet. Wait for confirmation and retry.'
            : 'Payment required. Complete STX transfer to unlock Alpha Cards.'
        );
      } else {
        setCards(result.cards);
        setPaymentRequirements(null);
        setPaidFetchState('loaded');
        setPaidFetchMessage(`Paid / Loaded • ${result.cards.length} Alpha Cards`);
      }
    } catch (error) {
      console.error('Failed to fetch alpha:', error);
      setPaidFetchState('error');
      setPaidFetchMessage('Fetch failed. Check backend and wallet network, then retry.');
    } finally {
      setLoading(false);
    }
  }, [source, window, n]);

  const handlePay = async () => {
    if (!paymentRequirements) return;
    setIsPaying(true);
    setPaidFetchState('paying');
    setPaidFetchMessage('Submitting STX transfer...');
    try {
      const { transferSTX } = await import('@/lib/wallet');
      const amount = Number.parseInt(paymentRequirements.amount, 10);
      if (!Number.isFinite(amount) || amount <= 0) {
        setPaidFetchState('error');
        setPaidFetchMessage('Invalid payment amount returned by backend challenge.');
        return;
      }
      const txId = await transferSTX(
        amount,
        paymentRequirements.receiver
      );
      if (txId) {
        setPaidFetchMessage('Transfer submitted. Retrying paid fetch now...');
        await handleFetchAlpha(JSON.stringify({ txId }));
      } else {
        setPaidFetchState('error');
        setPaidFetchMessage('Wallet did not return a transfer transaction id.');
      }
    } catch (error) {
      console.error('Payment failed:', error);
      setPaidFetchState('error');
      setPaidFetchMessage('Payment failed. Re-open wallet and try again.');
    } finally {
      setIsPaying(false);
    }
  };

  const handleCardOpen = (card: AlphaCard) => {
    router.push(`/alpha/${card.id}`);
  };

  const handleCancelPayment = () => {
    setPaymentRequirements(null);
    if (cards.length > 0) {
      setPaidFetchState('loaded');
      setPaidFetchMessage(`Paid / Loaded • ${cards.length} Alpha Cards`);
      return;
    }
    setPaidFetchState('idle');
    setPaidFetchMessage('Payment challenge dismissed. Fetch Alpha (Paid) when ready.');
  };

  const handleCardConvert = async (card: AlphaCard) => {
    setConvertingCardId(card.id);
    try {
      if (!address) {
        throw new Error('Wallet address not found. Connect wallet first.');
      }
      const campaign = await convertToCampaign(card.id, address);
      router.push(`/campaign?id=${campaign.id}`);
    } catch (error) {
      console.error('Convert failed:', error);
    } finally {
      setConvertingCardId(null);
    }
  };

  return (
    <>
      {paymentRequirements && (
        <PaymentModal
          requirements={paymentRequirements}
          onPay={handlePay}
          onCancel={handleCancelPayment}
          isPaying={isPaying}
        />
      )}

      <div className="page-header">
        <h2>ThesisRail Alpha Dashboard</h2>
        <p>From Alpha to Payout. Pay-per-signal. Convert to campaign. Settle onchain.</p>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">Niche</span>
          <select className="filter-select" value={niche} disabled>
            <option value="crypto-web3-alpha">crypto/web3 alpha</option>
          </select>
        </div>

        <div className="filter-group">
          <span className="filter-label">Source</span>
          <select className="filter-select" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="both">both</option>
            <option value="reddit">reddit</option>
            <option value="youtube">youtube</option>
            <option value="x" disabled>x (coming soon)</option>
          </select>
        </div>

        <div className="filter-group">
          <span className="filter-label">Window</span>
          <select className="filter-select" value={window} onChange={(e) => setWindow(e.target.value)}>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
          </select>
        </div>

        <div className="filter-group">
          <span className="filter-label">Count</span>
          <select className="filter-select" value={n} onChange={(e) => setN(parseInt(e.target.value, 10))}>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </div>

        <div style={{ marginLeft: 'auto' }}>
          <button
            className="btn btn-primary"
            onClick={() => handleFetchAlpha()}
            disabled={loading || isPaying || !isConnected}
          >
            {loading ? 'Fetching...' : isConnected ? 'Fetch Alpha (Paid)' : 'Connect Wallet to Fetch'}
          </button>
          <div className={`fetch-state-pill ${paidFetchState}`}>{paidFetchLabels[paidFetchState]}</div>
          <div className="fetch-state-message">{paidFetchMessage}</div>
        </div>
      </div>

      {cards.length > 0 ? (
        <>
          <div className="stats-row" style={{ marginBottom: 'var(--space-xl)' }}>
            <div className="stat-card">
              <div className="stat-value">{cards.length}</div>
              <div className="stat-label">Signals</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{Math.round(cards.reduce((s, c) => s + c.alpha_score, 0) / cards.length)}</div>
              <div className="stat-label">Alpha Score Avg</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{cards.filter((c) => c.alpha_score >= 70).length}</div>
              <div className="stat-label">Score &gt;= 70</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{new Set(cards.map((c) => c.source)).size}</div>
              <div className="stat-label">Sources</div>
            </div>
          </div>

          <div className="alpha-grid">
            {cards.map((card) => (
              <AlphaCardComponent
                key={card.id}
                card={card}
                onOpen={() => handleCardOpen(card)}
                onConvert={() => handleCardConvert(card)}
                isConverting={convertingCardId === card.id}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <h3>No Alpha Signals Yet</h3>
          <p>Use Fetch Alpha to start the x402 payment flow and retrieve operational Alpha Cards.</p>
          <p style={{ marginTop: '8px', fontSize: '0.8rem' }}>
            {isConnected ? 'Wallet connected. Ready for paid fetch.' : 'Connect wallet first for x402 payment and escrow actions.'}
          </p>
        </div>
      )}
    </>
  );
}
