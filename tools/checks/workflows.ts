import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';

/**
 * GitHub Actions workflow policy (docs/SECURITY.md section 8).
 *
 * Every `uses:` must name a full 40-character commit SHA with a version
 * comment beside it, every service image must be pinned by digest, every
 * workflow must declare least-privilege `permissions:` at the top level,
 * no workflow may run on `pull_request_target` or `workflow_run`, and every
 * checkout must set `persist-credentials: false`. The scan is line-based over
 * the project's own workflow files, which are written to be read that way.
 */

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const USES = /^\s*-?\s*uses:\s*(\S+)(.*)$/u;
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u;
const VERSION_COMMENT = /^\s*#\s*v?\d/u;
const IMAGE = /^\s*image:\s*(\S+)/u;
const DIGEST = /@sha256:[0-9a-f]{64}$/u;
const TOP_LEVEL_PERMISSIONS = /^permissions:\s*(.*)$/u;
const DANGEROUS_TRIGGER = /^\s*(?:-\s*)?(pull_request_target|workflow_run)\s*:?\s*$/u;
const CHECKOUT = /^\s*-?\s*uses:\s*actions\/checkout@/u;
const PERSIST_CREDENTIALS_OFF = /^\s*persist-credentials:\s*false\s*$/u;
const STEP_START = /^\s*-\s+(name|uses|run):/u;

export function scanWorkflowText(relativePath: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  let sawPermissions = false;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const permissions = TOP_LEVEL_PERMISSIONS.exec(line);
    if (permissions !== null) {
      sawPermissions = true;
      if ((permissions[1] ?? '').trim() === 'write-all') {
        findings.push(finding(relativePath, lineNumber, 'permissions_too_broad'));
      }
    }
    if (DANGEROUS_TRIGGER.test(line)) {
      findings.push(finding(relativePath, lineNumber, 'dangerous_trigger'));
    }
    const uses = USES.exec(line);
    if (uses !== null) {
      const reference = uses[1] ?? '';
      const rest = uses[2] ?? '';
      if (reference.startsWith('./')) {
        // A local action is repository content and is reviewed as such.
      } else if (reference.startsWith('docker://')) {
        if (!DIGEST.test(reference)) {
          findings.push(finding(relativePath, lineNumber, 'image_not_digest_pinned'));
        }
      } else if (!PINNED_ACTION.test(reference)) {
        findings.push(finding(relativePath, lineNumber, 'action_not_sha_pinned'));
      } else if (!VERSION_COMMENT.test(rest)) {
        findings.push(finding(relativePath, lineNumber, 'action_pin_missing_version_comment'));
      }
    }
    const image = IMAGE.exec(line);
    if (image !== null && !DIGEST.test(image[1] ?? '')) {
      findings.push(finding(relativePath, lineNumber, 'image_not_digest_pinned'));
    }
    if (CHECKOUT.test(line)) {
      let persisted = true;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? '';
        if (STEP_START.test(candidate)) break;
        if (PERSIST_CREDENTIALS_OFF.test(candidate)) {
          persisted = false;
          break;
        }
      }
      if (persisted) {
        findings.push(finding(relativePath, lineNumber, 'checkout_persists_credentials'));
      }
    }
  }
  if (!sawPermissions) findings.push(finding(relativePath, null, 'permissions_missing'));
  return findings;
}

export interface WorkflowsResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

export function scanWorkflows(
  root: string,
  entries: readonly TrackedEntry[] = trackedEntries(root),
): WorkflowsResult {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!WORKFLOW_FILE.test(entry.path)) continue;
    scanned += 1;
    findings.push(...scanWorkflowText(entry.path, readTracked(root, entry.path).toString('utf8')));
  }
  if (scanned === 0) findings.push(finding('.github/workflows', null, 'no_workflow_found'));
  return { scanned, findings };
}

if (isMain(import.meta.url)) {
  const result = scanWorkflows(repositoryRoot());
  process.exitCode = conclude('workflows', result.scanned, result.findings);
}
