import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries } from './lib/tracked.ts';

const RULESET_PATH = '.github/rulesets/main.json';
const WORKFLOW_PATHS = ['.github/workflows/ci.yml', '.github/workflows/codeql.yml'] as const;
const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

export const REQUIRED_MAIN_CHECKS = [
  'Verify',
  'PostgreSQL integration',
  'PostgreSQL integration, password authentication',
  'Browser E2E',
  'Supply chain',
  'Analyze (javascript-typescript)',
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return [...value].sort();
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  const sorted = sortedStrings(actual);
  return sorted !== null && sorted.join('\0') === [...expected].sort().join('\0');
}

function namedRule(rules: unknown, type: string): JsonObject | null {
  if (!Array.isArray(rules)) return null;
  const matches = rules.filter((rule) => isObject(rule) && rule.type === type);
  return matches.length === 1 ? (matches[0] as JsonObject) : null;
}

/**
 * Extract literal job display names from this repository's workflow style.
 * A required-check context is the job-level `name`, not the workflow name or
 * job identifier. Expressions and matrices are intentionally refused.
 */
export function workflowJobNames(text: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  let inJob = false;
  for (const line of text.split('\n')) {
    if (line === 'jobs:') {
      inJobs = true;
      inJob = false;
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s#]/u.test(line)) break;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line)) {
      inJob = true;
      continue;
    }
    if (!inJob) continue;
    const match = /^ {4}name:\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const raw = match[1] ?? '';
    const name =
      (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))
        ? raw.slice(1, -1)
        : raw;
    if (name.length > 0 && !name.includes('${{')) names.push(name);
  }
  return names;
}

export function scanMainRulesetText(
  rulesetText: string,
  workflowTexts: Readonly<Record<string, string>>,
): Finding[] {
  const findings: Finding[] = [];
  let value: unknown;
  try {
    value = JSON.parse(rulesetText) as unknown;
  } catch {
    return [finding(RULESET_PATH, null, 'invalid_json')];
  }
  if (!isObject(value)) return [finding(RULESET_PATH, null, 'ruleset_not_object')];

  if (value.target !== 'branch') findings.push(finding(RULESET_PATH, null, 'target_not_branch'));
  if (value.enforcement !== 'active') {
    findings.push(finding(RULESET_PATH, null, 'enforcement_not_active'));
  }
  if (!Array.isArray(value.bypass_actors) || value.bypass_actors.length !== 0) {
    findings.push(finding(RULESET_PATH, null, 'bypass_actors_present'));
  }

  const conditions = isObject(value.conditions) ? value.conditions : null;
  const refName = conditions !== null && isObject(conditions.ref_name) ? conditions.ref_name : null;
  if (
    refName === null ||
    !sameStrings(refName.include, ['refs/heads/main']) ||
    !sameStrings(refName.exclude, [])
  ) {
    findings.push(finding(RULESET_PATH, null, 'main_condition_mismatch'));
  }

  const deletion = namedRule(value.rules, 'deletion');
  if (deletion === null) findings.push(finding(RULESET_PATH, null, 'deletion_rule_missing'));
  const nonFastForward = namedRule(value.rules, 'non_fast_forward');
  if (nonFastForward === null) {
    findings.push(finding(RULESET_PATH, null, 'non_fast_forward_rule_missing'));
  }

  const pullRequest = namedRule(value.rules, 'pull_request');
  const pull =
    pullRequest !== null && isObject(pullRequest.parameters) ? pullRequest.parameters : null;
  if (pull === null) {
    findings.push(finding(RULESET_PATH, null, 'pull_request_rule_missing'));
  } else {
    if (pull.required_approving_review_count !== 1) {
      findings.push(finding(RULESET_PATH, null, 'one_review_not_required'));
    }
    if (pull.dismiss_stale_reviews_on_push !== true) {
      findings.push(finding(RULESET_PATH, null, 'stale_reviews_not_dismissed'));
    }
    if (pull.require_last_push_approval !== true) {
      findings.push(finding(RULESET_PATH, null, 'independent_last_push_review_not_required'));
    }
    if (pull.required_review_thread_resolution !== true) {
      findings.push(finding(RULESET_PATH, null, 'review_thread_resolution_not_required'));
    }
    if (!sameStrings(pull.allowed_merge_methods, ['merge', 'squash', 'rebase'])) {
      findings.push(finding(RULESET_PATH, null, 'merge_methods_incomplete'));
    }
  }

  const statusRule = namedRule(value.rules, 'required_status_checks');
  const status =
    statusRule !== null && isObject(statusRule.parameters) ? statusRule.parameters : null;
  let contexts: string[] | null = null;
  if (status === null) {
    findings.push(finding(RULESET_PATH, null, 'required_status_checks_rule_missing'));
  } else {
    if (status.strict_required_status_checks_policy !== true) {
      findings.push(finding(RULESET_PATH, null, 'strict_status_policy_not_required'));
    }
    if (status.do_not_enforce_on_create !== false) {
      findings.push(finding(RULESET_PATH, null, 'status_checks_not_enforced_on_create'));
    }
    const entries = status.required_status_checks;
    if (!Array.isArray(entries)) {
      findings.push(finding(RULESET_PATH, null, 'required_status_checks_invalid'));
    } else {
      contexts = [];
      for (const entry of entries) {
        if (!isObject(entry) || typeof entry.context !== 'string') {
          findings.push(finding(RULESET_PATH, null, 'required_status_check_invalid'));
          continue;
        }
        contexts.push(entry.context);
        if (entry.integration_id !== GITHUB_ACTIONS_INTEGRATION_ID) {
          findings.push(
            finding(RULESET_PATH, null, 'required_status_check_source_mismatch', entry.context),
          );
        }
      }
      if (!sameStrings(contexts, REQUIRED_MAIN_CHECKS)) {
        findings.push(finding(RULESET_PATH, null, 'required_status_checks_mismatch'));
      }
    }
  }

  const jobNames = Object.values(workflowTexts).flatMap(workflowJobNames);
  const duplicates = new Set(jobNames.filter((name, index) => jobNames.indexOf(name) !== index));
  for (const name of duplicates) {
    findings.push(finding('.github/workflows', null, 'duplicate_job_name', name));
  }
  for (const context of contexts ?? REQUIRED_MAIN_CHECKS) {
    if (!jobNames.includes(context)) {
      findings.push(finding('.github/workflows', null, 'required_check_missing', context));
    }
  }

  return findings;
}

export interface RulesetResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

export function scanMainRuleset(root: string): RulesetResult {
  const tracked = new Set(trackedEntries(root).map((entry) => entry.path));
  const requiredFiles = [RULESET_PATH, ...WORKFLOW_PATHS];
  const missing = requiredFiles.filter((file) => !tracked.has(file));
  if (missing.length > 0) {
    return {
      scanned: requiredFiles.length - missing.length,
      findings: missing.map((file) => finding(file, null, 'required_file_missing')),
    };
  }
  const workflows = Object.fromEntries(
    WORKFLOW_PATHS.map((file) => [file, readTracked(root, file).toString('utf8')]),
  );
  return {
    scanned: requiredFiles.length,
    findings: scanMainRulesetText(readTracked(root, RULESET_PATH).toString('utf8'), workflows),
  };
}

if (isMain(import.meta.url)) {
  const result = scanMainRuleset(repositoryRoot());
  process.exitCode = conclude('rulesets', result.scanned, result.findings);
}
