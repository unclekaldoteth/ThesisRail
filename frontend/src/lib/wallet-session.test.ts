import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWalletAddress } from './wallet-session';

test('resolveWalletAddress reads the flat connect() response shape', () => {
    const address = resolveWalletAddress({
        addresses: [
            { address: 'bc1ptestbtcaddress000000000000000000000000000', publicKey: 'btc-key' },
            { address: 'ST1TESTWALLETADDRESS0000000000000000000000000', publicKey: 'stx-key' },
        ],
    });

    assert.equal(address, 'ST1TESTWALLETADDRESS0000000000000000000000000');
});

test('resolveWalletAddress reads the cached localStorage shape', () => {
    const address = resolveWalletAddress({
        addresses: {
            stx: [{ address: 'ST2CACHEDWALLETADDRESS000000000000000000000000' }],
            btc: [{ address: 'bc1pcachedbtcaddress00000000000000000000000000' }],
        },
    });

    assert.equal(address, 'ST2CACHEDWALLETADDRESS000000000000000000000000');
});
