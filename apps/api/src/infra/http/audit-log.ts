import { db } from '../database/connection.ts';
import { securityAuditLog } from '../database/schema.ts';

/**
 * Structured audit log for security-sensitive mutations (key/wallet
 * create/rotate/delete).
 *
 * NEVER pass a plaintext API key value in `details` — only ids, names,
 * and non-secret metadata. Plaintext keys must never appear in console
 * output or the `security_audit_log` table.
 *
 * Persistence is best-effort (fire-and-forget): DB failures are swallowed
 * so audit must never break request handling. Console JSON always emits.
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

  const apiKeyId =
    typeof details.apiKeyId === 'string' ? details.apiKeyId : null;

  // Promise.resolve: drizzle returns a thenable; unit-test mocks may return
  // a plain object without .catch — never let either path throw to callers.
  try {
    void Promise.resolve(
      db.insert(securityAuditLog).values({
        action,
        apiKeyId,
        details,
      }),
    ).catch((err: unknown) => {
      // Best-effort: never surface DB errors to callers.
      console.error(
        '[audit] Falha ao persistir evento de auditoria:',
        `action=${action}`,
        `apiKeyId=${apiKeyId ?? 'N/A'}`,
        (err instanceof Error ? err.message : String(err)),
      );
    });
  } catch {
    // Sync failure (e.g. mock without insert) — ignore.
  }
}
