import {
  isAlias,
  isMap,
  isScalar,
  LineCounter,
  parseAllDocuments,
  visit,
  type Node,
  type YAMLMap,
} from 'yaml';

import { finding, type Finding } from './report.ts';

/**
 * The one reader of the YAML the repository checks inspect: the workflow files, read by
 * `workflows.ts` and `rulesets.ts` (D59). A file is parsed as YAML 1.2 under the core schema, so
 * `on` is a key and not the boolean true. It is refused, with a finding, when the parser reports
 * any error or any warning, when it holds other than exactly one document, when any key is not a
 * string, or when it carries an anchor or an alias: the alias limit is zero, so a merge key cannot
 * bring one in either. The checks apply their rules to the parsed nodes, never to the text.
 */

export interface WorkflowYaml {
  /** The parsed root mapping, or null when the file was refused. */
  readonly root: YAMLMap | null;
  /** Why the file was refused; empty when `root` is set. */
  readonly problems: readonly Finding[];
  /** The 1-based line a parsed node starts on. */
  readonly line: (node: Node | null | undefined) => number | null;
}

export function readWorkflowYaml(relativePath: string, text: string): WorkflowYaml {
  const lineCounter = new LineCounter();
  const line = (node: Node | null | undefined): number | null =>
    node?.range === undefined || node.range === null
      ? null
      : lineCounter.linePos(node.range[0]).line;
  const refused = (problems: Finding[]): WorkflowYaml => ({ root: null, problems, line });

  const documents = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    strict: true,
    lineCounter,
  });
  if (documents.length !== 1) {
    return refused([finding(relativePath, null, 'workflow_not_one_document')]);
  }
  const document = documents[0];
  if (document === undefined) {
    return refused([finding(relativePath, null, 'workflow_not_one_document')]);
  }

  const problems: Finding[] = [];
  for (const error of document.errors) {
    problems.push(
      finding(relativePath, error.linePos?.[0]?.line ?? null, 'workflow_yaml_error', error.code),
    );
  }
  for (const warning of document.warnings) {
    problems.push(
      finding(
        relativePath,
        warning.linePos?.[0]?.line ?? null,
        'workflow_yaml_warning',
        warning.code,
      ),
    );
  }
  let aliasOrAnchor = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) {
        aliasOrAnchor = true;
        problems.push(finding(relativePath, line(node), 'workflow_yaml_alias'));
      } else if (node.anchor !== undefined) {
        aliasOrAnchor = true;
        problems.push(finding(relativePath, line(node), 'workflow_yaml_anchor'));
      }
    },
    Pair(_key, pair) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== 'string') {
        problems.push(finding(relativePath, line(isScalar(key) ? key : null), 'workflow_yaml_key'));
      }
    },
  });
  if (!aliasOrAnchor) {
    try {
      document.toJS({ maxAliasCount: 0 });
    } catch {
      problems.push(finding(relativePath, null, 'workflow_yaml_alias'));
    }
  }
  if (problems.length > 0) return refused(problems);
  if (!isMap(document.contents)) {
    return refused([finding(relativePath, null, 'workflow_not_mapping')]);
  }
  return { root: document.contents, problems: [], line };
}
