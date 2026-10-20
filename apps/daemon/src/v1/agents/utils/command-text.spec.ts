import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { maskedCommand } from './command-text';

afterEach(() => clearSecrets());

describe('maskedCommand', () => {
  it('masks every assignment value and every registered secret, keeping the names', () => {
    registerSecret('s3cr3t-token-value', 'a test token');
    const masked = maskedCommand(
      // As `ps` lists a shell wrapper: the quotes are gone.
      'bash -c GITHUB_TOKEN=ghp_abc123 PORT=3000 pnpm dev --auth s3cr3t-token-value',
    );
    expect(masked).toContain('GITHUB_TOKEN=… PORT=… pnpm dev --auth ');
    expect(masked).not.toContain('ghp_abc123');
    expect(masked).not.toContain('s3cr3t-token-value');
  });
});
