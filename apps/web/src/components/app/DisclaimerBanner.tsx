import { Link } from "@tanstack/react-router";
import { Info, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export const DISCLAIMER_DISMISSED_KEY = "urano.disclaimer.dismissed";

function readDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return sessionStorage.getItem(DISCLAIMER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Compact compliance-lite bar. Dismissible per browser session via
 * `sessionStorage` key `urano.disclaimer.dismissed`.
 *
 * Starts hidden on SSR to avoid hydration mismatch, then reveals client-side
 * when the session has not dismissed it.
 */
export function DisclaimerBanner() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const dismiss = useCallback(() => {
    try {
      sessionStorage.setItem(DISCLAIMER_DISMISSED_KEY, "1");
    } catch {
      /* ignore quota / private mode */
    }
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  return (
    <div className="border-b border-border/80 bg-surface-2/80">
      <div className="flex items-start gap-2 px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary/80" />
        <p className="flex-1 min-w-0">
          <span className="text-foreground/85">
            Urano é ferramenta informativa de análise fundamentalista. O score é filtro de
            qualidade, não recomendação de investimento CVM. Dados podem estar desatualizados.
          </span>{" "}
          <Link
            to="/validation"
            className="text-primary hover:underline underline-offset-2 font-medium whitespace-nowrap"
          >
            Ver validação
          </Link>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label="Dispensar aviso"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
