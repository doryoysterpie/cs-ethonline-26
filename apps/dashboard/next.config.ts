import type { NextConfig } from 'next';

/**
 * Next configuration for the dashboard.
 *
 * - The two Node-only dependencies from `node_modules` stay external to the
 *   server bundle, so `argon2` loads its prebuilt binary and `pg` its own
 *   tree. The workspace packages that need Node semantics are loaded at run
 *   time by `src/server/packages.ts`, because Next bundles every workspace
 *   package regardless of this list.
 * - No production browser source map, no `X-Powered-By`, no remote image
 *   pattern of any kind (the app never uses `next/image`).
 * - `authInterrupts` enables `forbidden()` so a refused page answers 403.
 * - `serverActions.bodySizeLimit` bounds every action body at 1 MB, which
 *   holds the largest draft revision the data-access layer accepts.
 * - Static assets get the same baseline headers the proxy sets; the proxy
 *   adds the per-request nonce policy for every rendered response.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ['argon2', 'pg'],
  images: { remotePatterns: [], dangerouslyAllowSVG: false, unoptimized: true },
  // Every server action's body is bounded here, explicitly rather than by
  // the framework default, and the bound is tested against the largest
  // legitimate action, a draft revision (CAS-006, release blocker 7).
  experimental: { authInterrupts: true, serverActions: { bodySizeLimit: '1mb' } },
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
