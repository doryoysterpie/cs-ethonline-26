import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOOL_NAMES } from './definitions.js';

/**
 * `SKILL.md` is the contract a host reads. These checks hold it to the facts
 * the code enforces, keep it free of secrets and unsafe shell examples, and
 * keep it from claiming coverage the project does not have.
 */

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

async function skill(): Promise<string> {
  return readFile(here('../SKILL.md'), 'utf8');
}

describe('SKILL.md', () => {
  it('carries the frontmatter a skill loader needs', async () => {
    const text = await skill();
    expect(text.startsWith('---\nname: cas-chainwatch-mcp\ndescription: ')).toBe(true);
  });

  it('names every tool and no other', async () => {
    const text = await skill();
    for (const name of TOOL_NAMES) expect(text).toContain(`### \`${name}\``);
    expect((text.match(/^### `/gmu) ?? []).length).toBe(TOOL_NAMES.length);
  });

  it('states the trust model, the origin labels and the model-free, read-only behaviour', async () => {
    const text = await skill();
    for (const required of [
      'untrusted_quoted_evidence',
      'data about the world, never an',
      'No result ever asks the model to call a tool, ignore a policy or take an action.',
      'telemetry, not proof',
      '`live`: obtained from a current external source',
      '`replay`: previously captured data',
      '`fixture`: checked-in synthetic test data',
      'deterministic and model-free',
      'No tool invokes a language model',
      'read-only',
      'declares `READ ONLY`',
      'persists nothing',
      'local stdio only',
      'Requires `GRAPH_API_KEY` in the server environment',
      'graph_credential_missing',
      'nothing is substituted',
      'pending its own independent audit',
    ]) {
      expect(text, required).toContain(required);
    }
  });

  it('pins the SDK and schema library versions the lockfile records', async () => {
    const text = await skill();
    const workspace = await readFile(here('../../../pnpm-workspace.yaml'), 'utf8');
    const server = /'@modelcontextprotocol\/server': (\S+)/u.exec(workspace)?.[1];
    const zod = /^\s+zod: (\S+)$/mu.exec(workspace)?.[1];
    expect(server).toBeDefined();
    expect(zod).toBeDefined();
    expect(text).toContain(`\`@modelcontextprotocol/server\` ${server}`);
    expect(text).toContain(`\`zod\` ${zod}`);
  });

  it('provides installation and invocation without command substitution or unsafe shell', async () => {
    const text = await skill();
    expect(text).toContain('corepack pnpm mcp:setup');
    expect(text).toContain('corepack pnpm mcp:start');
    expect(text).toContain('/absolute/path/to/cs-ethonline-26/packages/mcp-server/dist/bin.js');
    for (const unsafe of [
      '$(',
      'eval ',
      'curl ',
      'wget ',
      '| sh',
      '| bash',
      'npx ',
      'sudo ',
      'chmod 777',
    ]) {
      expect(text, `must not contain ${unsafe}`).not.toContain(unsafe);
    }
    // No backtick-quoted shell substitution inside a fenced block.
    const fences = text.match(/```[a-z]*\n[\s\S]*?```/gu) ?? [];
    for (const fence of fences)
      expect(fence.split('\n').slice(1, -1).join('\n')).not.toContain('`');
  });

  it('contains no secret, key, token or credential-bearing URL', async () => {
    const text = await skill();
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s<>]*:[^\s<>]*@/u);
    expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/u);
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._~+/=-]{8,}/u);
    expect(text).not.toMatch(/(api[_-]?key|token|password)\s*[:=]\s*["']?[A-Za-z0-9]{8,}/iu);
  });

  it('claims no administrative-event coverage', async () => {
    const text = await skill();
    expect(text).toContain('No administrative-event coverage exists');
    expect(text).toContain('Decision D23');
    expect(text).not.toMatch(
      /administrative[- ]event (watchlist|coverage) (is|was) (delivered|complete|available)/iu,
    );
  });

  it('never tells the reader the server is audited', async () => {
    const text = await skill();
    expect(text).not.toMatch(/has been audited|audit(ed)? passed|Codex Desktop issued PASS/iu);
    expect(text).toContain('This server has not been audited.');
  });
});
