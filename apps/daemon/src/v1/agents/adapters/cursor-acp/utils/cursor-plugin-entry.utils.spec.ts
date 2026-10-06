import { describe, expect, it } from 'vitest';

import {
  CURSOR_PLUGIN_TEXT_MAX_CHARS,
  CURSOR_VARIABLE_PATTERN_SOURCE,
} from '../cursor-acp.const';
import {
  buildPluginServerEntry,
  pluginServerTarget,
  pluginVariableValues,
  referencedVariables,
  scanVariables,
  substituteVariables,
  templateHostMatches,
  templateMatches,
} from './cursor-plugin-entry.utils';

// The datadog plugin's own server config, verbatim from its 0.7.19 cache.
const DATADOG = {
  url: 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp',
  headers: {
    DD_API_KEY: '${DD_API_KEY}',
    DD_APPLICATION_KEY: '${DD_APPLICATION_KEY}',
    'X-Datadog-MCP-Referrer-Name': 'cursor-plugin',
    'X-Datadog-MCP-Referrer-Version': '0.7.19',
    'X-Datadog-MCP-Toolsets': '${DD_MCP_TOOLSETS:-core,visualizations}',
  },
};

describe('scanVariables', () => {
  // Strings over the characters the CLI's pattern turns on, from a fixed seed
  // so a failure names the same input every run.
  const samples = (): string[] => {
    const alphabet = [
      '$',
      '{',
      '}',
      ':',
      '-',
      'e',
      'n',
      'v',
      'A',
      '_',
      '1',
      '/',
    ];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    return Array.from({ length: 5000 }, () =>
      Array.from(
        { length: next() % 24 },
        () => alphabet[next() % alphabet.length],
      ).join(''),
    );
  };

  it('finds exactly what the CLI’s own pattern matches', () => {
    for (const text of samples()) {
      const expected = [
        ...text.matchAll(new RegExp(CURSOR_VARIABLE_PATTERN_SOURCE, 'g')),
      ].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        env: match[1] ?? null,
        name: match[2] ?? null,
        fallback: match[3] ?? null,
      }));
      expect(scanVariables(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('stays linear on the run of `${` the pattern backtracks on', () => {
    const text = '${a:b'.repeat(200_000);
    const started = Date.now();
    expect(scanVariables(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('substituteVariables', () => {
  it('fills a value, falls back to a default, and names what has neither', () => {
    expect(substituteVariables('${A}/${B:-b}/${C}', { A: 'a' })).toEqual({
      text: 'a/b/${C}',
      unresolved: ['C'],
      env: [],
    });
  });

  it('treats an empty value as absent, so a default still applies', () => {
    expect(substituteVariables('${A:-d}', { A: '' }).text).toBe('d');
  });

  it('never fills a variable from the object prototype', () => {
    expect(substituteVariables('${constructor}', {})).toEqual({
      text: '${constructor}',
      unresolved: ['constructor'],
      env: [],
    });
  });

  it('leaves ${env:NAME} for the CLI to read from its own environment', () => {
    expect(substituteVariables('${env:TOKEN}', { TOKEN: 'x' })).toEqual({
      text: '${env:TOKEN}',
      unresolved: [],
      env: ['TOKEN'],
    });
  });
});

describe('buildPluginServerEntry', () => {
  it('builds the datadog entry: domain filled, key headers dropped, defaults kept', () => {
    expect(
      buildPluginServerEntry(DATADOG, { DD_MCP_DOMAIN: 'mcp.datadoghq.eu' }),
    ).toEqual({
      ok: true,
      entry: {
        url: 'https://mcp.datadoghq.eu/v1/mcp',
        headers: {
          'X-Datadog-MCP-Referrer-Name': 'cursor-plugin',
          'X-Datadog-MCP-Referrer-Version': '0.7.19',
          'X-Datadog-MCP-Toolsets': 'core,visualizations',
        },
      },
    });
  });

  it('keeps a header whose variable WAS supplied — the drop is for unset ones only', () => {
    const built = buildPluginServerEntry(DATADOG, {
      DD_MCP_DOMAIN: 'mcp.datadoghq.com',
      DD_API_KEY: 'k',
    });
    expect(built.ok && built.entry.headers).toMatchObject({ DD_API_KEY: 'k' });
  });

  it('refuses a URL that still needs a variable', () => {
    expect(buildPluginServerEntry({ url: 'https://${HOST}/mcp' }, {})).toEqual({
      ok: false,
      reason: 'this server needs HOST, which has no value',
    });
  });

  it('refuses a command or argument that still needs one, and fills the plugin root', () => {
    expect(
      buildPluginServerEntry(
        {
          command: '${CURSOR_PLUGIN_ROOT}/bin/run',
          args: ['--port', '${PORT}'],
        },
        { CURSOR_PLUGIN_ROOT: '/p' },
      ),
    ).toEqual({
      ok: false,
      reason: 'this server needs PORT, which has no value',
    });
    expect(
      buildPluginServerEntry(
        { command: '${CURSOR_PLUGIN_ROOT}/bin/run', env: { TOKEN: '${T}' } },
        { CURSOR_PLUGIN_ROOT: '/p' },
      ),
    ).toEqual({ ok: true, entry: { command: '/p/bin/run' } });
  });
});

describe('buildPluginServerEntry — every field, and what it will not carry', () => {
  it('fills a variable wherever the config uses it, nested fields included', () => {
    expect(
      buildPluginServerEntry(
        {
          command: 'run',
          cwd: '${CURSOR_PLUGIN_ROOT}',
          auth: { region: '${R}' },
        },
        { CURSOR_PLUGIN_ROOT: '/p', R: 'eu' },
      ),
    ).toEqual({
      ok: true,
      entry: { command: 'run', cwd: '/p', auth: { region: 'eu' } },
    });
    expect(
      buildPluginServerEntry({ command: 'run', cwd: '${MISSING}' }, {}),
    ).toEqual({
      ok: false,
      reason: 'this server needs MISSING, which has no value',
    });
  });

  it('leaves out every header that reads the CLI’s environment, whatever the variable is called', () => {
    // A name list cannot tell DB_PASS from a harmless setting, and a header
    // goes to the plugin's own host.
    expect(
      buildPluginServerEntry(
        {
          url: 'https://x',
          headers: {
            Authorization: 'Bearer ${env:GITHUB_TOKEN}',
            'X-Db': '${env:DB_PASS}',
            'X-Region': '${env:REGION}',
            'X-Fixed': 'plain',
          },
        },
        {},
      ),
    ).toEqual({
      ok: true,
      entry: { url: 'https://x', headers: { 'X-Fixed': 'plain' } },
    });
  });

  it('keeps a non-secret environment read that only feeds the local process', () => {
    expect(
      buildPluginServerEntry(
        {
          command: 'run',
          args: ['--region', '${env:REGION}'],
          env: { REGION: '${env:REGION}', TOKEN: '${env:API_TOKEN}' },
        },
        {},
      ),
    ).toEqual({
      ok: true,
      entry: {
        command: 'run',
        args: ['--region', '${env:REGION}'],
        env: { REGION: '${env:REGION}' },
      },
    });
  });

  it('reads a secret out of a default as well, which only the filled text shows', () => {
    // `${A:-${env:TOKEN}}` fills to `${env:TOKEN}` when A has no value.
    expect(
      buildPluginServerEntry(
        {
          url: 'https://x',
          headers: { Authorization: 'Bearer ${A:-${env:GITHUB_TOKEN}}' },
        },
        {},
      ),
    ).toEqual({ ok: true, entry: { url: 'https://x' } });
  });

  it('refuses an argument that reads a secret, and a URL that reads the environment at all', () => {
    expect(
      buildPluginServerEntry(
        { command: 'run', args: ['--token', '${env:GITHUB_TOKEN}'] },
        {},
      ),
    ).toEqual({
      ok: false,
      reason:
        'this server reads GITHUB_TOKEN from your environment, and a copy carries no credential',
    });
    expect(
      buildPluginServerEntry({ url: 'https://x/?d=${env:DATABASE_URL}' }, {}),
    ).toEqual({
      ok: false,
      reason:
        'this server would send DATABASE_URL from your environment to its own host, and a copy carries no credential',
    });
  });

  it('leaves out a header too long to read', () => {
    expect(
      buildPluginServerEntry(
        {
          url: 'https://x',
          headers: {
            'X-Long': 'a'.repeat(CURSOR_PLUGIN_TEXT_MAX_CHARS + 1),
            'X-Short': 'b',
          },
        },
        {},
      ),
    ).toEqual({
      ok: true,
      entry: { url: 'https://x', headers: { 'X-Short': 'b' } },
    });
  });

  it('refuses a value too long to scan, at once', () => {
    const started = Date.now();
    expect(buildPluginServerEntry({ url: '${'.repeat(40_000) }, {})).toEqual({
      ok: false,
      reason: 'this server’s config holds a value too long to read',
    });
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('templateMatches', () => {
  it('matches a URL the template could have produced, and nothing else', () => {
    const template = 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp';
    expect(templateMatches(template, 'https://mcp.datadoghq.com/v1/mcp')).toBe(
      true,
    );
    expect(
      templateMatches(
        template,
        'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      ),
    ).toBe(false);
  });

  it('lets a variable stand for one host or segment, never a longer path', () => {
    const template = 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp';
    expect(templateMatches(template, 'https://mcp.datadoghq.com/v1/mcp')).toBe(
      true,
    );
    expect(templateMatches(template, 'https://other.example/x/v1/mcp')).toBe(
      false,
    );
  });

  it('identifies nothing from a template that is only variables', () => {
    expect(templateMatches('${URL}', 'https://anything/at/all')).toBe(false);
  });

  it('needs a character for every variable, adjacent ones included', () => {
    expect(templateMatches('https://${A}${B}/x', 'https://ab/x')).toBe(true);
    expect(templateMatches('https://${A}${B}/x', 'https://a/x')).toBe(false);
  });

  it('answers a template of many adjacent variables at once', () => {
    // A regex built from the template backtracks for seconds on this; the
    // scan must answer at once.
    const template = `https://${'${V}'.repeat(16)}/v1/mcp`;
    const started = Date.now();
    expect(templateMatches(template, `https://${'a'.repeat(40)}/v1/mcpX`)).toBe(
      false,
    );
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('keeps a middle literal to its own segment', () => {
    expect(
      templateMatches('https://${A}.x/${B}/mcp', 'https://a/b.x/c/mcp'),
    ).toBe(false);
    expect(
      templateMatches('https://${A}.x/${B}/mcp', 'https://a.x/c/mcp'),
    ).toBe(true);
  });

  it('matches nothing past the length it reads', () => {
    const long = `https://${'a'.repeat(CURSOR_PLUGIN_TEXT_MAX_CHARS)}/mcp`;
    expect(templateMatches('https://${A}/mcp', long)).toBe(false);
    expect(templateMatches(long, long)).toBe(false);
  });

  it('matches only itself when there are no variables', () => {
    expect(templateMatches('https://a.b/mcp', 'https://a.b/mcp')).toBe(true);
    expect(templateMatches('https://a.b/mcp', 'https://aXb/mcp')).toBe(false);
  });
});

describe('templateHostMatches', () => {
  const domain = {
    name: 'DD_MCP_DOMAIN',
    title: null,
    description: null,
    options: ['mcp.datadoghq.com', 'mcp.datadoghq.eu'],
    required: true,
    defaultValue: null,
  };

  it('accepts a host the template writes out, or one of its variable’s declared values', () => {
    expect(templateHostMatches('https://a.b/mcp', 'https://a.b/mcp', [])).toBe(
      true,
    );
    expect(
      templateHostMatches(DATADOG.url, 'https://mcp.datadoghq.eu/v1/mcp', [
        domain,
      ]),
    ).toBe(true);
    expect(
      templateHostMatches(DATADOG.url, 'https://evil.example/v1/mcp', [domain]),
    ).toBe(false);
  });

  it('claims no host for a variable that declares no values', () => {
    expect(
      templateHostMatches('https://${HOST}/mcp', 'https://mcp.linear.app/mcp', [
        { ...domain, name: 'HOST', options: null },
      ]),
    ).toBe(false);
    expect(
      templateHostMatches(
        'https://${HOST}/mcp',
        'https://mcp.linear.app/mcp',
        [],
      ),
    ).toBe(false);
  });
});

describe('pluginServerTarget', () => {
  it('reads a URL server as http unless it says sse, and a command as stdio', () => {
    expect(pluginServerTarget({ url: 'https://x' })).toEqual({
      transport: 'http',
      target: 'https://x',
    });
    expect(
      pluginServerTarget({ url: 'https://x', type: 'sse' }).transport,
    ).toBe('sse');
    expect(pluginServerTarget({ command: 'npx', args: ['srv'] })).toEqual({
      transport: 'stdio',
      target: 'npx srv',
    });
    expect(pluginServerTarget({})).toEqual({ transport: null, target: null });
  });
});

describe('pluginVariableValues', () => {
  const variable = (
    overrides: Partial<Parameters<typeof pluginVariableValues>[0][number]>,
  ) => ({
    name: 'HOST',
    title: null,
    description: null,
    options: null,
    required: false,
    defaultValue: null,
    ...overrides,
  });

  it('takes the manifest default for an empty value, and leaves an empty optional out', () => {
    expect(
      pluginVariableValues(
        [
          variable({
            name: 'HOST',
            required: true,
            defaultValue: 'mcp.example',
          }),
          variable({ name: 'TOOLSETS' }),
        ],
        { HOST: '  ', TOOLSETS: '' },
      ),
    ).toEqual({ ok: true, values: { HOST: 'mcp.example' } });
    // A declared name that is also an Object.prototype key is not "given".
    expect(
      pluginVariableValues(
        [variable({ name: 'toString', defaultValue: 'd' })],
        {},
      ),
    ).toEqual({ ok: true, values: { toString: 'd' } });
  });

  it('refuses a control character, a `${`, and a name the plugin never declared', () => {
    const declared = [variable({ name: 'HOST' })];
    expect(pluginVariableValues(declared, { HOST: 'a\nb' })).toEqual({
      ok: false,
      reason: 'HOST contains a control character',
    });
    expect(
      pluginVariableValues(declared, { HOST: 'x.${env:CURSOR_API_KEY}.evil' }),
    ).toEqual({ ok: false, reason: 'HOST cannot contain ${' });
    expect(pluginVariableValues(declared, { OTHER: 'x' })).toEqual({
      ok: false,
      reason: 'OTHER is not a variable this plugin asks for',
    });
  });
});

describe('referencedVariables — length', () => {
  it('reads no variable out of a string longer than it reads', () => {
    expect(
      referencedVariables({
        url: `https://\${LONG}/${'a'.repeat(CURSOR_PLUGIN_TEXT_MAX_CHARS)}`,
        headers: { 'X-Short': '${SHORT}' },
      }),
    ).toEqual(['SHORT']);
  });
});

describe('referencedVariables', () => {
  it('names every variable used without a default, anywhere in the config', () => {
    expect(
      referencedVariables({
        url: 'https://${HOST}/${PATH:-mcp}',
        args: ['--token', '${env:TOKEN}'],
        headers: { 'X-Region': '${REGION}' },
      }).sort(),
    ).toEqual(['HOST', 'REGION']);
  });
});
