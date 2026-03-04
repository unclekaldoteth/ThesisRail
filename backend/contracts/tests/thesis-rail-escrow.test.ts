import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

// Simnet accounts (Clarinet devnet defaults)
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;  // Campaign owner
const wallet2 = accounts.get("wallet_2")!;  // Executor
const wallet3 = accounts.get("wallet_3")!;  // Unauthorized user

const contractName = "thesis-rail-escrow";
const metadataHash = Uint8Array.from(Array(32).fill(0xAB));
const criteriaHash = Uint8Array.from(Array(32).fill(0xCD));
const proofHash = Uint8Array.from(Array(32).fill(0xEF));

// ============================================================
// Helper: create + fund a campaign as wallet1
// ============================================================
function createAndFundCampaign(amount: number = 10_000_000) {
    // Create campaign
    const createResult = simnet.callPublicFn(
        contractName,
        "create-campaign",
        [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)],
        wallet1
    );
    const campaignId = (createResult.result as any).value;

    // Fund campaign
    const fundResult = simnet.callPublicFn(
        contractName,
        "fund-campaign",
        [Cl.uint(1), Cl.uint(amount)],
        wallet1
    );
    return { createResult, fundResult, campaignId };
}

// Helper: full setup — create, fund, add task
function fullSetup(payout: number = 1_000_000) {
    createAndFundCampaign();

    const addResult = simnet.callPublicFn(
        contractName,
        "add-task",
        [Cl.uint(1), Cl.uint(payout), Cl.uint(100_000), Cl.buffer(criteriaHash)],
        wallet1
    );
    return addResult;
}

// ============================================================
// Tests
// ============================================================

describe("ThesisRail Escrow Contract", () => {

    // ==========================================================
    // create-campaign
    // ==========================================================
    describe("create-campaign", () => {
        it("should create a campaign and return campaign id u1", () => {
            const result = simnet.callPublicFn(
                contractName,
                "create-campaign",
                [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)],
                wallet1
            );
            expect(result.result).toBeOk(Cl.uint(1));
        });

        it("should increment campaign counter for each new campaign", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            expect(result.result).toBeOk(Cl.uint(2));
        });

        it("should store campaign with correct owner and status=draft(0)", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val.owner).toStrictEqual(Cl.principal(wallet1));
            expect(val.status).toStrictEqual(Cl.uint(0));
            expect(val["total-funded"]).toStrictEqual(Cl.uint(0));
            expect(val["remaining-balance"]).toStrictEqual(Cl.uint(0));
            expect(val["allocated-balance"]).toStrictEqual(Cl.uint(0));
            expect(val["task-count"]).toStrictEqual(Cl.uint(0));
        });

        it("should allow any user to create a campaign", () => {
            const result = simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet2), Cl.none(), Cl.buffer(metadataHash)], wallet2);
            expect(result.result).toBeOk(Cl.uint(1));
        });

        it("should fail when tx-sender is not equal to owner argument", () => {
            const result = simnet.callPublicFn(
                contractName,
                "create-campaign",
                [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)],
                wallet2
            );
            expect(result.result).toBeErr(Cl.uint(100)); // ERR_NOT_AUTHORIZED
        });
    });

    // ==========================================================
    // fund-campaign
    // ==========================================================
    describe("fund-campaign", () => {
        it("should fund a campaign and update status to funded(1)", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(
                contractName,
                "fund-campaign",
                [Cl.uint(1), Cl.uint(5_000_000)],
                wallet1
            );
            expect(result.result).toBeOk(Cl.bool(true));

            // Check balance updated
            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val["total-funded"]).toStrictEqual(Cl.uint(5_000_000));
            expect(val["remaining-balance"]).toStrictEqual(Cl.uint(5_000_000));
            expect(val["allocated-balance"]).toStrictEqual(Cl.uint(0));
            expect(val.status).toStrictEqual(Cl.uint(1));
        });

        it("should fail if not the owner", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(
                contractName,
                "fund-campaign",
                [Cl.uint(1), Cl.uint(5_000_000)],
                wallet2  // Not the owner
            );
            expect(result.result).toBeErr(Cl.uint(100)); // ERR_NOT_AUTHORIZED
        });

        it("should fail for campaign that does not exist", () => {
            const result = simnet.callPublicFn(
                contractName,
                "fund-campaign",
                [Cl.uint(999), Cl.uint(5_000_000)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(101)); // ERR_CAMPAIGN_NOT_FOUND
        });

        it("should fail if amount is zero", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(
                contractName,
                "fund-campaign",
                [Cl.uint(1), Cl.uint(0)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(103)); // ERR_INSUFFICIENT_FUNDS
        });

        it("should allow funding multiple times (cumulative)", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            simnet.callPublicFn(contractName, "fund-campaign", [Cl.uint(1), Cl.uint(3_000_000)], wallet1);
            simnet.callPublicFn(contractName, "fund-campaign", [Cl.uint(1), Cl.uint(2_000_000)], wallet1);

            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val["total-funded"]).toStrictEqual(Cl.uint(5_000_000));
            expect(val["remaining-balance"]).toStrictEqual(Cl.uint(5_000_000));
        });
    });

    // ==========================================================
    // add-task
    // ==========================================================
    describe("add-task", () => {
        it("should add a task to a funded campaign", () => {
            createAndFundCampaign();
            const result = simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet1
            );
            expect(result.result).toBeOk(Cl.uint(1)); // task-id 1
        });

        it("should update campaign status to active(2) and increment task count", () => {
            createAndFundCampaign();
            simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet1
            );

            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val.status).toStrictEqual(Cl.uint(2));  // active
            expect(val["task-count"]).toStrictEqual(Cl.uint(1));
        });

        it("should fail if not the owner", () => {
            createAndFundCampaign();
            const result = simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet2
            );
            expect(result.result).toBeErr(Cl.uint(100));
        });

        it("should fail if campaign is not funded (draft status)", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(104)); // ERR_INVALID_STATUS
        });

        it("should fail if payout exceeds remaining balance", () => {
            createAndFundCampaign(1_000_000); // fund with 1 STX
            const result = simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(2_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], // 2 STX payout
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(103)); // ERR_INSUFFICIENT_FUNDS
        });

        it("should allow multiple tasks", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            const result = simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            expect(result.result).toBeOk(Cl.uint(2)); // task-id 2
        });

        it("should fail when cumulative task payouts exceed available unallocated escrow", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(3_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            const result = simnet.callPublicFn(
                contractName,
                "add-task",
                [Cl.uint(1), Cl.uint(3_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(103)); // ERR_INSUFFICIENT_FUNDS
        });
    });

    // ==========================================================
    // claim-task
    // ==========================================================
    describe("claim-task", () => {
        it("should allow executor to claim an open task", () => {
            fullSetup();
            const result = simnet.callPublicFn(
                contractName,
                "claim-task",
                [Cl.uint(1), Cl.uint(1)],
                wallet2
            );
            expect(result.result).toBeOk(Cl.bool(true));
        });

        it("should update task status to claimed(1) and set executor", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);

            const task = simnet.callReadOnlyFn(contractName, "get-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            const val = (task.result as any).value.value;
            expect(val.status).toStrictEqual(Cl.uint(1)); // claimed
            expect(val.executor).toStrictEqual(Cl.some(Cl.principal(wallet2)));
        });

        it("should fail if owner tries to claim own task (ERR_SELF_CLAIM)", () => {
            fullSetup();
            const result = simnet.callPublicFn(
                contractName,
                "claim-task",
                [Cl.uint(1), Cl.uint(1)],
                wallet1  // Owner trying to claim
            );
            expect(result.result).toBeErr(Cl.uint(106)); // ERR_SELF_CLAIM
        });

        it("should fail if task is already claimed", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            const result = simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet3);
            expect(result.result).toBeErr(Cl.uint(105)); // ERR_ALREADY_CLAIMED
        });

        it("should fail for nonexistent task", () => {
            fullSetup();
            const result = simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(99)], wallet2);
            expect(result.result).toBeErr(Cl.uint(102)); // ERR_TASK_NOT_FOUND
        });
    });

    // ==========================================================
    // submit-proof
    // ==========================================================
    describe("submit-proof", () => {
        it("should allow executor to submit proof for claimed task", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);

            const result = simnet.callPublicFn(
                contractName,
                "submit-proof",
                [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)],
                wallet2
            );
            expect(result.result).toBeOk(Cl.bool(true));
        });

        it("should update task status to proof_submitted(2) and store proof hash", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);

            const task = simnet.callReadOnlyFn(contractName, "get-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            const val = (task.result as any).value.value;
            expect(val.status).toStrictEqual(Cl.uint(2)); // proof_submitted
            expect(val["proof-hash"]).toStrictEqual(Cl.some(Cl.buffer(proofHash)));
        });

        it("should fail if not the executor", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            const result = simnet.callPublicFn(
                contractName,
                "submit-proof",
                [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)],
                wallet3  // Not the executor
            );
            expect(result.result).toBeErr(Cl.uint(100)); // ERR_NOT_AUTHORIZED
        });

        it("should fail if task is not in claimed status", () => {
            fullSetup();
            // Task is still open (status=0), not claimed
            const result = simnet.callPublicFn(
                contractName,
                "submit-proof",
                [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)],
                wallet2
            );
            expect(result.result).toBeErr(Cl.uint(104)); // ERR_INVALID_STATUS
        });
    });

    // ==========================================================
    // approve-task (triggers payout)
    // ==========================================================
    describe("approve-task", () => {
        it("should approve task and transfer payout to executor", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);

            const result = simnet.callPublicFn(
                contractName,
                "approve-task",
                [Cl.uint(1), Cl.uint(1)],
                wallet1  // Owner approves
            );
            expect(result.result).toBeOk(Cl.bool(true));

            // Check an STX transfer event occurred
            expect(result.events.length).toBeGreaterThan(0);
            const transferEvent = result.events.find(
                (e: any) => e.event === "stx_transfer_event"
            );
            expect(transferEvent).toBeDefined();
        });

        it("should update task status to approved(3)", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);
            simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet1);

            const task = simnet.callReadOnlyFn(contractName, "get-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            const val = (task.result as any).value.value;
            expect(val.status).toStrictEqual(Cl.uint(3));
        });

        it("should decrease campaign remaining balance by payout amount", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(2_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);
            simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet1);

            const balance = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(1)], wallet1);
            expect(balance.result).toBeOk(Cl.uint(3_000_000)); // 5M - 2M
        });

        it("should release allocated balance after approval", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(2_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);
            simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet1);

            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val["allocated-balance"]).toStrictEqual(Cl.uint(0));
        });

        it("should fail if not the owner", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            simnet.callPublicFn(contractName, "submit-proof", [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)], wallet2);

            const result = simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            expect(result.result).toBeErr(Cl.uint(100));
        });

        it("should fail if task is not in proof_submitted status", () => {
            fullSetup();
            simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            // Skip submit-proof
            const result = simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            expect(result.result).toBeErr(Cl.uint(104)); // ERR_INVALID_STATUS
        });
    });

    // ==========================================================
    // close-campaign
    // ==========================================================
    describe("close-campaign", () => {
        it("should close a campaign", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);
            expect(result.result).toBeOk(Cl.bool(true));
        });

        it("should set status to closed(3)", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);

            const campaign = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(1)], wallet1);
            const val = (campaign.result as any).value.value;
            expect(val.status).toStrictEqual(Cl.uint(3));
        });

        it("should fail if not the owner", () => {
            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const result = simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet2);
            expect(result.result).toBeErr(Cl.uint(100));
        });

        it("should fail to close when task payouts are still allocated", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "add-task", [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)], wallet1);
            const result = simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);
            expect(result.result).toBeErr(Cl.uint(110)); // ERR_ACTIVE_ALLOCATIONS
        });
    });

    // ==========================================================
    // withdraw-remaining
    // ==========================================================
    describe("withdraw-remaining", () => {
        it("should withdraw remaining funds from a closed campaign", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);

            const result = simnet.callPublicFn(
                contractName,
                "withdraw-remaining",
                [Cl.uint(1), Cl.uint(5_000_000)],
                wallet1
            );
            expect(result.result).toBeOk(Cl.bool(true));

            // Check balance is now zero
            const balance = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(1)], wallet1);
            expect(balance.result).toBeOk(Cl.uint(0));
        });

        it("should allow partial withdrawal", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);

            simnet.callPublicFn(contractName, "withdraw-remaining", [Cl.uint(1), Cl.uint(2_000_000)], wallet1);

            const balance = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(1)], wallet1);
            expect(balance.result).toBeOk(Cl.uint(3_000_000));
        });

        it("should fail if campaign is not closed", () => {
            createAndFundCampaign(5_000_000);
            // Campaign is funded (status=1), not closed
            const result = simnet.callPublicFn(
                contractName,
                "withdraw-remaining",
                [Cl.uint(1), Cl.uint(5_000_000)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(104)); // ERR_INVALID_STATUS
        });

        it("should fail if not the owner", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);

            const result = simnet.callPublicFn(
                contractName,
                "withdraw-remaining",
                [Cl.uint(1), Cl.uint(5_000_000)],
                wallet2
            );
            expect(result.result).toBeErr(Cl.uint(100));
        });

        it("should fail if amount exceeds remaining balance", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);

            const result = simnet.callPublicFn(
                contractName,
                "withdraw-remaining",
                [Cl.uint(1), Cl.uint(10_000_000)], // More than funded
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(103));
        });

        it("should fail if balance is already zero", () => {
            createAndFundCampaign(5_000_000);
            simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);
            simnet.callPublicFn(contractName, "withdraw-remaining", [Cl.uint(1), Cl.uint(5_000_000)], wallet1);

            // Try again with zero balance
            const result = simnet.callPublicFn(
                contractName,
                "withdraw-remaining",
                [Cl.uint(1), Cl.uint(1)],
                wallet1
            );
            expect(result.result).toBeErr(Cl.uint(108)); // ERR_NO_BALANCE
        });
    });

    // ==========================================================
    // Full lifecycle integration test
    // ==========================================================
    describe("full lifecycle", () => {
        it("should complete the entire flow: create → fund → task → claim → proof → approve → close → withdraw", () => {
            // 1. Create campaign
            const createResult = simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            expect(createResult.result).toBeOk(Cl.uint(1));

            // 2. Fund campaign with 3 STX
            const fundResult = simnet.callPublicFn(contractName, "fund-campaign", [Cl.uint(1), Cl.uint(3_000_000)], wallet1);
            expect(fundResult.result).toBeOk(Cl.bool(true));

            // 3. Add task with 1 STX payout
            const addResult = simnet.callPublicFn(
                contractName, "add-task",
                [Cl.uint(1), Cl.uint(1_000_000), Cl.uint(100_000), Cl.buffer(criteriaHash)],
                wallet1
            );
            expect(addResult.result).toBeOk(Cl.uint(1));

            // 4. Executor claims task
            const claimResult = simnet.callPublicFn(contractName, "claim-task", [Cl.uint(1), Cl.uint(1)], wallet2);
            expect(claimResult.result).toBeOk(Cl.bool(true));

            // 5. Executor submits proof
            const proofResult = simnet.callPublicFn(
                contractName, "submit-proof",
                [Cl.uint(1), Cl.uint(1), Cl.buffer(proofHash)],
                wallet2
            );
            expect(proofResult.result).toBeOk(Cl.bool(true));

            // 6. Owner approves → payout
            const approveResult = simnet.callPublicFn(contractName, "approve-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            expect(approveResult.result).toBeOk(Cl.bool(true));

            // Verify payout occurred (STX transfer event)
            const transfer = approveResult.events.find((e: any) => e.event === "stx_transfer_event");
            expect(transfer).toBeDefined();

            // 7. Check remaining balance = 2 STX
            const balance = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(1)], wallet1);
            expect(balance.result).toBeOk(Cl.uint(2_000_000));

            // 8. Close campaign
            const closeResult = simnet.callPublicFn(contractName, "close-campaign", [Cl.uint(1)], wallet1);
            expect(closeResult.result).toBeOk(Cl.bool(true));

            // 9. Withdraw remaining 2 STX
            const withdrawResult = simnet.callPublicFn(
                contractName, "withdraw-remaining",
                [Cl.uint(1), Cl.uint(2_000_000)],
                wallet1
            );
            expect(withdrawResult.result).toBeOk(Cl.bool(true));

            // 10. Verify final balance is 0
            const finalBalance = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(1)], wallet1);
            expect(finalBalance.result).toBeOk(Cl.uint(0));
        });
    });

    // ==========================================================
    // Read-only functions
    // ==========================================================
    describe("read-only functions", () => {
        it("get-campaign-count should return the current counter", () => {
            const count0 = simnet.callReadOnlyFn(contractName, "get-campaign-count", [], wallet1);
            expect(count0.result).toStrictEqual(Cl.uint(0));

            simnet.callPublicFn(contractName, "create-campaign", [Cl.principal(wallet1), Cl.none(), Cl.buffer(metadataHash)], wallet1);
            const count1 = simnet.callReadOnlyFn(contractName, "get-campaign-count", [], wallet1);
            expect(count1.result).toStrictEqual(Cl.uint(1));
        });

        it("get-campaign-balance should return err for nonexistent campaign", () => {
            const result = simnet.callReadOnlyFn(contractName, "get-campaign-balance", [Cl.uint(999)], wallet1);
            expect(result.result).toBeErr(Cl.uint(101));
        });

        it("get-campaign should return none for nonexistent campaign", () => {
            const result = simnet.callReadOnlyFn(contractName, "get-campaign", [Cl.uint(999)], wallet1);
            expect(result.result).toStrictEqual(Cl.none());
        });

        it("get-task should return none for nonexistent task", () => {
            const result = simnet.callReadOnlyFn(contractName, "get-task", [Cl.uint(1), Cl.uint(1)], wallet1);
            expect(result.result).toStrictEqual(Cl.none());
        });
    });
});
