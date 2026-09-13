import { describe, expect, it } from 'vitest';

import { codeSpan, escapeMarkdown, inertInline } from './safety/markdown.js';
import { classifySourceReference, REFERENCE_REJECTIONS } from './safety/reference.js';
import { hasControlCharacter, quoteEvidence, toSingleLine } from './safety/text.js';
import {
  ACCEPTED_REFERENCES,
  activeMarkdownConstructs,
  hasRawControl,
  HOSTILE,
  UNSAFE_REFERENCES,
} from './test-support.js';

/**
 * The inert renderer and the source reference policy, value by value. The
 * tool-level tests then prove the same properties through the MCP boundary.
 */

const char = (code: number): string => String.fromCodePoint(code);

describe('quoted evidence', () => {
  it('shows bidirectional controls and invisible formatting characters as visible escapes', () => {
    const points = [
      0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061,
      0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
    ];
    for (const point of points) {
      const value = `a${char(point)}b`;
      expect(hasControlCharacter(value), point.toString(16)).toBe(true);
      const shown = toSingleLine(value);
      expect(shown).toBe(`a\\u${point.toString(16).padStart(4, '0')}b`);
      expect(hasRawControl(shown)).toBe(false);
    }
    // Joiners used by ordinary text are left alone.
    for (const point of [0x200c, 0x200d]) {
      expect(hasControlCharacter(`a${char(point)}b`)).toBe(false);
    }
    const quoted = quoteEvidence(HOSTILE.bidi, 300);
    expect(quoted?.text).toContain('\\u202e');
    expect(quoted?.text).toContain('\\u2066');
    expect(quoted?.text).toContain('\\u200b');
    expect(quoted?.text).toContain('\\ufeff');
    expect(hasRawControl(quoted?.text ?? '')).toBe(false);
  });
});

describe('inert Markdown', () => {
  it('escapes every Markdown-active punctuation character and nothing else', () => {
    const active = '\\`*_[]()<>#!|~^$=:@.&{}';
    for (const character of active) {
      expect(escapeMarkdown(character), JSON.stringify(character)).toBe(`\\${character}`);
    }
    const inert = 'a,b;c?d%e/f-g+h\'i"j k';
    expect(escapeMarkdown(inert)).toBe(inert);
  });

  it('renders each hostile value with no active construct left', () => {
    const cases: [string, string][] = [
      ['image', HOSTILE.markdownImage],
      ['link', HOSTILE.markdownLink],
      ['html', HOSTILE.html],
      ['fence', HOSTILE.fence],
      ['heading', HOSTILE.heading],
      ['emphasis', HOSTILE.emphasis],
      ['entity', HOSTILE.entity],
      ['autolink', HOSTILE.autolink],
      ['role message', HOSTILE.roleMessage],
      ['tool call', HOSTILE.toolCall],
      ['exfil', HOSTILE.exfil],
      ['bidi', HOSTILE.bidi],
      ['tag', HOSTILE.tag],
      ['ansi', HOSTILE.ansi],
      ['newline', HOSTILE.newline],
      ['separator', HOSTILE.separator],
    ];
    for (const [name, value] of cases) {
      const rendered = inertInline(value, 300) ?? '';
      // Placed where the drafter places it: inside bold, after a phrase, in a list item.
      const preview = `**${rendered}**\nReportedly: ${rendered}\n- ${rendered} — ${rendered}`;
      expect(activeMarkdownConstructs(preview), name).toEqual([]);
      expect(hasRawControl(rendered), name).toBe(false);
      expect(rendered, name).not.toContain('<');
      expect(rendered, name).not.toContain('>');
    }
    expect(inertInline(HOSTILE.markdownImage, 300)).toContain(
      '\\!\\[tracking pixel\\]\\(https\\://',
    );
    expect(inertInline(HOSTILE.fence, 300)).toContain('\\`\\`\\`bash\\\\n');
    expect(inertInline(HOSTILE.entity, 300)).toContain('\\&\\#x3C;');
    expect(inertInline(HOSTILE.autolink, 300)).toContain('www\\.evil\\.seed\\.example\\.com');
    expect(inertInline(HOSTILE.tag, 300)).toContain('\\\\u003csystem\\\\u003e');
    expect(inertInline(HOSTILE.bidi, 300)).toContain('\\\\u202e');
    expect(inertInline(null, 300)).toBeNull();
    expect(inertInline('', 300)).toBe('');
  });

  it('bounds the display copy before escaping, so the marker is itself escaped', () => {
    const rendered = inertInline('*'.repeat(400), 300) ?? '';
    expect(rendered.startsWith('\\*'.repeat(300))).toBe(true);
    expect(rendered.endsWith('…\\[+100 chars\\]')).toBe(true);
  });

  it('wraps a reference in a code span longer than any backtick run inside it', () => {
    expect(codeSpan('https://seed.example.com/a')).toBe('`https://seed.example.com/a`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('a``b`c')).toBe('```a``b`c```');
    expect(codeSpan('`lead')).toBe('`` `lead ``');
    expect(codeSpan('trail`')).toBe('`` trail` ``');
    expect(codeSpan(' padded ')).toBe('`  padded  `');
    expect(codeSpan('')).toBe('` `');
    expect(codeSpan('   ')).toBe('`   `');
    for (const value of ['x`y', '``', 'a```b', '`']) {
      const span = codeSpan(value);
      // The span is one construct: removing it as the renderer would leaves nothing active.
      expect(activeMarkdownConstructs(`- pub — ${span}`)).toEqual([]);
    }
  });
});

describe('the source reference policy', () => {
  it('withholds every unsafe form with its fixed reason', () => {
    for (const [url, reason] of UNSAFE_REFERENCES) {
      const verdict = classifySourceReference(url);
      expect(verdict, url).toEqual({ status: 'rejected', reason });
      expect((REFERENCE_REJECTIONS as readonly string[]).includes(reason)).toBe(true);
    }
  });

  it('accepts public http and https references and nothing else', () => {
    for (const url of ACCEPTED_REFERENCES) {
      expect(classifySourceReference(url), url).toEqual({ status: 'accepted' });
    }
  });

  it('classifies the whole IPv4 special-purpose registry and its IPv6 embeddings', () => {
    const cases: [string, string][] = [
      ['0.1.2.3', 'reserved_address'],
      ['10.255.255.255', 'private_address'],
      ['100.127.0.1', 'private_address'],
      ['100.128.0.1', 'accepted'],
      ['127.255.255.255', 'loopback_address'],
      ['169.254.0.1', 'link_local_address'],
      ['172.15.0.1', 'accepted'],
      ['172.16.0.1', 'private_address'],
      ['172.31.255.255', 'private_address'],
      ['172.32.0.1', 'accepted'],
      ['192.0.0.1', 'reserved_address'],
      ['192.0.2.255', 'reserved_address'],
      ['192.88.99.1', 'reserved_address'],
      ['192.168.0.1', 'private_address'],
      ['198.18.0.1', 'reserved_address'],
      ['198.19.255.255', 'reserved_address'],
      ['198.20.0.1', 'accepted'],
      ['198.51.100.1', 'reserved_address'],
      ['203.0.113.1', 'reserved_address'],
      ['223.255.255.255', 'accepted'],
      ['224.0.0.1', 'multicast_address'],
      ['239.255.255.255', 'multicast_address'],
      ['240.0.0.1', 'reserved_address'],
      ['255.255.255.255', 'reserved_address'],
      ['[::ffff:10.0.0.1]', 'private_address'],
      ['[::ffff:a00:1]', 'private_address'],
      ['[64:ff9b::a00:1]', 'private_address'],
      ['[64:ff9b:1::1]', 'private_address'],
      ['[::2]', 'reserved_address'],
      ['[fe80::]', 'link_local_address'],
      ['[febf::1]', 'link_local_address'],
      ['[fec0::1]', 'private_address'],
      ['[fdff::1]', 'private_address'],
      ['[ff00::1]', 'multicast_address'],
      ['[2001:db8:ffff::1]', 'reserved_address'],
      ['[2001:1ff::1]', 'reserved_address'],
      ['[2001:200::1]', 'accepted'],
      ['[2002::1]', 'reserved_address'],
      ['[3fff::1]', 'reserved_address'],
      ['[5f00::1]', 'reserved_address'],
      ['[100::1]', 'reserved_address'],
      ['[2606:4700::1111]', 'accepted'],
    ];
    for (const [host, expected] of cases) {
      const verdict = classifySourceReference(`https://${host}/x`);
      const actual = verdict.status === 'accepted' ? 'accepted' : verdict.reason;
      expect(actual, host).toBe(expected);
    }
  });

  it('never fetches: the module imports no network, filesystem or resolver capability', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const source = await readFile(
      fileURLToPath(new URL('./safety/reference.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(|node:dns|node:net|node:https?|readFile|\.lookup\s*\(/);
  });
});
