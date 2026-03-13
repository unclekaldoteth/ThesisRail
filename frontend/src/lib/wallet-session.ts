'use client';

interface WalletAddressEntry {
    address: string;
}

interface StoredWalletState {
    addresses?: {
        stx?: WalletAddressEntry[];
        btc?: WalletAddressEntry[];
    };
}

export interface WalletState {
    isConnected: boolean;
    address: string | null;
}

function extractAddress(stored: StoredWalletState | null | undefined): string | null {
    if (!stored?.addresses) return null;
    const { stx, btc } = stored.addresses;
    if (Array.isArray(stx) && stx.length > 0) return stx[0].address;
    if (Array.isArray(btc) && btc.length > 0) return btc[0].address;
    return null;
}

async function loadConnectModule() {
    return import('@stacks/connect');
}

export async function connectWallet(): Promise<string | null> {
    try {
        const { connect, getLocalStorage } = await loadConnectModule();
        const response = await connect();
        if (response && typeof response === 'object' && 'addresses' in response) {
            const stored = response as StoredWalletState;
            return extractAddress(stored);
        }
        return extractAddress(getLocalStorage() as StoredWalletState);
    } catch (error) {
        console.error('[Wallet] Connection failed:', error);
        return null;
    }
}

export async function disconnectWallet(): Promise<void> {
    try {
        const { disconnect } = await loadConnectModule();
        disconnect();
    } catch (error) {
        console.error('[Wallet] Disconnect failed:', error);
    }
}

export async function checkWalletConnection(): Promise<WalletState> {
    try {
        const { isConnected, getLocalStorage } = await loadConnectModule();
        if (!isConnected()) {
            return { isConnected: false, address: null };
        }
        return {
            isConnected: true,
            address: extractAddress(getLocalStorage() as StoredWalletState),
        };
    } catch (error) {
        console.error('[Wallet] Connection check failed:', error);
        return { isConnected: false, address: null };
    }
}
