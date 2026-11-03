import { isMap, isNode, isScalar, isSeq, Scalar, type Pair, type YAMLMap } from 'yaml';

import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';
import { readWorkflowYaml } from './lib/workflow-yaml.ts';
import { RUNNER_IMAGE_COMMAND, RUNNER_IMAGE_STEP, RUNNER_LABEL } from './runner.ts';

/**
 * GitHub Actions workflow policy (docs/SECURITY.md section 8; D56, D59).
 *
 * Each workflow is read by the one YAML reader (`lib/workflow-yaml.ts`), and every rule applies to
 * the parsed document, never to the text. A value a rule compares must be a plain (unquoted)
 * scalar of the shape the rule names; any other shape is refused, not skipped.
 *
 * - `permissions` at the root: a mapping of plain values, or `read-all`; `write-all` is too broad.
 * - `on`: a trigger name, a sequence of them, or a mapping keyed by them; never
 *   `pull_request_target` or `workflow_run`.
 * - `jobs`: a non-empty mapping of mappings. A job-level `uses` (a reusable workflow, whose runner
 *   and steps live in another file) is refused. `runs-on` is the one pinned label (`runner.ts`).
 *   `steps` is a non-empty sequence of mappings whose first is the runner-image step and nothing
 *   else: its name and its one exact command.
 * - Every `uses`, wherever it appears: a local `./` action, a `docker://` image pinned by digest, or
 *   an action pinned to a full commit SHA with a version comment beside it.
 * - Every `image`, and a job's `container` given as a string: pinned by digest. A container
 *   mapping and every service must name an `image`.
 * - Every checkout step sets `persist-credentials` to `false`.
 * - No key anywhere is `ImageOS` or `ImageVersion`, which would change what the runner-image step
 *   prints.
 */

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u;
const VERSION_COMMENT = /^\s*v?\d/u;
const DIGEST = /@sha256:[0-9a-f]{64}$/u;
const DANGEROUS_TRIGGERS = new Set(['pull_request_target', 'workflow_run']);
const IMAGE_VARIABLES = new Set(['ImageOS', 'ImageVersion']);
const CHECKOUT = 'actions/checkout@';

/** A plain (unquoted) string scalar's value; null for any other node or none. */
function plainString(node: unknown): string | null {
  return isScalar(node) && node.type === Scalar.PLAIN && typeof node.value === 'string'
    ? node.value
    : null;
}

function digestPinned(node: unknown): boolean {
  const reference = plainString(node);
  return reference !== null && DIGEST.test(reference);
}

function keyOf(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : '';
}

/** Every pair of every mapping under `node`, depth first. */
function eachPair(node: unknown, visit: (pair: Pair) => void): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      visit(pair);
      eachPair(pair.value, visit);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) eachPair(item, visit);
  }
}

function logsRunnerImage(step: unknown): boolean {
  return (
    isMap(step) &&
    step.items.length === 2 &&
    plainString(step.get('name', true)) === RUNNER_IMAGE_STEP &&
    plainString(step.get('run', true)) === RUNNER_IMAGE_COMMAND
  );
}

export function scanWorkflowText(relativePath: string, text: string): Finding[] {
  const workflow = readWorkflowYaml(relativePath, text);
  const root = workflow.root;
  if (root === null) return [...workflow.problems];
  const findings: Finding[] = [];
  const report = (node: unknown, rule: string): void => {
    findings.push(finding(relativePath, workflow.line(isNode(node) ? node : null), rule));
  };

  if (!root.has('permissions')) {
    report(null, 'permissions_missing');
  } else {
    const permissions = root.get('permissions', true);
    if (isMap(permissions)) {
      for (const pair of permissions.items) {
        if (plainString(pair.value) === null) report(pair.key, 'permissions_unsupported');
      }
    } else {
      const scope = plainString(permissions);
      if (scope === 'write-all') report(permissions, 'permissions_too_broad');
      else if (scope !== 'read-all') report(permissions, 'permissions_unsupported');
    }
  }

  const on = root.get('on', true);
  const triggers: Array<readonly [string, unknown]> = [];
  if (isMap(on)) {
    for (const pair of on.items) triggers.push([keyOf(pair), pair.key]);
  } else if (isSeq(on)) {
    for (const item of on.items) {
      const name = plainString(item);
      if (name === null) report(item, 'triggers_unsupported');
      else triggers.push([name, item]);
    }
  } else if (root.has('on')) {
    const name = plainString(on);
    if (name === null) report(on, 'triggers_unsupported');
    else triggers.push([name, on]);
  }
  for (const [name, node] of triggers) {
    if (DANGEROUS_TRIGGERS.has(name)) report(node, 'dangerous_trigger');
  }

  const jobs = root.get('jobs', true);
  if (!isMap(jobs) || jobs.items.length === 0) {
    report(jobs, 'jobs_missing');
  } else {
    for (const pair of jobs.items) scanJob(pair, report);
  }

  eachPair(root, (pair) => {
    const key = keyOf(pair);
    if (key === 'uses') scanUses(pair.value, report);
    if (key === 'image' && !digestPinned(pair.value)) {
      report(pair.value ?? pair.key, 'image_not_digest_pinned');
    }
    if (IMAGE_VARIABLES.has(key)) report(pair.key, 'runner_image_overridden');
  });

  return findings;
}

function scanJob(pair: Pair, report: (node: unknown, rule: string) => void): void {
  const job = pair.value;
  if (!isMap(job)) {
    report(pair.key, 'job_unsupported');
    return;
  }
  if (job.has('uses')) {
    report(job.get('uses', true), 'job_reusable_workflow');
    return;
  }
  if (plainString(job.get('runs-on', true)) !== RUNNER_LABEL) {
    report(job.has('runs-on') ? job.get('runs-on', true) : pair.key, 'runner_not_pinned');
  }
  if (job.has('container')) {
    const container = job.get('container', true);
    if (isMap(container) ? !container.has('image') : !digestPinned(container)) {
      report(container, 'image_not_digest_pinned');
    }
  }
  if (job.has('services')) {
    const services = job.get('services', true);
    if (!isMap(services)) {
      report(services, 'image_not_digest_pinned');
    } else {
      for (const service of services.items) {
        if (!isMap(service.value) || !service.value.has('image')) {
          report(service.key, 'image_not_digest_pinned');
        }
      }
    }
  }
  const steps = job.get('steps', true);
  if (!isSeq(steps) || steps.items.length === 0) {
    report(job.has('steps') ? steps : pair.key, 'runner_image_not_logged');
    return;
  }
  if (!logsRunnerImage(steps.items[0])) report(steps.items[0], 'runner_image_not_logged');
  for (const step of steps.items) {
    if (!isMap(step)) report(step, 'step_unsupported');
    else scanCheckout(step, report);
  }
}

function scanUses(value: unknown, report: (node: unknown, rule: string) => void): void {
  const reference = plainString(value);
  if (reference === null) {
    report(value, 'action_not_sha_pinned');
  } else if (reference.startsWith('./')) {
    // A local action is repository content and is reviewed as such.
  } else if (reference.startsWith('docker://')) {
    if (!DIGEST.test(reference)) report(value, 'image_not_digest_pinned');
  } else if (!PINNED_ACTION.test(reference)) {
    report(value, 'action_not_sha_pinned');
  } else if (!VERSION_COMMENT.test(isScalar(value) ? (value.comment ?? '') : '')) {
    report(value, 'action_pin_missing_version_comment');
  }
}

function scanCheckout(step: YAMLMap, report: (node: unknown, rule: string) => void): void {
  const uses = step.get('uses', true);
  if (!(plainString(uses) ?? '').startsWith(CHECKOUT)) return;
  const options = step.get('with', true);
  const persist = isMap(options) ? options.get('persist-credentials', true) : null;
  if (!(isScalar(persist) && persist.type === Scalar.PLAIN && persist.value === false)) {
    report(uses, 'checkout_persists_credentials');
  }
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
