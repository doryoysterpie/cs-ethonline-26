import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

import { toSafeHast } from '../server/markdown/sanitize.ts';

/**
 * Renders Markdown as React elements through the allowlist sanitizer.
 * No HTML string is ever set into the document: the sanitized tree becomes
 * elements, and React escapes every text node.
 */
export function SafeMarkdown({ markdown }: { readonly markdown: string }) {
  const tree = toSafeHast(markdown);
  return (
    <div className="markdown">
      {toJsxRuntime(tree, { Fragment, jsx, jsxs, elementAttributeNameCase: 'react' })}
    </div>
  );
}
