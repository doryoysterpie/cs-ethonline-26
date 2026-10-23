/**
 * The source reference policy lives in `@cas/contracts` since CAS-005's S1
 * (one classifier for the MCP server and the source reader); this module keeps
 * the server's import path and re-exports it unchanged.
 */
export {
  REFERENCE_REJECTIONS,
  classifySourceReference,
  type ReferenceRejection,
  type ReferenceVerdict,
} from '@cas/contracts';
