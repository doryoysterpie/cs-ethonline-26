import { cardImage } from '../../../../server/dal/cards.ts';
import { networkKey } from '../../../../server/http/network.ts';
import { getRuntime } from '../../../../server/runtime.ts';
import { imageFailure } from '../image-failure.ts';

export const dynamic = 'force-dynamic';

/** The card's SVG, as a download: text only, the dashboard's own document. */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  const runtime = await getRuntime();
  try {
    const image = await cardImage(runtime, id, 'svg', networkKey(request.headers, runtime.config));
    return new Response(image.body as string, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'content-disposition': 'attachment; filename="latest-in-cyber-card.svg"',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return imageFailure(error);
  }
}
