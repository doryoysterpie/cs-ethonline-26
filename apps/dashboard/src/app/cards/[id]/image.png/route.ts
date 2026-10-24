import { cardImage } from '../../../../server/dal/cards.ts';
import { networkKey } from '../../../../server/http/network.ts';
import { getRuntime } from '../../../../server/runtime.ts';
import { imageFailure } from '../image-failure.ts';

export const dynamic = 'force-dynamic';

/** The card's PNG for link previews (D48, decision 2): from the cache, rasterized once per card and revision. */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  const runtime = await getRuntime();
  try {
    const image = await cardImage(runtime, id, 'png', networkKey(request.headers, runtime.config));
    const body = image.body as Uint8Array;
    return new Response(Buffer.from(body), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(body.length),
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return imageFailure(error);
  }
}
