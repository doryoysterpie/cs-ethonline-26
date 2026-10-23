import 'server-only';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { CARD_FONT } from './svg.ts';

/**
 * The card's PNG (CAS-009, D48, decision 2): the application's own SVG
 * rasterized in process by resvg compiled to WebAssembly, with two TrueType
 * files from a pinned package as its only fonts. No native binary, no system
 * font, no network: the WebAssembly module has no input or output of its own,
 * so nothing an SVG names can be fetched, and the SVG is the dashboard's own.
 *
 * The module is initialised once per process. Next compiles route handlers
 * and server actions as separate module graphs while the package itself is
 * loaded once (it is a server-external package), so the initialisation is
 * held on `globalThis` under a registered symbol, as the runtime is.
 */
export const PNG_MAX_BYTES = 1_048_576;
const WASM = '@resvg/resvg-wasm/index_bg.wasm';
const FONTS = [
  '@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf',
  '@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf',
];

interface Rasterizer {
  readonly render: (svg: string) => Uint8Array;
}

const HOLDER = Symbol.for('cas.dashboard.card-rasterizer');

async function open(): Promise<Rasterizer> {
  const require = createRequire(import.meta.url);
  const locate = (specifier: string): string => require.resolve(specifier);
  const resvg = await import('@resvg/resvg-wasm');
  await resvg.initWasm(await readFile(locate(WASM)));
  const fontBuffers = await Promise.all(
    FONTS.map(async (font) => new Uint8Array(await readFile(locate(font)))),
  );
  return {
    render: (svg) =>
      new resvg.Resvg(svg, {
        font: {
          fontBuffers,
          loadSystemFonts: false,
          defaultFontFamily: CARD_FONT,
          monospaceFamily: CARD_FONT,
          sansSerifFamily: CARD_FONT,
          serifFamily: CARD_FONT,
        },
        fitTo: { mode: 'original' },
      })
        .render()
        .asPng(),
  };
}

function rasterizer(): Promise<Rasterizer> {
  const globals = globalThis as unknown as Record<symbol, Promise<Rasterizer> | undefined>;
  const held = globals[HOLDER];
  if (held !== undefined) return held;
  const opening = open();
  globals[HOLDER] = opening;
  // A failed initialisation is retried on the next request, not cached.
  opening.catch(() => {
    if (globals[HOLDER] === opening) globals[HOLDER] = undefined;
  });
  return opening;
}

export class RasterError extends Error {
  constructor(readonly code: 'raster_failed' | 'raster_too_large') {
    super(
      code === 'raster_failed'
        ? 'the card image could not be rendered'
        : 'the card image is too large',
    );
    this.name = 'RasterError';
  }
}

/** The PNG and its SHA-256, or a fixed error; the SVG is never echoed. */
export async function rasterize(
  svg: string,
): Promise<{ readonly png: Uint8Array; readonly sha256: string }> {
  let png: Uint8Array;
  try {
    png = (await rasterizer()).render(svg);
  } catch {
    throw new RasterError('raster_failed');
  }
  if (png.length > PNG_MAX_BYTES) throw new RasterError('raster_too_large');
  return { png, sha256: createHash('sha256').update(png).digest('hex') };
}
