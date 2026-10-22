/**
 * robots.txt, obeyed per the owner's decision O-2 (D36): the file is read once
 * per host per reading under the same rules as a page, and the product's
 * token (`LatestInCyber`) or the `*` group decides, by RFC 9309 longest-match,
 * whether a path may be fetched. A disallowed source is listed as not read.
 */
export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export interface RobotsRules {
  readonly groups: readonly RobotsGroup[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const comment = rawLine.indexOf('#');
    const line = (comment < 0 ? rawLine : rawLine.slice(0, comment)).trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return { groups };
}

/** RFC 9309 path matching: a literal prefix, `*` for any run of characters, `$` for the end. */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern.length === 0) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  let position = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (index === 0) {
      if (!path.startsWith(part)) return false;
      position = part.length;
      continue;
    }
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  if (anchored) return parts.length > 1 ? position === path.length : path === body;
  return true;
}

function groupFor(rules: RobotsRules, token: string): RobotsGroup | null {
  const wanted = token.toLowerCase();
  return (
    rules.groups.find((group) => group.agents.includes(wanted)) ??
    rules.groups.find((group) => group.agents.includes('*')) ??
    null
  );
}

/** Whether the token may fetch the path: the longest matching rule decides, allow winning a tie. */
export function robotsAllows(rules: RobotsRules, token: string, path: string): boolean {
  const group = groupFor(rules, token);
  if (group === null) return true;
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}
