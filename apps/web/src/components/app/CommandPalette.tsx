import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Trophy,
  Filter,
  Wallet,
  Sparkles,
  Settings,
  LineChart,
  Search,
  Activity,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

type Ctx = { open: () => void; close: () => void; isOpen: boolean };
const PaletteCtx = createContext<Ctx | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook co-locado com PaletteCtx neste arquivo
export function useCommandPalette() {
  const c = useContext(PaletteCtx);
  if (!c) throw new Error("useCommandPalette outside provider");
  return c;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    navigate({ to });
  };

  return (
    <PaletteCtx.Provider value={{ open, close, isOpen }}>
      {children}
      <CommandDialog open={isOpen} onOpenChange={setOpen}>
        <CommandInput placeholder="Buscar página, ativo ou ação…" />
        <CommandList>
          <CommandEmpty>Nada encontrado.</CommandEmpty>
          <CommandGroup heading="Navegar">
            <CommandItem onSelect={() => go("/")}>
              <LayoutDashboard /> Overview
            </CommandItem>
            <CommandItem onSelect={() => go("/market")}>
              <Trophy /> Ranking
            </CommandItem>
            <CommandItem onSelect={() => go("/market/screener")}>
              <Filter /> Screener
            </CommandItem>
            <CommandItem onSelect={() => go("/market/search")}>
              <Search /> Pesquisar ativo
            </CommandItem>
            <CommandItem onSelect={() => go("/portfolio")}>
              <Wallet /> Carteiras
            </CommandItem>
            <CommandItem onSelect={() => go("/portfolio/contribution")}>
              <LineChart /> Simulador de aporte
            </CommandItem>
            <CommandItem onSelect={() => go("/ai")}>
              <Sparkles /> Copilot
            </CommandItem>
            <CommandItem onSelect={() => go("/health")}>
              <Activity /> Data Health
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Sistema">
            <CommandItem onSelect={() => go("/settings")}>
              <Settings /> Settings — API
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </PaletteCtx.Provider>
  );
}
