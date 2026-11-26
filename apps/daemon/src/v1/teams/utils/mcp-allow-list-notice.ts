/** The transcript sentence for allowed account connectors a turn goes without. */
export function unreachableConnectorsNotice(names: readonly string[]): string {
  const one = names.length === 1;
  return `${names.join(', ')} ${one ? 'stays' : 'stay'} off in this member’s turns although ${one ? 'it is' : 'they are'} on its list of MCP servers: an account connector is allowed by its address, and no listing of the CLI’s gave one for ${one ? 'it' : 'them'}. Check that ${one ? 'it is' : 'they are'} still connected in the CLI’s /mcp.`;
}
