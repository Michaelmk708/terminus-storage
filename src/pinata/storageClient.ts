/**
 * storageClient.ts
 * ─────────────────────────────────────────────────────────────────
 * Singleton wrapper around the Pinata SDK.
 *
 * Pinata satisfies NFR3 (High Availability): files are pinned to IPFS
 * via Pinata's infrastructure, ensuring content-addressed retrieval
 * with redundancy.
 *
 * SETUP:
 *  1. Create a Pinata account: https://app.pinata.cloud
 *  2. Generate API Key + Secret from Dashboard → API Keys
 *  3. Add to .env.local:
 *       PINATA_API_KEY=your_key
 *       PINATA_SECRET_API_KEY=your_secret
 * ─────────────────────────────────────────────────────────────────
 */

import pinataSDK, { PinataClient } from '@pinata/sdk';

// ── Custom error ───────────────────────────────────────────────────

export class PinataConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinataConfigError';
  }
}

// ── Singleton state ────────────────────────────────────────────────

let _storageClient: PinataClient | null = null;

/**
 * Returns (and lazily initialises) the shared Pinata client.
 * Safe to call multiple times — initialisation happens only once.
 */
export async function getStorageClient(): Promise<PinataClient> {
  if (_storageClient !== null) {
    return _storageClient;
  }

  const apiKey = process.env.PINATA_API_KEY;
  const secretKey = process.env.PINATA_SECRET_API_KEY;

  if (!apiKey || !secretKey) {
    throw new PinataConfigError(
      'PINATA_API_KEY and PINATA_SECRET_API_KEY must be set in .env'
    );
  }

  console.log('[Pinata] Initialising client…');

  _storageClient = pinataSDK(apiKey, secretKey);

  // Optional: verify connectivity
  try {
    const result = await _storageClient.testAuthentication();

    console.log(
      '[Pinata] ✅ Authentication successful:',
      result.authenticated
    );
  } catch (err) {
    _storageClient = null;

    throw new PinataConfigError(
      `Pinata authentication failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return _storageClient;
}

/**
 * Resets the singleton — useful in tests.
 */
export function resetStorageClient(): void {
  _storageClient = null;
}