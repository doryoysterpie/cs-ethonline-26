import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { RUNNER_IMAGE_COMMAND, RUNNER_IMAGE_STEP, RUNNER_LABEL } from './runner.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';

/**
 * GitHub Actions workflow policy (docs/SECURITY.md section 8).
 *
 * Every `uses:` must name a full 40-character commit SHA with a version
 * comment beside it, every service image must be pinned by digest, every
 * workflow must declare least-privilege `permissions:` at the top level,
 * no workflow may run on `pull_request_target` or `workflow_run`, every
 * checkout must set `persist-credentials: false`, every job must run on the
 * one pinned runner label (`runner.ts`, D56), and every job's first step must
 * log the runner image. The scan is line-based over the project's own
 * workflow files, which are written to be read that way; the jobs are read by
 * their indentation under `jobs:`.
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
const RUNS_ON = /^\s*runs-on:\s*(.*?)\s*$/u;
const JOBS = /^jobs:\s*$/u;
const TOP_LEVEL_KEY = /^[^\s#]/u;
const JOB_START = /^ {2}[A-Za-z0-9_-]+:\s*$/u;
const JOB_KEY = /^ {4}([A-Za-z0-9_-]+):/u;
const STEP_NAME = /^(\s*)-\s+name:\s*(.+?)\s*$/u;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/u;
const IMAGE_VARIABLE = /(?:^|[\s{,"'])Image(?:OS|Version)["']?\s*:(?:\s|$)/u;

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
    const runsOn = RUNS_ON.exec(line);
    if (runsOn !== null) {
      const label = (runsOn[1] ?? '').replace(/^(['"])(.*)\1$/u, '$2');
      if (label !== RUNNER_LABEL) {
        findings.push(finding(relativePath, lineNumber, 'runner_not_pinned'));
      }
    }
    if (IMAGE_VARIABLE.test(line)) {
      // A value set for ImageOS or ImageVersion would make the runner-image log name another image.
      findings.push(finding(relativePath, lineNumber, 'runner_image_overridden'));
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
  findings.push(...scanJobs(relativePath, lines));
  return findings;
}

/**
 * Every job under `jobs:` names its own runner and its own steps (D56). A job-level call of a
 * reusable workflow (`uses:`) takes both from another file, outside this check, and is refused.
 * A job without `runs-on:` has no runner this check can hold to the label. The first step must be
 * the runner-image step and nothing else: its name and its one command, exactly, with no `if:`
 * that could skip it and no `env:` that could change what it prints (review of 13298ef, M1).
 */
function scanJobs(relativePath: string, lines: readonly string[]): Finding[] {
  const start = lines.findIndex((line) => JOBS.test(line));
  if (start === -1) return [finding(relativePath, null, 'jobs_missing')];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TOP_LEVEL_KEY.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  const jobStarts: number[] = [];
  for (let index = start + 1; index < end; index += 1) {
    if (JOB_START.test(lines[index] ?? '')) jobStarts.push(index);
  }
  if (jobStarts.length === 0) return [finding(relativePath, start + 1, 'jobs_missing')];
  const findings: Finding[] = [];
  for (const [position, jobStart] of jobStarts.entries()) {
    const jobEnd = jobStarts[position + 1] ?? end;
    const keys = new Map<string, number>();
    for (let index = jobStart + 1; index < jobEnd; index += 1) {
      const key = JOB_KEY.exec(lines[index] ?? '')?.[1];
      if (key !== undefined && !keys.has(key)) keys.set(key, index);
    }
    const uses = keys.get('uses');
    if (uses !== undefined) {
      findings.push(finding(relativePath, uses + 1, 'job_reusable_workflow'));
      continue;
    }
    if (!keys.has('runs-on')) {
      findings.push(finding(relativePath, jobStart + 1, 'runner_not_pinned'));
    }
    const steps = keys.get('steps');
    if (steps === undefined || !firstStepLogsImage(lines, steps, jobEnd)) {
      findings.push(finding(relativePath, (steps ?? jobStart) + 1, 'runner_image_not_logged'));
    }
  }
  return findings;
}

function firstStepLogsImage(lines: readonly string[], steps: number, jobEnd: number): boolean {
  let index = steps + 1;
  while (index < jobEnd && BLANK_OR_COMMENT.test(lines[index] ?? '')) index += 1;
  const name = STEP_NAME.exec(lines[index] ?? '');
  if (name === null || name[2] !== RUNNER_IMAGE_STEP) return false;
  const indent = (name[1] ?? '').length;
  const body: string[] = [];
  for (let next = index + 1; next < jobEnd; next += 1) {
    const line = lines[next] ?? '';
    if (BLANK_OR_COMMENT.test(line)) continue;
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line.trim());
  }
  return body.length === 1 && body[0] === `run: ${RUNNER_IMAGE_COMMAND}`;
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
