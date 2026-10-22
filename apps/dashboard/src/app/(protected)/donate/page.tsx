import { Notice } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { donationsView } from '../../../server/dal/support.ts';
import { qrMatrix, qrPath } from '../../../server/support/qr.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

const CHAIN_NAMES = { bitcoin: 'Bitcoin', ethereum: 'Ethereum mainnet', base: 'Base' } as const;

/**
 * The donation page (CAS-008, D46): the owner's pinned addresses, each with a
 * QR code drawn in-process from the same pinned string, the tokens accepted
 * and the date the address was verified by a transfer. Nothing on this page
 * is fetched; an address changes only by a reviewed commit.
 */
export default async function DonatePage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => donationsView(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const { entries } = result.value;
  return (
    <section>
      <h2>Donate</h2>
      <p className="small">
        One-off donations in crypto. Each address below was verified by a small transfer on the date
        shown and is pinned in the repository; copy the text or scan the code, and send only the
        tokens listed for that network.
      </p>
      {entries.length === 0 ? (
        <p>No donation address is pinned yet.</p>
      ) : (
        <ul className="donations">
          {entries.map((entry) => {
            const matrix = qrMatrix(entry.address);
            return (
              <li key={`${entry.chain}-${entry.address}`}>
                <h3>
                  {CHAIN_NAMES[entry.chain]} · {entry.label}
                </h3>
                <p className="mono">{entry.address}</p>
                <svg
                  viewBox={`0 0 ${matrix.size} ${matrix.size}`}
                  width={matrix.size * 4}
                  height={matrix.size * 4}
                  role="img"
                  aria-label={`QR code of the ${CHAIN_NAMES[entry.chain]} address`}
                  shapeRendering="crispEdges"
                >
                  <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
                  <path d={qrPath(matrix)} fill="#000000" />
                </svg>
                <p className="small">
                  Accepts {entry.tokens.join(', ')}. Verified on {entry.verifiedOn}.
                  {entry.note.length > 0 ? ` ${entry.note}` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
