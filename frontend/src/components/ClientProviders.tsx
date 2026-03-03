'use client';

import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from 'react';
import Link from 'next/link';

// Wallet context
interface WalletContextType {
    isConnected: boolean;
    address: string | null;
    role: 'owner' | 'executor';
    setRole: (role: 'owner' | 'executor') => void;
    connect: () => Promise<void>;
    disconnect: () => void;
}

const WalletContext = createContext<WalletContextType>({
    isConnected: false,
    address: null,
    role: 'owner',
    setRole: () => { },
    connect: async () => { },
    disconnect: () => { },
});

export const useWallet = () => useContext(WalletContext);

function Navbar() {
    const { isConnected, address, connect, disconnect } = useWallet();

    return (
        <nav className="navbar">
            <div className="navbar-inner">
                <div className="navbar-brand">
                    <Link href="/">
                        <h1>⟁ ThesisRail</h1>
                    </Link>
                    <span className="tagline">From Alpha to Payout.</span>
                </div>
                <ul className="navbar-nav">
                    <li><Link href="/">Alpha</Link></li>
                    <li><Link href="/campaign">Campaigns</Link></li>
                    <li><Link href="/tasks">Tasks</Link></li>
                </ul>
                <div className="navbar-actions">
                    {isConnected ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-primary)' }}>
                                {address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : 'Connected'}
                            </span>
                            <button className="btn btn-ghost btn-sm" onClick={disconnect}>
                                Disconnect
                            </button>
                        </div>
                    ) : (
                        <button className="btn btn-primary btn-sm" onClick={connect}>
                            Connect Wallet
                        </button>
                    )}
                </div>
            </div>
        </nav>
    );
}

export default function ClientProviders({ children }: { children: ReactNode }) {
    const [isConnectedState, setIsConnected] = useState(false);
    const [address, setAddress] = useState<string | null>(null);
    const [role, setRole] = useState<'owner' | 'executor'>('owner');

    useEffect(() => {
        // Dynamic import to avoid SSR issues
        import('@/lib/wallet').then(({ checkWalletConnection }) => {
            const state = checkWalletConnection();
            setIsConnected(state.isConnected);
            setAddress(state.address);
        });
    }, []);

    const handleConnect = useCallback(async () => {
        const { connectWallet } = await import('@/lib/wallet');
        const addr = await connectWallet();
        if (addr) {
            setIsConnected(true);
            setAddress(addr);
        }
    }, []);

    const handleDisconnect = useCallback(async () => {
        const { disconnectWallet } = await import('@/lib/wallet');
        disconnectWallet();
        setIsConnected(false);
        setAddress(null);
    }, []);

    return (
        <WalletContext.Provider value={{
            isConnected: isConnectedState,
            address,
            role,
            setRole,
            connect: handleConnect,
            disconnect: handleDisconnect,
        }}>
            <Navbar />
            <main className="page">
                <div className="container">
                    {children}
                </div>
            </main>
        </WalletContext.Provider>
    );
}
