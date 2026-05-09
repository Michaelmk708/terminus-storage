/**
 * testVaultFlow.ts
 * ─────────────────────────────────────────────────────────────────
 * End-to-end test of the Terminus storage & encryption pipeline.
 *
 * Run: npx tsx src/tests/testVaultFlow.ts
 *
 * Steps tested:
 *  1. Owner encrypts and stores a file → CID returned
 *  2. Metadata round-trip: fetch from IPFS and verify fields
 *  3. Decrypt attempt BEFORE vault unlocked → expects VAULT_LOCKED error
 *  4. (Manual) Set vault state to Unlocked on devnet
 *  5. Decrypt attempt AFTER vault unlocked → expects success
 *
 * BEFORE RUNNING:
 *  cp .env.example .env
 *  Fill in: PINATA_API_KEY, PINATA_SECRET_KEY (or JWT),
 *           LIT_NETWORK=datil-dev, SOLANA_NETWORK=devnet,
 *           TERMINUS_PROGRAM_ID, TEST_VAULT_PDA, TEST_OWNER_SOLANA
 * ─────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import {
  storeVaultFile,
  retrieveVaultFile,
  fetchVaultMetadata,
  generateAuthSigFromPrivateKey,
  TerminusDecryptionError,
} from '../index.js';
import type { StoreResult } from '../types.js';

// ── Test config ────────────────────────────────────────────────────
// Use a throwaway test wallet — NEVER use a real private key here
const TEST_PRIVATE_KEY =
  process.env['TEST_EVM_PRIVATE_KEY'] ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat default #0

const TEST_VAULT_PDA =
  process.env['TEST_VAULT_PDA'] ?? 'REPLACE_WITH_YOUR_VAULT_PDA';

const TEST_OWNER_SOLANA =
  process.env['TEST_OWNER_SOLANA'] ?? 'REPLACE_WITH_OWNER_SOLANA_ADDRESS';

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗`);
  console.log('║  TERMINUS — Storage & Encryption E2E Test        ║');
  console.log(`╚══════════════════════════════════════════════════╝
`);

  // Auth
  console.log('🔑 Generating auth signature …');
  const authSig = await generateAuthSigFromPrivateKey(TEST_PRIVATE_KEY);
  console.log('   Auth sig address:', authSig.address);

  // Test file
  const testContent = `
    LAST WILL AND TESTAMENT OF TEST USER
    
    I hereby bequeath all my digital assets to my beneficiary.
    Generated at: ${new Date().toISOString()}
    
    Signed: Test Owner
  `.trim();

  const testFile = new File(
    [new TextEncoder().encode(testContent)],
    'last-will.txt',
    { type: 'text/plain' }
  );

  // ── STEP 1: Store ────────────────────────────────────────────
  console.log(`
─── STEP 1: Store encrypted file in vault ──────────`);

  let storeResult: StoreResult;
  try {
    storeResult = await storeVaultFile({
      file: testFile,
      vaultPDA: TEST_VAULT_PDA,
      ownerSolanaAddress: TEST_OWNER_SOLANA,
      conditionType: 'deceased',
      authSig,
      onProgress: (e) => {
        if (e.percent !== undefined) {
          process.stdout.write(`\r   Upload: ${e.percent.toFixed(1)}%`);
        }
      },
    });

    console.log(`
✅ Store result:`);
    console.log('   metadataCid (→ store on Solana):', storeResult.metadataCid);
    console.log('   encryptedFileCid:', storeResult.encryptedFileCid);
    console.log('   metadataUrl:', storeResult.metadataUrl);
    console.log('   encryptedFileUrl:', storeResult.encryptedFileUrl);
  } catch (err) {
    console.error('❌ Store failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ── STEP 2: Verify metadata round-trip ───────────────────────
  console.log(`
─── STEP 2: Verify metadata round-trip ─────────────`);
  const metadata = await fetchVaultMetadata(storeResult.metadataCid);

  console.log('✅ Metadata fetched:');
  console.log('   originalFileName:', metadata.originalFileName);
  console.log('   mimeType:', metadata.mimeType);
  console.log('   conditionType:', metadata.conditionType);
  console.log('   vaultPDA:', metadata.vaultPDA);

  // ── STEP 3: Decrypt while vault is locked ────────────────────
  console.log(`
─── STEP 3: Decrypt attempt (vault locked) ─────────`);
  console.log('   Expecting TerminusDecryptionError(VAULT_LOCKED) …');

  try {
    await retrieveVaultFile({ metadataCid: storeResult.metadataCid, authSig });
    console.warn('⚠️  Unexpected: decrypt succeeded while vault should be locked.');
  } catch (err) {
    if (err instanceof TerminusDecryptionError && err.code === 'VAULT_LOCKED') {
      console.log('✅ Correctly rejected with VAULT_LOCKED.');
    } else {
      console.error('❌ Unexpected error type:', err);
    }
  }

  // ── STEP 4: Manual instructions ──────────────────────────────
  console.log(`
─── STEP 4: Manual — unlock vault on devnet ─────────`);
  console.log('   1. Pass metadataCid to Dev 1 to store on-chain.');
  console.log('   2. Have Dev 1 transition the vault state to Unlocked on devnet.');
  console.log('   3. Re-run with TEST_VAULT_UNLOCKED=true');

  if (process.env['TEST_VAULT_UNLOCKED'] === 'true') {
    console.log(`
─── STEP 5: Decrypt (vault UNLOCKED) ────────────────`);
    const decrypted = await retrieveVaultFile({
      metadataCid: storeResult.metadataCid,
      authSig,
    });

    const text = await decrypted.text();
    console.log('✅ Decrypted successfully!');
    console.log('   originalFileName:', decrypted.originalFileName);
    console.log('   Content preview:', text.slice(0, 120));
    decrypted.revoke();
  }

  console.log(`
╔══════════════════════════════════════════════════╗`);
  console.log('║  Test complete.                                   ║');
  console.log(`╚══════════════════════════════════════════════════╝
`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('\n💥 Fatal test error:', err instanceof Error ? err.message : err);
  process.exit(1);
});