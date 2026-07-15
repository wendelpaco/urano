import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

import appCss from "../styles.css?url";
import { Sidebar } from "@/components/app/Sidebar";
import { Topbar } from "@/components/app/Topbar";
import { CommandPaletteProvider } from "@/components/app/CommandPalette";
import { HealthBanner, UnauthorizedGuard } from "@/components/app/HealthBanner";
import { DisclaimerBanner } from "@/components/app/DisclaimerBanner";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="font-mono text-[10px] tracking-widest text-muted-foreground mb-3">
          URANO / 404
        </div>
        <h1 className="text-3xl font-semibold text-foreground">Rota não encontrada</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Este endpoint da plataforma não existe. Volte ao terminal.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20"
          >
            Ir para Overview
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="font-mono text-[10px] tracking-widest text-negative mb-3">
          URANO / RUNTIME ERROR
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Falha ao carregar esta tela
        </h1>
        <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20"
          >
            Tentar novamente
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-3"
          >
            Overview
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Urano — Terminal de Análise Fundamentalista" },
      {
        name: "description",
        content:
          "Plataforma premium de análise fundamentalista de ações e FIIs, com scores, screener, carteiras e copiloto de IA.",
      },
      { name: "author", content: "Urano" },
      { property: "og:title", content: "Urano — Terminal de Análise" },
      {
        property: "og:description",
        content: "Terminal financeiro moderno para análise fundamentalista com IA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#1a1c22" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <CommandPaletteProvider>
        <UnauthorizedGuard />
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
          <Sidebar />
          <div className="flex flex-1 flex-col min-w-0">
            <Topbar />
            <DisclaimerBanner />
            <HealthBanner />
            <main className="flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </div>
        <Toaster />
      </CommandPaletteProvider>
    </QueryClientProvider>
  );
}
