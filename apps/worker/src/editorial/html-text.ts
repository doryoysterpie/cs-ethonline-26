/**
 * The HTML-to-text transform lives in `@cas/source-reader` since CAS-005's S1
 * (one extractor for the importer and the source reader); this module keeps
 * the worker's import path and re-exports it unchanged.
 */
export { htmlToText, TEXT_TRANSFORM } from '@cas/source-reader';
