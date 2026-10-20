type WalletAccount = { address: string; publicKey: Uint8Array; chains: readonly string[] };
export type FomoWallet = {
  accountId: string; address: string; publicKey: Uint8Array;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>;
};

export type EvmWallet = { address: string; getEthereumProvider: () => Promise<{ request: (request: { method: string; params?: unknown[] }) => Promise<any> }> };

// FOMO owns this provider. Inspect its shape, never names, module hashes, or secrets.
function walletContext(expectedAccountId?: string): any {
  const seeds = [document.body, document.documentElement, document.querySelector('#root')].filter(Boolean);
  for (const seed of seeds) {
    const property = Object.keys(seed!).find(key => key.startsWith('__reactFiber$'));
    if (!property) continue;
    let root = (seed as unknown as Record<string, any>)[property];
    let ancestors = 0;
    while (root?.return && ancestors++ < 200) root = root.return;
    const pending = [root?.stateNode?.current ?? root], visited = new Set<object>();
    while (pending.length && visited.size < 30000) {
      const fiber = pending.pop();
      if (!fiber || visited.has(fiber)) continue;
      visited.add(fiber);
      const value = fiber.memoizedProps?.value;
      if (value?.walletState === 'ready' && typeof value.fomoUser?.id === 'string' && (!expectedAccountId || value.fomoUser.id === expectedAccountId)) {
        return value;
      }
      if (fiber.sibling) pending.push(fiber.sibling);
      if (fiber.child) pending.push(fiber.child);
    }
  }
}


export function findWallet(expectedAccountId?: string): FomoWallet | undefined {
  const value = walletContext(expectedAccountId);
  try {
    const wallet = value?.solanaWallet, standard = wallet?.standardWallet;
    const account = standard?.accounts?.find((a: WalletAccount) => a.address === wallet.address && a.chains.includes('solana:mainnet')) as WalletAccount | undefined;
    if (account && wallet.address === value.fomoUser.address && account.publicKey instanceof Uint8Array && account.publicKey.length === 32 &&
      typeof wallet.signMessage === 'function' && typeof standard.features?.['solana:signMessage']?.signMessage === 'function') {
      return { accountId: value.fomoUser.id, address: account.address, publicKey: account.publicKey, signMessage: input => wallet.signMessage(input) };
    }
  } catch { /* Provider may still be initializing. */ }
}
export function findEvmWallet(expectedAccountId?: string): EvmWallet | undefined {
  const value = walletContext(expectedAccountId), wallet = value?.evmWallet;
  if (typeof wallet?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wallet.address) &&
      typeof value.fomoUser.evmAddress === 'string' && wallet.address.toLowerCase() === value.fomoUser.evmAddress.toLowerCase() && typeof wallet.getEthereumProvider === 'function') return wallet;
}
