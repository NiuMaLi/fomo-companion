// Preserve message bytes for legacy/v0 (signatures first) and v1 (signatures last).
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = '';
  while (value) { result = ALPHABET[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
export function fromBase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function toBase64(value: Uint8Array) { return btoa(String.fromCharCode(...value)); }
export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
export function transaction(bytes: Uint8Array) {
  if (bytes.length > 4096 || bytes.length < 100) throw new Error('交易长度无效');
  if (bytes[0] === 129) {
    // v1's fixed header is 42 bytes; byte 1 is the number of required signers.
    const count = bytes[1]!, signatureOffset = bytes.length - count * 64;
    if (count < 1 || count > 16 || signatureOffset < 42 + count * 32) throw new Error('交易头无效');
    return { version: 1, message: bytes.slice(0, signatureOffset), messageOffset: 0, signatureOffset,
      signers: Array.from({ length: count }, (_, i) => bytes.slice(42 + i * 32, 42 + (i + 1) * 32)),
      signatures: Array.from({ length: count }, (_, i) => bytes.slice(signatureOffset + i * 64, signatureOffset + (i + 1) * 64)) };
  }
  if (bytes.length > 1232) throw new Error('交易长度无效');
  let offset = 0;
  const compact = () => {
    let value = 0, shift = 0, byte: number;
    do {
      if (offset >= bytes.length || shift > 14) throw new Error('交易向量无效');
      byte = bytes[offset++]!; value |= (byte & 127) << shift; shift += 7;
    } while (byte & 128);
    return value;
  };
  const count = compact(), signatureOffset = offset;
  if (count < 1 || count > 16) throw new Error('交易签名者数量无效');
  offset += count * 64;
  const messageOffset = offset, message = bytes.slice(offset);
  if (bytes[offset]! & 128) { if (bytes[offset++] !== 128) throw new Error('不支持的交易版本'); }
  const required = bytes[offset++]; offset += 2;
  const keyCount = compact();
  if (required !== count || keyCount < count || keyCount > 256 || offset + keyCount * 32 + 32 > bytes.length) throw new Error('交易头无效');
  const signers = Array.from({ length: count }, (_, i) => bytes.slice(offset + i * 32, offset + (i + 1) * 32));
  const signatures = Array.from({ length: count }, (_, i) => bytes.slice(signatureOffset + i * 64, signatureOffset + (i + 1) * 64));
  return { version: bytes[messageOffset] === 128 ? 0 : 'legacy', message, messageOffset, signatureOffset, signers, signatures };
}
export function attachFeeSignature(bytes: Uint8Array, address: string, signature: Uint8Array) {
  const tx = transaction(bytes), index = tx.signers.findIndex(key => base58(key) === address);
  if (index < 0 || signature.length !== 64) throw new Error('代付签名与交易不匹配');
  const old = tx.signatures[index]!;
  if (old.some(Boolean) && !equalBytes(old, signature)) throw new Error('代付签名发生变化');
  const result = bytes.slice(); result.set(signature, tx.signatureOffset + index * 64); return result;
}
export async function verifySignedTransaction(before: Uint8Array, signed: Uint8Array, publicKey: Uint8Array) {
  const a = transaction(before), b = transaction(signed);
  if (!equalBytes(a.message, b.message) || a.signatures.length !== b.signatures.length || !a.signers.some(key => equalBytes(key, publicKey))) throw new Error('签名后的交易内容或账户发生变化');
  for (let index = 0; index < b.signatures.length; index++) {
    const old = a.signatures[index]!, signature = b.signatures[index]!, signer = b.signers[index]!;
    if (old.some(Boolean) && !equalBytes(old, signature)) throw new Error('已有签名发生变化');
    if (!signature.some(Boolean)) throw new Error('交易缺少必要签名');
    const key = await crypto.subtle.importKey('raw', new Uint8Array(signer), { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(b.message))) throw new Error('交易签名校验失败');
  }
  return base58(b.signatures[0]!);
}
