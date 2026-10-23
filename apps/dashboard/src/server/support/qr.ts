import 'server-only';

import qrcode from 'qrcode-generator';

/**
 * A QR code drawn in-process from a pinned string (CAS-008, D46): the module
 * matrix from `qrcode-generator` 2.0.4, rendered by this code as one SVG path
 * so the page emits markup it composed itself and nothing fetched. Error
 * correction level M; the smallest version that fits; byte mode, since an
 * address is ASCII and the reader needs the exact string.
 */
export interface QrMatrix {
  readonly size: number;
  readonly dark: readonly (readonly boolean[])[];
}

const TEXT_MAX_LENGTH = 256;

export function qrMatrix(text: string): QrMatrix {
  if (text.length === 0 || text.length > TEXT_MAX_LENGTH) {
    throw new RangeError('qr text length out of range');
  }
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  const dark: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column += 1) line.push(code.isDark(row, column));
    dark.push(line);
  }
  return { size, dark };
}

/** One SVG path covering every dark module, in a `0 0 size size` viewBox. */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.dark.forEach((line, row) => {
    line.forEach((isDark, column) => {
      if (isDark) parts.push(`M${column} ${row}h1v1h-1z`);
    });
  });
  return parts.join('');
}
