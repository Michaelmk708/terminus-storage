/**
 * useVaultStorage.ts
 * ─────────────────────────────────────────────────────────────────
 * Typed React hook that wraps the storage/encryption module for the
 * Terminus frontend (Dev 3).
 *
 * Usage in Owner Dashboard:
 *   const { uploadFile, isUploading, uploadProgress } = useVaultStorage(vaultPDA, ownerAddress);
 *   const result = await uploadFile(file, 'deceased');
 *
 * Usage in Beneficiary Claim Portal:
 *   const { claimFile, isClaiming, decryptedFiles, downloadFile } = useVaultStorage(vaultPDA);
 *   await claimFile(metadataCid);
 *
 * NOTE: Uses Privy for wallet access. Swap useWallets() for your
 * Web3Auth equivalent if needed.
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useWallets } from '@privy-io/react-auth'; // swap for Web3Auth if needed
import { storeVaultFile } from '../vault/vaultStorage.js';
import { generateAuthSigFromSigner } from '../lit/authHelpers.js';
import { decryptVaultFile, TerminusDecryptionError } from '../lit/decrypt.js';
import { fetchVaultMetadata } from '../pinata/upload.js';
import type {
  StoreResult,
  DecryptedFileEntry,
  ConditionType,
  UploadProgressEvent,
  DownloadProgressEvent,
} from '../types.js';

const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

// ── Hook return type ───────────────────────────────────────────────

export interface UseVaultStorageReturn {
  // Owner — upload flow
  uploadFile: (file: File, conditionType?: ConditionType) => Promise<StoreResult>;
  isUploading: boolean;
  uploadProgress: number;
  uploadError: string | null;

  // Beneficiary — claim flow
  claimFile: (metadataCid: string) => Promise<DecryptedFileEntry>;
  isClaiming: boolean;
  claimProgress: number;
  claimError: string | null;
  decryptedFiles: DecryptedFileEntry[];
  downloadFile: (fileEntry: DecryptedFileEntry) => void;
}

// ── Hook ───────────────────────────────────────────────────────────

/**
 * @param vaultPDA            Base-58 Solana PDA of the current vault
 * @param ownerSolanaAddress  Owner's Solana wallet address (required for upload)
 */
export function useVaultStorage(
  vaultPDA: string,
  ownerSolanaAddress?: string
): UseVaultStorageReturn {
  const { wallets } = useWallets();

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Claim state
  const [isClaiming, setIsClaiming] = useState(false);
  const [claimProgress, setClaimProgress] = useState(0);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [decryptedFiles, setDecryptedFiles] = useState<DecryptedFileEntry[]>([]);

  // Track object URLs for cleanup on unmount
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // ── getSigner ────────────────────────────────────────────────────
  const getSigner = useCallback(async () => {
    const wallet = wallets[0];
    if (!wallet) throw new Error('No wallet connected. Please log in first.');
    const provider = await wallet.getEthersProvider();
    return provider.getSigner();
  }, [wallets]);

  // ── uploadFile ───────────────────────────────────────────────────
  const uploadFile = useCallback(
    async (file: File, conditionType: ConditionType = 'deceased'): Promise<StoreResult> => {
      if (!vaultPDA) throw new Error('vaultPDA is required.');
      if (!ownerSolanaAddress) throw new Error('ownerSolanaAddress is required for upload.');

      setIsUploading(true);
      setUploadProgress(0);
      setUploadError(null);

      try {
        const signer = await getSigner();
        const authSig = await generateAuthSigFromSigner(signer);

        const result = await storeVaultFile({
          file,
          vaultPDA,
          ownerSolanaAddress,
          conditionType,
          authSig,
          onProgress: (e: UploadProgressEvent) => {
            // Note: Pinata SDK doesn't support upload progress callbacks
            // This will only fire for the download/encryption phase
            if (e.percent !== undefined) setUploadProgress(Math.round(e.percent));
          },
        });

        setUploadProgress(100);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUploadError(msg);
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    [vaultPDA, ownerSolanaAddress, getSigner]
  );

  // ── claimFile ────────────────────────────────────────────────────
  const claimFile = useCallback(
    async (metadataCid: string): Promise<DecryptedFileEntry> => {
      setIsClaiming(true);
      setClaimProgress(0);
      setClaimError(null);

      try {
        const signer = await getSigner();
        const authSig = await generateAuthSigFromSigner(signer);

        // Step 1: Fetch metadata from Pinata gateway
        console.log(`[useVaultStorage] Fetching metadata: ${metadataCid}`);
        const metadataResponse = await fetch(`${PINATA_GATEWAY}/${metadataCid}`);
        if (!metadataResponse.ok) {
          throw new Error(`Metadata not found (${metadataResponse.status})`);
        }
        const metadata = await metadataResponse.json();

        // Step 2: Fetch encrypted file from Pinata gateway
        console.log(`[useVaultStorage] Fetching encrypted file: ${metadata.encryptedFileCid}`);
        const fileResponse = await fetch(`${PINATA_GATEWAY}/${metadata.encryptedFileCid}`);
        if (!fileResponse.ok) {
          throw new Error(`Encrypted file not found (${fileResponse.status})`);
        }

        // Track download progress if Content-Length is available
        const contentLength = fileResponse.headers.get('Content-Length');
        const reader = fileResponse.body!.getReader();
        let receivedLength = 0;
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          chunks.push(value);
          receivedLength += value.length;
          
          if (contentLength) {
            const percent = (receivedLength / parseInt(contentLength)) * 100;
            setClaimProgress(Math.round(percent));
          }
        }

        // Combine chunks into single Blob
        const encryptedBlob = new Blob(chunks, { 
          type: 'application/octet-stream' 
        });

        // Step 3: Decrypt with Lit Protocol
        console.log('[useVaultStorage] Decrypting file with Lit Protocol…');
        const decrypted = await decryptVaultFile({
          encryptedFile: encryptedBlob,
          encryptedSymmetricKey: metadata.encryptedSymmetricKey,
          accessControlConditions: metadata.accessControlConditions,
          dataToEncryptHash: metadata.dataToEncryptHash,
          mimeType: metadata.mimeType,
          originalFileName: metadata.originalFileName,
          authSig,
        });

        objectUrlsRef.current.push(decrypted.objectUrl);

        const entry: DecryptedFileEntry = {
          metadataCid,
          objectUrl: decrypted.objectUrl,
          originalFileName: metadata.originalFileName,
          mimeType: metadata.mimeType,
          blob: decrypted.blob,
          text: metadata.mimeType.startsWith('text/') ? await decrypted.text() : null,
        };

        setDecryptedFiles((prev) => [...prev, entry]);
        setClaimProgress(100);
        return entry;
      } catch (err) {
        let msg: string;
        if (err instanceof TerminusDecryptionError && err.code === 'VAULT_LOCKED') {
          msg = 'Vault is not yet unlocked. The 30-day challenge period must complete first.';
        } else {
          msg = err instanceof Error ? err.message : String(err);
        }
        setClaimError(msg);
        throw err;
      } finally {
        setIsClaiming(false);
      }
    },
    [getSigner]
  );

  // ── downloadFile ─────────────────────────────────────────────────
  const downloadFile = useCallback((fileEntry: DecryptedFileEntry): void => {
    const a = document.createElement('a');
    a.href = fileEntry.objectUrl;
    a.download = fileEntry.originalFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  return {
    uploadFile,
    isUploading,
    uploadProgress,
    uploadError,
    claimFile,
    isClaiming,
    claimProgress,
    claimError,
    decryptedFiles,
    downloadFile,
  };
}