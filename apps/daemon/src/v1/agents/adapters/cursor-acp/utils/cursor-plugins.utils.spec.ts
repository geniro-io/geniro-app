import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CURSOR_PLUGIN_TEXT_MAX_CHARS } from '../cursor-acp.const';
import {
  describeCursorPlugins,
  parsePluginVariables,
  parseProjectPluginStates,
  readCursorPlugins,
} from './cursor-plugins.utils';

const dirs: string[] = [];

function realDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-plugins-')));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

/** A cached marketplace plugin version, complete unless told otherwise. */
function cachedPlugin(
  home: string,
  name: string,
  version: string,
  files: Record<string, unknown>,
  complete = true,
): string {
  const dir = join(home, 'plugins', 'cache', 'cursor-public', name, version);
  for (const [path, content] of Object.entries(files)) {
    write(join(dir, path), content);
  }
  if (complete) {
    write(join(dir, '.cache-complete'), '');
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('parsePluginVariables', () => {
  it('lists declared variables with their schema facts, and never a secret', () => {
    expect(
      parsePluginVariables({
        properties: {
          DD_MCP_DOMAIN: {
            title: 'Datadog Domain',
            description: 'Your site',
            enum: ['mcp.datadoghq.com', 'mcp.datadoghq.eu'],
          },
          TOOLSETS: { default: 'core' },
          DD_API_KEY: {},
          PASSWORDLESS_HINT: {},
          REGION: { writeOnly: true },
          ZONE: { format: 'password' },
          MY_PAT: {},
        },
        required: ['DD_MCP_DOMAIN'],
      }),
    ).toEqual([
      {
        name: 'DD_MCP_DOMAIN',
        title: 'Datadog Domain',
        description: 'Your site',
        options: ['mcp.datadoghq.com', 'mcp.datadoghq.eu'],
        required: true,
        defaultValue: null,
      },
      {
        name: 'TOOLSETS',
        title: null,
        description: null,
        options: null,
        required: false,
        defaultValue: 'core',
      },
    ]);
  });
});

describe('parseProjectPluginStates', () => {
  it('reads each plugin the project switches on or off, and nothing it does not mention', () => {
    const states = parseProjectPluginStates(
      '{"plugins":{"datadog":{"enabled":true},"linear":{"enabled":false},"odd":{}}}',
    );
    expect([...states]).toEqual([
      ['datadog', true],
      ['linear', false],
    ]);
    expect(parseProjectPluginStates('not json').size).toBe(0);
  });
});

describe('readCursorPlugins', () => {
  it('reads a pointer manifest and an inline one, with the folder’s enablement', async () => {
    const home = realDir();
    const project = realDir();
    const datadog = cachedPlugin(home, 'datadog', 'sha1', {
      '.cursor-plugin/plugin.json': {
        name: 'datadog',
        mcpServers: './.dd_cursor_mcp.json',
        variables: {
          properties: { DD_MCP_DOMAIN: {} },
          required: ['DD_MCP_DOMAIN'],
        },
      },
      '.dd_cursor_mcp.json': {
        mcpServers: { datadog: { url: 'https://x/v1/mcp' } },
      },
    });
    cachedPlugin(home, 'linear', 'sha2', {
      '.cursor-plugin/plugin.json': {
        name: 'linear',
        mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } },
      },
    });
    write(join(project, '.cursor', 'settings.json'), {
      plugins: { datadog: { enabled: true } },
    });

    const plugins = await readCursorPlugins(home, project);

    expect(
      plugins.map((p) => [p.name, p.enabledHere, p.servers.at(0)?.name]),
    ).toEqual([
      ['datadog', true, 'datadog'],
      ['linear', null, 'linear'],
    ]);
    expect(plugins.at(0)?.dir).toBe(datadog);
    expect(plugins.at(0)?.variables.map((v) => v.name)).toEqual([
      'DD_MCP_DOMAIN',
    ]);
  });

  it('skips a version that never finished caching, and takes the newest complete one', async () => {
    const home = realDir();
    const manifest = (url: string) => ({
      '.cursor-plugin/plugin.json': { name: 'p', mcpServers: { s: { url } } },
    });
    cachedPlugin(home, 'p', 'partial', manifest('https://partial'), false);
    cachedPlugin(home, 'p', 'old', manifest('https://old'));
    const fresh = cachedPlugin(home, 'p', 'new', manifest('https://new'));
    const old = join(home, 'plugins', 'cache', 'cursor-public', 'p', 'old');
    utimesSync(join(old, '.cache-complete'), new Date(1000), new Date(1000));

    const [plugin] = await readCursorPlugins(home, realDir());

    expect(plugin?.dir).toBe(fresh);
    expect(plugin?.servers.at(0)?.config).toEqual({ url: 'https://new' });
  });

  it('reads a local plugin through a symlink, but lets a marketplace install of that name win', async () => {
    const home = realDir();
    const checkout = realDir();
    write(join(checkout, 'plugin.json'), {
      name: 'mine',
      mcpServers: { srv: { command: 'node' } },
    });
    mkdirSync(join(home, 'plugins', 'local'), { recursive: true });
    symlinkSync(checkout, join(home, 'plugins', 'local', 'mine'));
    const shadowed = realDir();
    write(join(shadowed, 'plugin.json'), {
      name: 'linear',
      mcpServers: { linear: { url: 'https://local' } },
    });
    symlinkSync(shadowed, join(home, 'plugins', 'local', 'linear'));
    cachedPlugin(home, 'linear', 'sha', {
      'plugin.json': {
        name: 'linear',
        mcpServers: { linear: { url: 'https://cache' } },
      },
    });

    const plugins = await readCursorPlugins(home, realDir());

    expect(plugins.map((p) => [p.name, p.servers.at(0)?.config])).toEqual([
      ['linear', { url: 'https://cache' }],
      ['mine', { command: 'node' }],
    ]);
  });

  it('ignores a pointer that leaves the plugin, a garbled manifest and a plugin with no servers', async () => {
    const home = realDir();
    write(join(home, 'secret.json'), {
      mcpServers: { leaked: { url: 'https://x' } },
    });
    cachedPlugin(home, 'escape', 'v', {
      'plugin.json': {
        name: 'escape',
        mcpServers: '../../../../../secret.json',
      },
    });
    cachedPlugin(home, 'garbled', 'v', { 'plugin.json': '{not json' });
    cachedPlugin(home, 'skills-only', 'v', {
      'plugin.json': { name: 'skills-only' },
    });
    // The positive control: a well-formed plugin beside them IS read, so the
    // empty answer above is the guards and not a reader that finds nothing.
    cachedPlugin(home, 'ok', 'v', {
      'plugin.json': { name: 'ok', mcpServers: { s: { url: 'https://ok' } } },
    });

    const plugins = await readCursorPlugins(home, realDir());

    expect(plugins.map((p) => p.name)).toEqual(['ok']);
  });

  it('reads the plugin’s own .mcp.json, with the manifest’s servers winning by name', async () => {
    // A Claude-format plugin names no file in its manifest; the CLI still reads
    // `.mcp.json` and `mcp.json` from the plugin directory, in that order.
    const home = realDir();
    cachedPlugin(home, 'claude-style', 'v', {
      '.claude-plugin/plugin.json': {
        name: 'claude-style',
        mcpServers: { shared: { url: 'https://manifest' } },
      },
      '.mcp.json': {
        mcpServers: {
          shared: { url: 'https://dot-file' },
          own: { url: 'https://own' },
        },
      },
      'mcp.json': { mcpServers: { own: { url: 'https://shadowed' } } },
    });

    const [plugin] = await readCursorPlugins(home, realDir());

    expect(
      Object.fromEntries(
        (plugin?.servers ?? []).map((server) => [server.name, server.config]),
      ),
    ).toEqual({
      shared: { url: 'https://manifest' },
      own: { url: 'https://own' },
    });
  });

  it('will not follow a symlink inside the plugin to a file outside it', async () => {
    const home = realDir();
    const outside = realDir();
    write(join(outside, 'private.json'), {
      mcpServers: { leaked: { url: 'https://x' } },
    });
    const dir = cachedPlugin(home, 'linker', 'v', {
      'plugin.json': { name: 'linker', mcpServers: './x.json' },
    });
    symlinkSync(join(outside, 'private.json'), join(dir, 'x.json'));

    await expect(readCursorPlugins(home, realDir())).resolves.toEqual([]);
  });

  it('offers a variable the servers use but the manifest never declared — never a secret', async () => {
    const home = realDir();
    cachedPlugin(home, 'undeclared', 'v', {
      'plugin.json': {
        name: 'undeclared',
        mcpServers: {
          s: {
            url: 'https://${HOST}/mcp',
            headers: { Authorization: '${AUTH_HEADER}' },
          },
        },
      },
    });

    const [plugin] = await readCursorPlugins(home, realDir());

    expect(plugin?.variables).toEqual([
      {
        name: 'HOST',
        title: null,
        description: null,
        options: null,
        required: false,
        defaultValue: null,
      },
    ]);
  });

  it('reads none of a plugin’s own files through a symlink that leaves it, nor an oversized one', async () => {
    const home = realDir();
    const outside = realDir();
    write(join(outside, 'private.json'), {
      mcpServers: { leaked: { url: 'https://x' } },
    });
    const linked = cachedPlugin(home, 'linked', 'v', {
      'plugin.json': { name: 'linked' },
    });
    symlinkSync(join(outside, 'private.json'), join(linked, '.mcp.json'));
    cachedPlugin(home, 'huge', 'v', {
      'plugin.json': {
        name: 'huge',
        pad: 'x'.repeat(300 * 1024),
        mcpServers: { s: { url: 'https://h' } },
      },
    });
    // The positive control: an ordinary plugin beside them is read.
    cachedPlugin(home, 'ok', 'v', {
      'plugin.json': { name: 'ok', mcpServers: { s: { url: 'https://ok' } } },
    });

    const plugins = await readCursorPlugins(home, realDir());

    expect(plugins.map((p) => p.name)).toEqual(['ok']);
  });

  it('reads enablement from the chat’s own folder before the project root', async () => {
    const home = realDir();
    const project = realDir();
    mkdirSync(join(project, '.git'));
    const sub = join(project, 'apps', 'web');
    cachedPlugin(home, 'p', 'v', {
      'plugin.json': { name: 'p', mcpServers: { s: { url: 'https://p' } } },
    });
    write(join(project, '.cursor', 'settings.json'), {
      plugins: { p: { enabled: true } },
    });

    expect((await readCursorPlugins(home, sub)).at(0)?.enabledHere).toBe(true);

    write(join(sub, '.cursor', 'settings.json'), {
      plugins: { p: { enabled: false } },
    });
    expect((await readCursorPlugins(home, sub)).at(0)?.enabledHere).toBe(false);
  });

  it('reads no variable out of, and matches no entry against, a string past the length it reads', async () => {
    const home = realDir();
    const long = '${'.repeat(CURSOR_PLUGIN_TEXT_MAX_CHARS + 1);
    cachedPlugin(home, 'long', 'v', {
      'plugin.json': {
        name: 'long',
        mcpServers: { s: { url: long, headers: { 'X-Long': long } } },
      },
    });

    const plugins = await readCursorPlugins(home, realDir());

    expect(plugins.at(0)?.variables).toEqual([]);
    expect(
      describeCursorPlugins(plugins, { other: { url: long } })
        .at(0)
        ?.servers.at(0)?.copiedAs,
    ).toBeNull();
  });

  it('answers nothing for a machine with no plugins directory', async () => {
    await expect(readCursorPlugins(realDir(), realDir())).resolves.toEqual([]);
  });
});

describe('describeCursorPlugins', () => {
  const plugin = {
    name: 'datadog',
    dir: '/p',
    enabledHere: true,
    variables: [
      {
        name: 'D',
        title: null,
        description: null,
        options: ['mcp.datadoghq.com', 'mcp.datadoghq.eu'],
        required: true,
        defaultValue: null,
      },
    ],
    servers: [
      { name: 'datadog', config: { url: 'https://${D:-not-setup}/v1/mcp' } },
    ],
  };

  it('names the entry already carrying a server — by URL first, then by name', () => {
    const [byUrl] = describeCursorPlugins([plugin], {
      'my-dd': { url: 'https://mcp.datadoghq.com/v1/mcp' },
    });
    expect(byUrl?.servers.at(0)).toEqual({
      name: 'datadog',
      id: 'plugin-datadog-datadog',
      transport: 'http',
      target: 'https://${D:-not-setup}/v1/mcp',
      copiedAs: 'my-dd',
    });
    const [byName] = describeCursorPlugins([plugin], {
      datadog: { url: 'https://elsewhere/mcp' },
    });
    expect(byName?.servers.at(0)?.copiedAs).toBe('datadog');
  });

  it('prefers the URL match over a same-named entry', () => {
    const [both] = describeCursorPlugins([plugin], {
      datadog: { url: 'https://elsewhere/mcp' },
      'my-dd': { url: 'https://mcp.datadoghq.com/v1/mcp' },
    });
    expect(both?.servers.at(0)?.copiedAs).toBe('my-dd');
  });

  it('claims no URL on a host its variable does not pin down', () => {
    // `${HOST}` declares no values, so the commonest MCP path would otherwise
    // mark any server on it as this plugin's copy.
    const [free] = describeCursorPlugins(
      [
        {
          ...plugin,
          name: 'free',
          variables: [{ ...plugin.variables[0]!, name: 'HOST', options: null }],
          servers: [{ name: 'free', config: { url: 'https://${HOST}/mcp' } }],
        },
      ],
      { linear: { url: 'https://mcp.linear.app/mcp' } },
    );
    expect(free?.servers.at(0)?.copiedAs).toBeNull();
  });

  it('marks nothing copied when no entry matches', () => {
    const [none] = describeCursorPlugins([plugin], {
      datadog_engineer: {
        url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      },
    });
    expect(none?.servers.at(0)?.copiedAs).toBeNull();
  });
});
