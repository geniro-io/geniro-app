import { AgentVersionService } from '../agent-version.service';

/**
 * An {@link AgentVersionService} that reads no version: every CLI answers
 * `null`, "version unknown", which its callers already take as a cache key.
 *
 * For specs that need the service only as a dependency. The real one forks
 * `<cli> --version` on whatever is installed: nothing on CI, where the answer
 * is the same `null` at once, but `cursor-agent --version` takes ~1.7s on a
 * developer's Mac, longer under load, and a spec that builds a fresh service
 * per test paid it in every test. What the real one does is
 * `agent-version.service.spec.ts`'s to pin.
 */
export class UnknownAgentVersion extends AgentVersionService {
  override resolve(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
