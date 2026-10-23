import type { NextConfig } from 'next';

/**
 * Next configuration for the dashboard.
 *
 * - The Node-only dependencies from `node_modules` stay external to the
 *   server bundle, so `argon2` loads its prebuilt binary, `pg` its own tree
 *   and `@resvg/resvg-wasm` its WebAssembly module from its own directory. The workspace packages that need Node semantics are loaded at run
 *   time by `src/server/packages.ts`, because Next bundles every workspace
 *   package regardless of this list.
 * - No production browser source map, no `X-Powered-By`, no remote image
 *   pattern of any kind (the app never uses `next/image`).
 * - `authInterrupts` enables `forbidden()` so a refused page answers 403.
 * - `serverActions.bodySizeLimit` bounds every action body at 2 MB, which
 *   holds the largest round-up revision the data-access layer accepts
 *   (400,000 characters, UTF-8; re-review of 22 October 2026, RR3) and the
 *   largest draft revision (200,000).
 * - Static assets get the same baseline headers the proxy sets; the proxy
 *   adds the per-request nonce policy for every rendered response.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ['argon2', 'pg', '@resvg/resvg-wasm'],
  images: { remotePatterns: [], dangerouslyAllowSVG: false, unoptimized: true },
  // Every server action's body is bounded here, explicitly rather than by
  // the framework default, and the bound is tested against the largest
  // legitimate action, a draft revision (CAS-006, release blocker 7).
  experimental: { authInterrupts: true, serverActions: { bodySizeLimit: '2mb' } },
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      ],
    },
  ],
};

export default config;
