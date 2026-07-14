import { Link, useRouterState } from "@tanstack/react-router";
import { Search, Command as CommandIcon, Star } from "lucide-react";
import { Kbd } from "./badges";
import { useCommandPalette } from "./CommandPalette";
import { useEffect, useState } from "react";
import { apiSettings } from "@/lib/api";
import { cn } from "@/lib/utils";

function useCrumbs() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; to: string }[] = [{ label: "Home", to: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    crumbs.push({ label: p, to: acc });
  }
  return crumbs;
}

export function Topbar() {
  const { open } = useCommandPalette();
  const crumbs = useCrumbs();
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    const upd = () => setConfigured(apiSettings.isConfigured());
    upd();
    window.addEventListener("urano:settings", upd);
    window.addEventListener("storage", upd);
    return () => {
      window.removeEventListener("urano:settings", upd);
      window.removeEventListener("storage", upd);
    };
  }, []);

  return (
    <header className="h-11 shrink-0 flex items-center gap-3 border-b border-border bg-surface px-3">
      <nav className="hidden md:flex items-center gap-1 text-xs text-muted-foreground min-w-0 flex-1">
        {crumbs.map((c, i) => (
          <span key={c.to} className="flex items-center gap-1 min-w-0">
            {i > 0 && <span className="text-border">/</span>}
            <Link
              to={c.to}
              className={cn(
                "truncate hover:text-foreground transition-colors",
                i === crumbs.length - 1 && "text-foreground font-medium",
              )}
            >
              {c.label}
            </Link>
          </span>
        ))}
      </nav>

      <button
        onClick={open}
        className="group inline-flex items-center gap-2 h-7 min-w-[280px] rounded border border-border bg-surface-2 hover:bg-surface-3 text-xs text-muted-foreground px-2 transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Buscar ativos, comandos…</span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="hidden md:flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              configured ? "bg-positive animate-pulse" : "bg-muted-foreground",
            )}
          />
          {configured ? "API conectada" : "API não configurada"}
        </div>
      </div>
    </header>
  );
}
