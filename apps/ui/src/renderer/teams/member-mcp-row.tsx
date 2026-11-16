import { type ComponentProps, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { McpDialogButton } from '../components/mcp-dialog-button';
import { NoteBox } from '../components/note-box';
import { SettingRow } from '../components/setting-row';
import { withNodeSwitches } from './node-mcp-switches';
import type { NodeMcpState } from './use-node-mcp';

type DialogActions = Pick<
  ComponentProps<typeof McpDialogButton>,
  | 'onSetEnabled'
  | 'onSignIn'
  | 'signingIn'
  | 'loginServer'
  | 'loginPanel'
  | 'configActions'
>;

/**
 * A member's MCP row: the servers its profile loads with its own switches laid
 * over them, or the daemon's refusal of its config directory. Rows stay
 * read-only unless the caller passes `onSetEnabled`.
 */
export function MemberMcpRow({
  title,
  mcp,
  mcpDisabled,
  hint,
  configDir,
  configDirUnavailableReason,
  ...actions
}: {
  title: string;
  mcp: NodeMcpState;
  mcpDisabled: readonly string[] | undefined;
  hint: string;
  configDir: string | null;
  configDirUnavailableReason: string | null | undefined;
} & DialogActions): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      {mcp.invalidConfigDir === null ? (
        <div className="@container flex flex-col rounded-card bg-card ring-1 ring-border">
          <SettingRow width="compact" label="MCP">
            <McpDialogButton
              variant="chip"
              chipNamesItself={false}
              title={title}
              open={open}
              onOpenChange={setOpen}
              listing={withNodeSwitches(mcp.listing, mcpDisabled)}
              loading={mcp.loading}
              hint={hint}
              onRefresh={mcp.refresh}
              {...actions}
            />
          </SettingRow>
        </div>
      ) : (
        <ErrorText id="member-config-dir-error" className="text-xs break-words">
          {mcp.invalidConfigDir}
        </ErrorText>
      )}
      {configDir && configDirUnavailableReason ? (
        <NoteBox aria-label="Config directory" className="text-xs">
          <span className="block">{configDirUnavailableReason}</span>
          <span className="block text-warning">
            This member names {configDir}, which will be ignored when it runs.
          </span>
        </NoteBox>
      ) : null}
    </>
  );
}
