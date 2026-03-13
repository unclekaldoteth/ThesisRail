'use client';

interface WalletAddressEntry {
    address: string;
}

interface WalletStorageAddresses {
    stx?: WalletAddressEntry[];
    btc?: WalletAddressEntry[];
}

interface WalletResponseAddressEntry extends WalletAddressEntry {
    publicKey?: string;
    purpose?: string;
    symbol?: string;
}

interface StoredWalletState {
    addresses?: WalletStorageAddresses | WalletResponseAddressEntry[];
}

export interface WalletState {
    isConnected: boolean;
    address: string | null;
}

function isWalletAddressEntry(value: unknown): value is WalletAddressEntry {
    return Boolean(value) && typeof value === 'object' && typeof (value as WalletAddressEntry).address === 'string';
}

function extractAddressFromStorage(addresses: WalletStorageAddresses): string | null {
    const { stx, btc } = addresses;
    if (Array.isArray(stx) && stx.length > 0 && isWalletAddressEntry(stx[0])) return stx[0].address;
    if (Array.isArray(btc) && btc.length > 0 && isWalletAddressEntry(btc[0])) return btc[0].address;
    return null;
}

function extractAddressFromResponse(addresses: WalletResponseAddressEntry[]): string | null {
    const stxEntry = addresses.find((entry) => isWalletAddressEntry(entry) && entry.address.toUpperCase().startsWith('S'));
    if (stxEntry) return stxEntry.address;
    const firstEntry = addresses.find(isWalletAddressEntry);
    return firstEntry?.address || null;
}

export function resolveWalletAddress(stored: unknown): string | null {
    if (!stored || typeof stored !== 'object' || !('addresses' in stored)) return null;
    const { addresses } = stored as StoredWalletState;
    if (Array.isArray(addresses)) return extractAddressFromResponse(addresses);
    if (addresses && typeof addresses === 'object') return extractAddressFromStorage(addresses);
    return null;
}

async function loadConnectModule() {
    return import('@stacks/connect');
}

export async function connectWallet(): Promise<string | null> {
    try {
        const { connect, getLocalStorage } = await loadConnectModule();
        const response = await connect();
        const resolvedFromResponse = resolveWalletAddress(response);
        if (resolvedFromResponse) return resolvedFromResponse;
        return resolveWalletAddress(getLocalStorage() as StoredWalletState);
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
            address: resolveWalletAddress(getLocalStorage() as StoredWalletState),
        };
    } catch (error) {
        console.error('[Wallet] Connection check failed:', error);
        return { isConnected: false, address: null };
    }
}
