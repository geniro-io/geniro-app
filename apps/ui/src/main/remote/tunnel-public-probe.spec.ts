import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPublicProbe,
  isGatewaySessionAnswer,
  type PublicProbeDeps,
  reachesGateway,
  tunnelZone,
} from './tunnel-public-probe';

function deps(overrides: Partial<PublicProbeDeps> = {}) {
  return {
    zoneNameservers: vi.fn<PublicProbeDeps['zoneNameservers']>(async () => [
      '173.245.58.193',
    ]),
    answersAsAuthority: vi.fn<PublicProbeDeps['answersAsAuthority']>(
      async () => true,
    ),
    resolveAt: vi.fn<PublicProbeDeps['resolveAt']>(async () => ({
      addresses: ['104.16.230.132', '104.16.231.132'],
    })),
    reachesGateway: vi.fn<PublicProbeDeps['reachesGateway']>(
      async () => 'answers',
    ),
    ...overrides,
  };
}

const URL_A = 'https://late-name.trycloudflare.com';

describe('tunnelZone', () => {
  it('drops the leading label and refuses a host with too few labels', () => {
    expect(tunnelZone(URL_A)).toBe('trycloudflare.com');
    expect(tunnelZone('https://a.b.example.com')).toBe('b.example.com');
    expect(tunnelZone('https://evil.app')).toBeNull();
    expect(tunnelZone('not a url')).toBeNull();
  });
});

describe('isGatewaySessionAnswer', () => {
  it("accepts only the gateway's session shape", () => {
    expect(isGatewaySessionAnswer('{"paired":false,"deviceId":null}')).toBe(
      true,
    );
    expect(isGatewaySessionAnswer('{"paired":true,"deviceId":"d1"}')).toBe(
      true,
    );
    expect(isGatewaySessionAnswer('error code: 1033')).toBe(false);
    expect(isGatewaySessionAnswer('{"paired":"no","deviceId":null}')).toBe(
      false,
    );
    expect(isGatewaySessionAnswer('{"paired":false}')).toBe(false);
    expect(isGatewaySessionAnswer('null')).toBe(false);
  });
});

describe('createPublicProbe', () => {
  it("asks the zone's own nameservers for the name and requests the gateway at their answer", async () => {
    const d = deps();
    expect(await createPublicProbe(d)(URL_A)).toBe('answers');

    expect(d.zoneNameservers).toHaveBeenCalledWith('trycloudflare.com');
    expect(d.answersAsAuthority).toHaveBeenCalledWith(['173.245.58.193']);
    expect(d.resolveAt).toHaveBeenCalledWith(
      ['173.245.58.193'],
      'late-name.trycloudflare.com',
    );
    expect(d.reachesGateway).toHaveBeenCalledWith(
      'late-name.trycloudflare.com',
      '104.16.230.132',
    );
  });

  it('never asks for the new name where a resolver on the way answers for the zone, and asks that only once', async () => {
    const d = deps({ answersAsAuthority: vi.fn(async () => false) });
    const probe = createPublicProbe(d);

    expect(await probe(URL_A)).toBe('cannot-check');
    expect(await probe(URL_A)).toBe('cannot-check');
    expect(d.resolveAt).not.toHaveBeenCalled();
    expect(d.reachesGateway).not.toHaveBeenCalled();
    expect(d.answersAsAuthority).toHaveBeenCalledTimes(1);
  });

  it('asks again whether the nameservers are the real ones after they could not be reached', async () => {
    const answersAsAuthority = vi
      .fn<PublicProbeDeps['answersAsAuthority']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(true);
    const d = deps({ answersAsAuthority });
    const probe = createPublicProbe(d);

    expect(await probe(URL_A)).toBe('cannot-check');
    expect(d.resolveAt).not.toHaveBeenCalled();
    expect(await probe(URL_A)).toBe('answers');
    expect(answersAsAuthority).toHaveBeenCalledTimes(2);
  });

  it('says not yet while the name is not in DNS, without requesting the address', async () => {
    const d = deps({ resolveAt: vi.fn(async () => 'missing' as const) });
    expect(await createPublicProbe(d)(URL_A)).toBe('not-yet');
    expect(d.reachesGateway).not.toHaveBeenCalled();
  });

  it('says it cannot check when the nameservers stop answering', async () => {
    const d = deps({ resolveAt: vi.fn(async () => 'unreachable' as const) });
    expect(await createPublicProbe(d)(URL_A)).toBe('cannot-check');
  });

  it('takes the edge answering with something else as not yet', async () => {
    const d = deps({ reachesGateway: vi.fn(async () => 'not-yet' as const) });
    expect(await createPublicProbe(d)(URL_A)).toBe('not-yet');
    expect(d.reachesGateway).toHaveBeenCalledTimes(1);
  });

  it('tries the next address when this Mac cannot reach the first, and no more than two', async () => {
    const reachesGateway = vi
      .fn<PublicProbeDeps['reachesGateway']>()
      .mockResolvedValueOnce('cannot-check')
      .mockResolvedValueOnce('answers');
    expect(await createPublicProbe(deps({ reachesGateway }))(URL_A)).toBe(
      'answers',
    );
    expect(reachesGateway).toHaveBeenLastCalledWith(
      'late-name.trycloudflare.com',
      '104.16.231.132',
    );

    const never = vi.fn(async () => 'cannot-check' as const);
    const three = deps({
      resolveAt: vi.fn(async () => ({
        addresses: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
      })),
      reachesGateway: never,
    });
    expect(await createPublicProbe(three)(URL_A)).toBe('cannot-check');
    expect(never).toHaveBeenCalledTimes(2);
  });

  it('reads the nameservers once, and again after a read that found none', async () => {
    const zoneNameservers = vi
      .fn<PublicProbeDeps['zoneNameservers']>()
      .mockRejectedValueOnce(new Error('ETIMEOUT'))
      .mockResolvedValue(['173.245.58.193']);
    const d = deps({ zoneNameservers });
    const probe = createPublicProbe(d);

    expect(await probe(URL_A)).toBe('cannot-check');
    expect(d.resolveAt).not.toHaveBeenCalled();
    expect(await probe(URL_A)).toBe('answers');
    expect(await probe(URL_A)).toBe('answers');
    expect(zoneNameservers).toHaveBeenCalledTimes(2);
  });

  it('cannot check an address with no zone of its own, asking nothing', async () => {
    const d = deps();
    expect(await createPublicProbe(d)('https://evil.app')).toBe('cannot-check');
    expect(d.zoneNameservers).not.toHaveBeenCalled();
  });

  it('says it cannot check rather than throwing when a lookup or the request throws', async () => {
    const d = deps({
      resolveAt: vi.fn(async () => {
        throw new Error('ESERVFAIL');
      }),
    });
    expect(await createPublicProbe(d)(URL_A)).toBe('cannot-check');
    const e = deps({
      reachesGateway: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    expect(await createPublicProbe(e)(URL_A)).toBe('cannot-check');
  });
});

describe('reachesGateway', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function stand(answer: (res: ServerResponse) => void) {
    const seen: { host?: string; path?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url });
      answer(res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    return { port: (server.address() as AddressInfo).port, seen };
  }

  // `.invalid` never resolves, so an answer at all proves the connection went
  // to the pinned address and the name was never looked up.
  const HOST = 'late-name.invalid';

  it("connects to the pinned address with the tunnel's host and counts the gateway's session answer", async () => {
    const s = await stand((res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"paired":false,"deviceId":null}');
    });

    expect(
      await reachesGateway(HOST, '127.0.0.1', { request, port: s.port }),
    ).toBe('answers');
    expect(s.seen).toEqual([
      { host: `${HOST}:${String(s.port)}`, path: '/__geniro/session' },
    ]);
  });

  it('answers no for an edge error page, a non-gateway 200 and an oversized answer', async () => {
    const edge = await stand((res) => {
      res.statusCode = 530;
      res.end('{"paired":false,"deviceId":null}');
    });
    const other = await stand((res) => {
      res.end('<html>error code: 1033</html>');
    });
    const huge = await stand((res) => {
      res.end(`{"paired":false,"deviceId":null,"pad":"${'x'.repeat(10_000)}"}`);
    });

    for (const s of [edge, other, huge]) {
      expect(
        await reachesGateway(HOST, '127.0.0.1', { request, port: s.port }),
      ).toBe('not-yet');
    }
  });

  it('says it cannot check when the connection fails below HTTP', async () => {
    const s = await stand((res) => res.end());
    await closers.pop()?.();

    expect(
      await reachesGateway(HOST, '127.0.0.1', { request, port: s.port }),
    ).toBe('cannot-check');
  });
});
