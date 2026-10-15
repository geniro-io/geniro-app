/**
 * The header the LAN gateway stamps on every request it proxies from a paired
 * device, after dropping any value the device sent itself.
 *
 * TWIN PARSER: `REMOTE_VIA_HEADER` in `apps/ui/src/main/remote/daemon-proxy.ts`,
 * which sets it. The daemon cannot tell a proxied request any other way: the
 * gateway connects over loopback with the launch token, exactly like the
 * desktop renderer.
 */
export const REMOTE_VIA_HEADER = 'x-geniro-via';
export const REMOTE_VIA_VALUE = 'remote';

export function cameViaRemote(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const value = headers[REMOTE_VIA_HEADER];
  return Array.isArray(value)
    ? value.includes(REMOTE_VIA_VALUE)
    : value === REMOTE_VIA_VALUE;
}
