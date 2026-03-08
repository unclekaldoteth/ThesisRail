import assert from 'node:assert/strict';
import test from 'node:test';
import { Pc } from '@stacks/transactions';
import { buildFtTransferPostConditionHex, buildSip10AssetIdentifier } from './wallet';

const SENDER = 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM';
const USDCX_CONTRACT_ID = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx';

test('buildSip10AssetIdentifier targets the real USDCx token asset', () => {
    assert.equal(
        buildSip10AssetIdentifier(USDCX_CONTRACT_ID),
        'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx::usdcx-token'
    );
});

test('buildFtTransferPostConditionHex encodes the expected USDCx asset', () => {
    const encoded = buildFtTransferPostConditionHex(SENDER, 1_000_000, USDCX_CONTRACT_ID);
    const decoded = Pc.fromHex(encoded) as {
        type: string;
        address: string;
        amount: string;
        asset: string;
        condition: string;
    };

    assert.equal(decoded.type, 'ft-postcondition');
    assert.equal(decoded.address, SENDER);
    assert.equal(decoded.amount, '1000000');
    assert.equal(decoded.condition, 'eq');
    assert.equal(
        decoded.asset,
        'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx::usdcx-token'
    );
});
