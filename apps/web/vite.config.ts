import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const isDevBuild = command === "build" && mode === "development";

  const envDefine = Object.fromEntries(
    Object.entries(loadEnv(mode, process.cwd(), "VITE_")).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  );

  return {
    define: envDefine,
    ...(isDevBuild
      ? {
          // Client-scoped so React DevTools gets the dev react-dom; a global NODE_ENV
          // flip would emit jsxDEV, which the react-server SSR runtime can't resolve.
          environments: {
            client: { define: { "process.env.NODE_ENV": JSON.stringify("development") } },
          },
          esbuild: { keepNames: true },
        }
      : {}),
    // Match the build's CSS pipeline in dev. Vite uses PostCSS in dev and only
    // runs Lightning CSS at build, so build-time transforms (e.g. collapsing a
    // hand-written `-webkit-backdrop-filter` to the prefixed form Chrome ignores)
    // break the built/static output while the dev preview looks fine. Running
    // Lightning CSS in both keeps the preview honest.
    css: { transformer: "lightningcss" },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      tsconfigPaths: true,
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    // Dep re-optimization rotates the optimized-dep hash and 504s tabs holding
    // the old one; pre-bundle the always-present client deps + tolerate stale
    // requests. React core only — including @tanstack/react-start would pull its
    // node:async_hooks server entry into the client bundle and crash hydration.
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },
    server: {
      host: true, // 0.0.0.0 + IPv6 — acessível via localhost e IP da LAN
      port: 8080,
      watch: { awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } },
      // Dev: browser fala só com :8080. /v1 → API local. Zero CORS / PNA.
      proxy: {
        "/v1": {
          target: process.env.URANO_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
          changeOrigin: true,
          // allocate/ranking frios podem passar de 30s se cache estiver vazio
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
    plugins: [
      ...(mode === "development"
        ? [
            devtools({
              logging: false,
              eventBusConfig: { enabled: false },
              enhancedLogs: { enabled: false },
              consolePiping: { enabled: false },
              removeDevtoolsOnBuild: false,
              injectSource: { enabled: true },
            }),
          ]
        : []),
      tailwindcss(),
      tanstackStart({
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
        // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
        server: { entry: "server" },
      }),
      ...(command === "build" ? [nitro({ defaultPreset: "cloudflare-module" })] : []),
      viteReact(),
    ],
  };
});
