/**
 * vaultStorage.ts
 * ─────────────────────────────────────────────────────────────────
 * HIGH-LEVEL VAULT STORAGE API
 *
 * This is the single file that all other Terminus modules interact
 * with. It orchestrates the full Lit + Pinata pipeline behind two
 * clean async functions:
 *
 *   storeVaultFile()    — Owner uploads a file into the vault
 *   retrieveVaultFile() — Beneficiary downloads and decrypts a file
 *
 * ─────────────────────────────────────────────────────────────────
 * INTEGRATION POINTS FOR OTHER DEVS:
 *
 *  Dev 1 (Smart Contracts):
 *    After storeVaultFile() resolves, store result.metadataCid in
 *    the Anchor account's file_cids: Vec<String>.
 *
 *  Dev 3 (Frontend):
 *    Use the useVaultStorage React hook (hooks/useVaultStorage.ts)
 *    instead of calling these functions directly.
 *
 *  Dev 4 (Integration):
 *    Wire result.metadataCid → Anchor TS client → on-chain storage.
 * ─────────────────────────────────────────────────────────────────
 */

import { encryptVaultFile } from '../lit/encrypt.js';
import { decryptVaultFile } from '../lit/decrypt.js';
import {
  uploadEncryptedVaultFile,
  fetchVaultMetadata,
  fetchEncryptedFile,
} from '../pinata/upload.js';  // ← changed from storacha to pinata
import type {
  StoreResult,
  StoreVaultFileParams,
  StoreVaultTextParams,
  RetrieveVaultFileParams,
  RetrieveAllVaultFilesParams,
  RetrieveAllResult,
  DecryptedVaultFile,
} from '../types.js';

// ══════════════════════════════════════════════════════════════════
//  STORE
// ══════════════════════════════════════════════════════════════════

/**
 * Encrypts a file with Lit Protocol then uploads the ciphertext and
 * metadata to Pinata (IPFS).
 *
 * @returns The `metadataCid` must be stored in the Solana smart contract.
 *
 * @example
 * const result = await storeVaultFile({
 *   file: fileFromInput,
 *   vaultPDA: vault.publicKey.toBase58(),
 *   ownerSolanaAddress: ownerWallet.toBase58(),
 *   conditionType: 'deceased',
 *   authSig,
 * });
 * // Store on-chain (Dev 1):
 * await program.methods.addVaultFile(result.metadataCid).accounts({...}).rpc();
 */
export async function storeVaultFile({
  file,
  vaultPDA,
  ownerSolanaAddress,
  conditionType = 'deceased',
  authSig,
  onProgress,
}: StoreVaultFileParams): Promise<StoreResult> {
  console.log(`
[VaultStorage] ── STORE ──────────────────────────────────`);
  console.log(`[VaultStorage] File: ${file instanceof File ? file.name : 'blob'} | Condition: ${conditionType}`);
  console.log(`[VaultStorage] Vault PDA: ${vaultPDA}`);

  // Step 1: Encrypt (Lit Protocol)
  console.log('[VaultStorage] Step 1/2 — Encrypting with Lit Protocol …');
  const encrypted = await encryptVaultFile({
    file,
    vaultPDA,
    ownerSolanaAddress,
    conditionType,
    authSig,
  });

  // Step 2: Upload (Pinata / IPFS)
  console.log('[VaultStorage] Step 2/2 — Uploading to Pinata (IPFS) …');
  const uploadResult = await uploadEncryptedVaultFile({
    ...encrypted,
    vaultPDA,
    onProgress,
  });

  console.log(`[VaultStorage] ✅ STORE COMPLETE`);
  console.log(`[VaultStorage] → metadataCid (store on-chain): ${uploadResult.metadataCid}`);

  const fileName = file instanceof File ? (file.name || 'vault-file') : 'vault-file';
  const fileMime = file instanceof File ? (file.type || 'application/octet-stream') : 'application/octet-stream';

  return {
    metadataCid: uploadResult.metadataCid,
    encryptedFileCid: uploadResult.encryptedFileCid,
    metadataUrl: uploadResult.metadataUrl,
    encryptedFileUrl: uploadResult.encryptedFileUrl,
    conditionType,
    originalFileName: fileName,
    mimeType: fileMime,
  };
}

/**
 * Convenience wrapper for storing a plain text string (password,
 * letter written in the UI).
 *
 * @example
 * await storeVaultText({
 *   text: 'My final wishes are...',
 *   fileName: 'Last Will.txt',
 *   vaultPDA, ownerSolanaAddress, conditionType: 'deceased', authSig,
 * });
 */
export async function storeVaultText({
  text,
  fileName = 'vault-note.txt',
  vaultPDA,
  ownerSolanaAddress,
  conditionType = 'deceased',
  authSig,
}: StoreVaultTextParams): Promise<StoreResult> {
  const encoder = new TextEncoder();
  const blob = new Blob([encoder.encode(text)], { type: 'text/plain' });
  const file = new File([blob], fileName, { type: 'text/plain' });

  return storeVaultFile({ file, vaultPDA, ownerSolanaAddress, conditionType, authSig });
}

// ══════════════════════════════════════════════════════════════════
//  RETRIEVE
// ══════════════════════════════════════════════════════════════════

/**
 * Fetches metadata from IPFS, downloads the ciphertext, then decrypts
 * using Lit Protocol.
 *
 * Throws `TerminusDecryptionError` with `code === 'VAULT_LOCKED'` if the
 * smart contract has not yet reached the Unlocked state.
 *
 * @example
 * import { TerminusDecryptionError } from 'terminus-storage';
 *
 * try {
 *   const file = await retrieveVaultFile({ metadataCid, authSig });
 *   window.open(file.objectUrl, '_blank');
 * } catch (err) {
 *   if (err instanceof TerminusDecryptionError && err.code === 'VAULT_LOCKED') {
 *     showError('Vault not yet unlocked. Wait for the 30-day period to end.');
 *   }
 * }
 */
export async function retrieveVaultFile({
  metadataCid,
  authSig,
  onProgress,
}: RetrieveVaultFileParams): Promise<DecryptedVaultFile> {
  console.log(`
[VaultStorage] ── RETRIEVE ────────────────────────────────`);
  console.log(`[VaultStorage] Metadata CID: ${metadataCid}`);

  // Step 1: Fetch metadata JSON from IPFS
  console.log('[VaultStorage] Step 1/3 — Fetching metadata from IPFS …');
  const metadata = await fetchVaultMetadata(metadataCid);

  console.log(`[VaultStorage] File: ${metadata.originalFileName} | Type: ${metadata.mimeType}`);

  // Step 2: Download encrypted ciphertext from IPFS
  console.log('[VaultStorage] Step 2/3 — Downloading encrypted file from IPFS …');
  const encryptedFile = await fetchEncryptedFile(metadata.encryptedFileCid, onProgress);

  // Step 3: Decrypt via Lit Protocol
  // Will throw TerminusDecryptionError('VAULT_LOCKED') if not ready.
  console.log('[VaultStorage] Step 3/3 — Requesting decryption from Lit Protocol …');
  const decrypted = await decryptVaultFile({
    encryptedFile,
    encryptedSymmetricKey: metadata.encryptedSymmetricKey,
    accessControlConditions: metadata.accessControlConditions,
    dataToEncryptHash: metadata.dataToEncryptHash,
    mimeType: metadata.mimeType,
    originalFileName: metadata.originalFileName,
    authSig,
  });

  console.log('[VaultStorage] ✅ RETRIEVE COMPLETE — file decrypted in browser.');
  return decrypted;
}

/**
 * Retrieves all files for a vault given an array of metadata CIDs.
 * Settled — partial failures don't abort the others.
 *
 * @example
 * const metadataCids = vaultAccount.fileCids; // from Anchor TS client
 * const results = await retrieveAllVaultFiles({ metadataCids, authSig });
 * results.forEach(({ cid, result, error }) => {
 *   if (result) console.log('Decrypted:', result.originalFileName);
 *   if (error) console.warn('Failed CID:', cid, error.message);
 * });
 */
export async function retrieveAllVaultFiles({
  metadataCids,
  authSig,
}: RetrieveAllVaultFilesParams): Promise<RetrieveAllResult[]> {
  const settled = await Promise.allSettled(
    metadataCids.map((cid) => retrieveVaultFile({ metadataCid: cid, authSig }))
  );

  return settled.map((result, i) => ({
    cid: metadataCids[i] as string,
    result: result.status === 'fulfilled' ? result.value : undefined,
    error: result.status === 'rejected' ? (result.reason as Error) : undefined,
  }));
}