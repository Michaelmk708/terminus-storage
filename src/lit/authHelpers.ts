/**
 * authHelpers.ts
 * ─────────────────────────────────────────────────────────────────
 * Helpers for generating the Lit Protocol AuthSig.
 *
 * WHY EVM signature for a Solana project?
 * Lit Protocol currently uses an EVM-based SIWE (Sign-In With Ethereum)
 * message for AuthSig even when access conditions are on Solana.
 * This is a Lit Protocol requirement, not a Terminus design choice.
 *
 * Integration options for your React frontend (FR3 — Walletless):
 *   A) Privy embedded wallet  →  use generateAuthSigFromSigner()
 *   B) Web3Auth embedded wallet  →  use generateAuthSigFromSigner()
 *
 * Both Privy and Web3Auth create an invisible EVM wallet per user at
 * login time (email / Google OAuth) and expose it as an ethers Signer.
 * ─────────────────────────────────────────────────────────────────
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LitAbility, LitActionResource } from '@lit-protocol/constants';
import type { Signer } from '@solana/web3.js';
import type { AuthSig } from '../types.js';
import { getLitClient } from './litClient.js';

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generates a Lit AuthSig from an ethers.js v6 Signer.
 * Works with MetaMask, Privy embedded wallets, Web3Auth wallets, etc.
 *
 * @example
 * // With Privy:
 * import { useWallets } from '@privy-io/react-auth';
 * const { wallets } = useWallets();
 * const provider = await wallets[0].getEthersProvider();
 * const signer = provider.getSigner();
 * const authSig = await generateAuthSigFromSigner(signer);
 *
 * @example
 * // With Web3Auth:
 * const provider = new ethers.BrowserProvider(web3auth.provider);
 * const signer = await provider.getSigner();
 * const authSig = await generateAuthSigFromSigner(signer);
 */
export async function generateAuthSigFromSigner(signer: Signer): Promise<AuthSig> {
  const address = await signer.getAddress();

  const domain =
    typeof window !== 'undefined' ? window.location.hostname : 'terminus.app';
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://terminus.app';
  const expiration = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // 24 h

  const siweMessage = LitNodeClient.createSiweMessage({
    domain,
    address,
    statement: 'Sign to access your Terminus Vault. This does not initiate a transaction.',
    uri: origin,
    version: '1',
    chainId: 1, // Lit requires EVM chainId even for Solana conditions
    expiration,
    nonce: generateNonce(),
  });

  const signature = await signer.signMessage(siweMessage);

  return {
    sig: signature,
    derivedVia: 'web3.eth.personal.sign',
    signedMessage: siweMessage,
    address: address.toLowerCase(),
  };
}

/**
 * Generates Lit Session Signatures — the preferred, more secure
 * alternative to AuthSig for production. Session sigs are short-lived
 * (24h) and scoped to specific Lit capabilities.
 *
 * @example
 * const sessionSigs = await generateSessionSigs(privySigner);
 * // Pass sessionSigs wherever authSig is accepted
 */
export async function generateSessionSigs(signer: Signer): Promise<Record<string, unknown>> {
  const litClient = await getLitClient();

  const sessionSigs = await litClient.getSessionSigs({
    chain: 'ethereum',
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    resourceAbilityRequests: [
      {
        resource: new LitJsSdk.LitAccessControlConditionResource('*'),
        ability: LitAbility.AccessControlConditionDecryption,
      },
    ],
    authNeededCallback: async () => generateAuthSigFromSigner(signer),
  });

  return sessionSigs;
}

/**
 * Generates an AuthSig from a raw private key.
 * For Node.js backend / test scripts ONLY.
 * ⚠️  NEVER expose a private key on the frontend.
 */
export async function generateAuthSigFromPrivateKey(privateKey: string): Promise<AuthSig> {
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(privateKey);
  return generateAuthSigFromSigner(wallet);
}

// ── Helpers ────────────────────────────────────────────────────────

function generateNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
