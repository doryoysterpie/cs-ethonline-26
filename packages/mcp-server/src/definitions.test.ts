import { describe, expect, it } from 'vitest';

import {
  EXPECTED_CATALOGUE_SHA256,
  LIST_INCIDENTS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  assertCatalogueIntegrity,
  catalogueSha256,
  toolCatalogue,
  type CatalogueEntry,
} from './definitions.js';
import { SERVER_INSTRUCTIONS } from './server.js';
import { connectInMemory, FakeStore } from './test-support.js';

/**
 * The catalogue is static application code. These tests pin it: its digest,
 * its size, its strictness, its annotations, and the fact that the wire
 * advertises exactly what the module declares.
 */

function assertNoAdditionalProperties(schema: unknown, path: string): void {
  if (typeof schema !== 'object' || schema === null) return;
  const record = schema as Record<string, unknown>;
  if (record['type'] === 'object') {
    expect(record['additionalProperties'], `${path} must refuse additional properties`).toBe(false);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        assertNoAdditionalProperties(child, `${path}.${name}`);
      }
    } else if (key === 'items') {
      assertNoAdditionalProperties(value, `${path}[]`);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      value.forEach((child, index) => assertNoAdditionalProperties(child, `${path}|${index}`));
    }
  }
}

describe('the static tool catalogue', () => {
  it('declares exactly four tools with fixed names', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toEqual([
      'list_incidents',
      'explain_incident',
      'chain_anomalies',
      'draft_section',
    ]);
  });

  it('matches its pinned digest, and starts only then', () => {
    expect(catalogueSha256()).toBe(EXPECTED_CATALOGUE_SHA256);
    expect(() => assertCatalogueIntegrity()).not.toThrow();
  });

  it('changes digest under any mutation of a name, description, annotation or schema', () => {
    const base = toolCatalogue();
    const mutate = (fn: (entry: CatalogueEntry) => CatalogueEntry): string =>
      catalogueSha256(base.map((entry, index) => (index === 0 ? fn(entry) : entry)));
    expect(mutate((e) => ({ ...e, description: `${e.description} ` }))).not.toBe(
      EXPECTED_CATALOGUE_SHA256,
    );
    expect(mutate((e) => ({ ...e, name: 'list_incidents_v2' }))).not.toBe(
      EXPECTED_CATALOGUE_SHA256,
    );
    expect(
      mutate((e) => ({ ...e, annotations: { ...e.annotations, readOnlyHint: false } })),
    ).not.toBe(EXPECTED_CATALOGUE_SHA256);
    expect(
      mutate((e) => ({ ...e, inputSchema: { ...e.inputSchema, additionalProperties: true } })),
    ).not.toBe(EXPECTED_CATALOGUE_SHA256);
    expect(mutate((e) => ({ ...e, outputSchema: { ...e.outputSchema, extra: true } }))).not.toBe(
      EXPECTED_CATALOGUE_SHA256,
    );
    // Adding a fifth tool is a mutation too.
    expect(catalogueSha256([...base, { ...base[0]!, name: 'drop_everything' }])).not.toBe(
      EXPECTED_CATALOGUE_SHA256,
    );
  });

  it('is frozen: a definition cannot be changed in place', () => {
    expect(Object.isFrozen(LIST_INCIDENTS)).toBe(true);
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
    expect(() => {
      (LIST_INCIDENTS as { description: string }).description = 'poisoned';
    }).toThrow(TypeError);
    expect(() => {
      (TOOL_DEFINITIONS as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('marks every tool read-only, non-destructive and idempotent', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.idempotentHint).toBe(true);
    }
    // Only the tool that may reach a provider is open-world.
    expect(TOOL_DEFINITIONS.map((tool) => tool.annotations.openWorldHint)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('advertises strict input and output schemas with no additional properties anywhere', () => {
    for (const entry of toolCatalogue()) {
      assertNoAdditionalProperties(entry.inputSchema, `${entry.name}.input`);
      assertNoAdditionalProperties(entry.outputSchema, `${entry.name}.output`);
      expect(entry.inputSchema['type']).toBe('object');
      expect(entry.outputSchema['type']).toBe('object');
    }
  });

  it('takes no free-text argument: every input property is a pattern, an enumeration or a bounded integer', () => {
    for (const entry of toolCatalogue()) {
      const properties = entry.inputSchema['properties'] as Record<string, Record<string, unknown>>;
      for (const [name, property] of Object.entries(properties)) {
        const constrained =
          property['pattern'] !== undefined ||
          property['enum'] !== undefined ||
          (property['type'] === 'integer' &&
            property['minimum'] !== undefined &&
            property['maximum'] !== undefined);
        expect(constrained, `${entry.name}.${name} must be constrained`).toBe(true);
      }
    }
  });

  it('describes without instructing: no description or instruction tells the model to act', () => {
    const forbidden = [
      /ignore (previous|prior|all) /i,
      /you must (call|invoke|run)/i,
      /then (call|invoke) /i,
      /always (call|invoke) /i,
      /disregard/i,
      /<system>/i,
      /<important>/i,
    ];
    const texts = [
      ...TOOL_DEFINITIONS.flatMap((tool) => [tool.title, tool.description]),
      SERVER_INSTRUCTIONS,
    ];
    for (const text of texts) {
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${text.slice(0, 40)} must not match ${String(pattern)}`).toBe(
          false,
        );
      }
    }
  });
});

describe('the catalogue on the wire', () => {
  it('lists exactly the declared tools, hashing to the pinned digest', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      const entries: CatalogueEntry[] = listed.tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? '',
        description: tool.description ?? '',
        annotations: Object.fromEntries(
          Object.entries(tool.annotations ?? {}).filter(
            (pair): pair is [string, boolean] => typeof pair[1] === 'boolean',
          ),
        ),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        outputSchema: (tool.outputSchema ?? {}) as Record<string, unknown>,
      }));
      expect(catalogueSha256(entries)).toBe(EXPECTED_CATALOGUE_SHA256);
      // Listing twice yields the same order and content.
      const again = await harness.client.listTools();
      expect(again.tools.map((tool) => tool.name)).toEqual(listed.tools.map((tool) => tool.name));
    } finally {
      await harness.close();
    }
  });

  it('declares only the tools capability and refuses resources and prompts', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const capabilities = harness.client.getServerCapabilities();
      expect(capabilities?.tools).toBeDefined();
      expect(capabilities?.resources).toBeUndefined();
      expect(capabilities?.prompts).toBeUndefined();
      expect(capabilities?.logging).toBeUndefined();
      expect(harness.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      // Without the capability the SDK answers these with nothing or refuses them; either way nothing is served.
      const resources = await harness.client.listResources().catch(() => ({ resources: [] }));
      expect(resources.resources).toEqual([]);
      const prompts = await harness.client.listPrompts().catch(() => ({ prompts: [] }));
      expect(prompts.prompts).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('answers an undeclared tool with an error and touches nothing', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      for (const name of ['drop_everything', 'list_incidents ', 'LIST_INCIDENTS', '']) {
        let failed = false;
        try {
          const result = await harness.client.callTool({ name, arguments: {} });
          failed = result.isError === true;
        } catch {
          failed = true;
        }
        expect(failed, `${JSON.stringify(name)} must be refused`).toBe(true);
      }
      expect(store.calls).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
