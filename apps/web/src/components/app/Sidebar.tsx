import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  LineChart,
  Wallet,
  Sparkles,
  Settings,
  Filter,
  Trophy,
  Search,
  Activity,
  GitCompareArrows,
  PieChart,
  Landmark,
  ShieldCheck,
  Eye,
  Banknote,
  BookMarked,
  BarChart3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  match?: (path: string) => boolean;
};

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Terminal",
    items: [{ to: "/", label: "Overview", icon: LayoutDashboard, match: (p) => p === "/" }],
  },
  {
    label: "Market",
    items: [
      { to: "/market", label: "Ranking", icon: Trophy, match: (p) => p === "/market" },
      { to: "/market/screener", label: "Screener", icon: Filter },
      { to: "/market/search", label: "Pesquisa", icon: Search },
      { to: "/market/compare", label: "Comparador", icon: GitCompareArrows },
      { to: "/market/macro", label: "Macro", icon: Landmark },
      { to: "/market/benchmarks", label: "Benchmarks", icon: BarChart3 },
      { to: "/watchlist", label: "Watchlist", icon: Eye },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { to: "/portfolio", label: "Carteiras", icon: Wallet, match: (p) => p === "/portfolio" },
      { to: "/portfolio/income", label: "Proventos / Renda", icon: Banknote },
      { to: "/portfolio/contribution", label: "Aportes", icon: LineChart },
      { to: "/portfolio/allocate", label: "Alocação modelo", icon: PieChart },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { to: "/ai", label: "Copilot", icon: Sparkles },
      { to: "/journal", label: "Journal", icon: BookMarked },
      { to: "/validation", label: "Validação score", icon: ShieldCheck },
      { to: "/health", label: "Data Health", icon: Activity },
    ],
  },
];

export function Sidebar() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  return (
    <aside className="hidden md:flex w-[212px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="h-11 flex items-center gap-2 px-3 border-b border-sidebar-border">
        <div className="h-6 w-6 rounded-sm bg-primary text-primary-foreground grid place-items-center font-mono font-bold text-[11px]">
          U
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight">Urano</span>
          <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
            Terminal
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {groups.map((g) => (
          <div key={g.label} className="px-2 pb-3">
            <div className="px-2 py-1 text-[9px] uppercase tracking-[0.14em] font-semibold text-muted-foreground/70">
              {g.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const active = item.match
                  ? item.match(pathname)
                  : pathname === item.to || pathname.startsWith(item.to + "/");
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-2 border-t border-sidebar-border">
        <Link
          to="/settings"
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors",
            pathname === "/settings"
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
          )}
        >
          <Settings className="h-3.5 w-3.5 shrink-0 opacity-80" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
