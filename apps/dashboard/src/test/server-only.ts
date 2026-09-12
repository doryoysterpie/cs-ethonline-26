/**
 * Test stand-in for the `server-only` marker. The real package throws when
 * imported outside a React server context, which is exactly what the Next
 * build relies on; under Vitest the server tree is imported directly, so the
 * marker is replaced with nothing. This file is never part of a build.
 */
export {};
