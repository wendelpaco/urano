/**
 * Structured audit log for security-sensitive mutations (key/wallet
 * create/rotate/delete). Never pass a plaintext API key value in `details`.
 */
export function logSecurityEvent(action: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      audit: true,
      action,
      at: new Date().toISOString(),
      ...details,
    }),
  );
}
