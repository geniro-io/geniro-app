import {
  CircleArrowUp,
  CircleCheck,
  Download,
  GitCompareArrows,
  KeyRound,
  Link2,
} from 'lucide-react';
import { useContext, useEffect } from 'react';

import type { CliDetection, ConfigProfile } from '../../shared/contracts';
import { agentDisplayName, AgentIdentityContext } from '../agent-identity';
import { type SignedOutAccount, signedOutAccountRows } from '../cli-sign-ins';
import { AppUpdateActions } from '../components/app-update-actions';
import { CliLoginProgress } from '../components/cli-login-progress';
import { ErrorText } from '../components/error-text';
import { SignInAction } from '../components/sign-in-action';
import { Button } from '../components/ui/button';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { isRemoteRuntime } from '../remote/remote-session';
import {
  cliUpdatesAvailable,
  useCliAttention,
} from '../settings/use-cli-attention';
import type { CliUpdatesController } from '../settings/use-cli-updates';
import { updateStatusText } from '../updates/update-status';
import {
  type UpdateController,
  useUpdateState,
} from '../updates/use-update-state';
import {
  type CliLoginController,
  isLoginOver,
  useCliLogin,
} from '../use-cli-login';
import { NoticeCard } from './notice-card';
import {
  appUpdateWaits,
  configDirName,
  ON_SHARES,
  readMemoryFindings,
  readWaitingShares,
  type ShareWait,
  shareWaitsByPlace,
  useCardDismissal,
  useConfigProfiles,
} from './settings-attention';
import { ON_MEMORY, useWaitingSet } from './use-waiting-items';

const SLOT = 'settings-attention';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Rows({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
      {children}
    </ul>
  );
}

function Row({
  slot,
  text,
  action,
  children,
}: {
  slot: string;
  text: string;
  action: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      data-slot={slot}
      className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-3 [&>button]:shrink-0">
        <span className="min-w-0 flex-1 text-sm break-words">{text}</span>
        {action}
      </div>
      {children}
    </li>
  );
}

export function AgentUpdatesCard({
  rows,
  updates,
  nameOf,
}: {
  rows: readonly CliDetection[];
  updates: CliUpdatesController;
  nameOf: (kind: string) => string;
}): React.JSX.Element {
  const dismissal = useCardDismissal(
    'agent-updates',
    rows.map(
      (detection) =>
        `${detection.kind}@${detection.update.latestVersion ?? ''}`,
    ),
  );
  return (
    <NoticeCard
      slot={SLOT}
      kind="agent-updates"
      icon={CircleArrowUp}
      label="Update available"
      heading={plural(rows.length, 'agent', 'agents')}
      dismissal={dismissal}>
      <Rows>
        {rows.map((detection) => {
          const running = updates.updating.has(detection.kind);
          const result = updates.results[detection.kind];
          const versions =
            detection.update.latestVersion === null
              ? (detection.version ?? '')
              : `${detection.version ?? '?'} → ${detection.update.latestVersion}`;
          return (
            <Row
              key={detection.kind}
              slot="settings-attention-update"
              text={`${nameOf(detection.kind)} ${versions}`.trim()}
              action={
                <Button
                  type="button"
                  variant="update"
                  size="sm"
                  disabled={running}
                  title={`Install the newer version of ${nameOf(detection.kind)}, as Settings does`}
                  onClick={() => void updates.update(detection.kind)}>
                  {running ? 'Updating…' : 'Update'}
                </Button>
              }>
              {result !== undefined && !result.ok && !running ? (
                <ErrorText>
                  {result.output ?? 'The update did not finish.'}
                </ErrorText>
              ) : null}
            </Row>
          );
        })}
      </Rows>
    </NoticeCard>
  );
}

export function AgentSignInCard({
  rows,
  login,
  nameOf,
  profiles,
}: {
  rows: readonly SignedOutAccount[];
  login: CliLoginController;
  nameOf: (kind: string) => string;
  profiles: readonly ConfigProfile[];
}): React.JSX.Element {
  const dismissal = useCardDismissal(
    'agent-sign-in',
    rows.map((row) => `${row.kind}:${row.configDir ?? ''}`),
  );
  const busy =
    login.starting !== null ||
    (login.login !== null && !isLoginOver(login.login.session));
  const dismissable =
    rows.length > 0 && login.starting === null && login.login === null;
  return (
    <NoticeCard
      slot={SLOT}
      kind="agent-sign-in"
      icon={KeyRound}
      label="Sign-in needed"
      heading={plural(rows.length, 'account', 'accounts')}
      settled={rows.length === 0}
      settledIcon={CircleCheck}
      settledLabel="Signed in"
      dismissal={dismissable ? dismissal : undefined}>
      {rows.length === 0 ? null : (
        <Rows>
          {rows.map((row) => {
            const name = nameOf(row.kind);
            const text =
              row.configDir === null
                ? name
                : `${name} · ${configDirName(row.configDir, profiles)}`;
            const starting =
              login.starting?.kind === row.kind &&
              login.starting.server === null &&
              login.starting.configDir === row.configDir;
            return (
              <Row
                key={`${row.kind}:${row.configDir ?? ''}`}
                slot="settings-attention-sign-in"
                text={text}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title={`Sign ${text} in again, here, as Settings does`}
                    onClick={() => void login.start(row.kind, row.configDir)}>
                    {starting ? 'Signing in…' : 'Sign in'}
                  </Button>
                }
              />
            );
          })}
        </Rows>
      )}
      {login.login === null ? null : (
        <CliLoginProgress
          variant="inline"
          session={login.login.session}
          error={login.error}
          onSubmitCode={(code) => void login.submitCode(code)}
          onCancel={() => void login.cancel()}
          onDismiss={login.dismiss}
        />
      )}
    </NoticeCard>
  );
}

export function AppUpdateCard({
  update,
  remote,
}: {
  update: UpdateController;
  remote: boolean;
}): React.JSX.Element | null {
  const state = update.state;
  const dismissal = useCardDismissal(
    'app-update',
    state === null ? [] : [state.version ?? ''],
  );
  if (state === null) {
    return null;
  }
  return (
    <NoticeCard
      slot={SLOT}
      kind="app-update"
      icon={Download}
      label="Update available"
      heading="Geniro"
      dismissal={dismissal}>
      <div className="flex min-w-0 items-center gap-3 [&>button]:shrink-0">
        <p
          data-slot="settings-attention-app-update"
          className="m-0 min-w-0 flex-1 text-sm break-words">
          {updateStatusText(state)}
        </p>
        {remote ? null : <AppUpdateActions update={update} />}
      </div>
      {remote ? (
        <p className="m-0 text-xs text-muted-foreground">
          Install it on the Mac.
        </p>
      ) : null}
    </NoticeCard>
  );
}

export function ShareSignInCard({
  wait,
  api,
}: {
  wait: ShareWait;
  api: DaemonApis['shares'];
}): React.JSX.Element {
  const dismissal = useCardDismissal(
    `share-sign-in:${wait.destinationId}`,
    wait.shareIds,
  );
  return (
    <NoticeCard
      slot={SLOT}
      kind="share-sign-in"
      icon={Link2}
      label="Waiting for sign-in"
      heading={wait.label}
      dismissal={dismissal}>
      <p
        data-slot="settings-attention-share-count"
        className="m-0 text-sm break-words">
        {plural(wait.count, 'shared link waits', 'shared links wait')} to be
        uploaded. {wait.reason}.
      </p>
      <SignInAction
        api={api}
        destinationId={wait.destinationId}
        label={wait.label}
        className="self-start"
      />
    </NoticeCard>
  );
}

export function MemoryConflictsCard({
  findingIds,
  onOpen,
}: {
  findingIds: readonly string[];
  onOpen: (() => void) | null;
}): React.JSX.Element {
  const count = findingIds.length;
  const dismissal = useCardDismissal('memory-conflicts', findingIds);
  return (
    <NoticeCard
      slot={SLOT}
      kind="memory-conflicts"
      icon={GitCompareArrows}
      label="Waiting for your decision"
      heading={plural(count, 'memory conflict', 'memory conflicts')}
      dismissal={dismissal}>
      <p
        data-slot="settings-attention-conflicts"
        className="m-0 text-sm break-words">
        {count === 1
          ? '1 pair of memory entries repeats or contradicts itself.'
          : `${count} pairs of memory entries repeat or contradict each other.`}
      </p>
      {onOpen === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          Decide them in Settings → Memory → Clean up.
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          title="Open Settings → Memory → Clean up on its Conflicts tab"
          onClick={onOpen}>
          Review conflicts
        </Button>
      )}
    </NoticeCard>
  );
}

/**
 * What waits on the user in Settings, drawn at the foot of the manager's chat
 * while it waits, from the same live readings Settings draws: agent updates,
 * signed-out agent accounts, a Geniro update, shares waiting on a sign-in and
 * memory conflicts. Nothing here is a transcript row, so a card goes once its
 * reason does, wherever it was settled.
 */
export function SettingsAttentionCards({
  apis,
  client,
  active,
  onOpenMemoryConflicts,
  remote = isRemoteRuntime(),
}: {
  apis: DaemonApis;
  client: DaemonClient | null;
  active: boolean;
  onOpenMemoryConflicts: (() => void) | null;
  remote?: boolean;
}): React.JSX.Element | null {
  const identities = useContext(AgentIdentityContext);
  const nameOf = (kind: string): string => agentDisplayName(identities, kind);
  const cli = useCliAttention();
  const { refresh } = cli;
  useEffect(() => {
    if (active) {
      refresh(false);
    }
  }, [active, refresh]);
  const login = useCliLogin(apis, () => refresh(true));
  const update = useUpdateState();
  const profiles = useConfigProfiles();
  const shares = useWaitingSet(
    apis,
    client,
    active && !remote,
    readWaitingShares,
    ON_SHARES,
  );
  const findings = useWaitingSet(
    apis,
    client,
    active,
    readMemoryFindings,
    ON_MEMORY,
  );

  const updateRows = cliUpdatesAvailable(cli.detections ?? []);
  const signInRows = (cli.detections ?? []).flatMap(signedOutAccountRows);
  const shareWaits =
    shares.items === null ? [] : shareWaitsByPlace(shares.items.values());
  const conflictIds = findings.items === null ? [] : [...findings.items.keys()];
  const showSignIn = signInRows.length > 0 || login.login !== null;
  const showAppUpdate = appUpdateWaits(update.state);

  if (
    updateRows.length === 0 &&
    !showSignIn &&
    !showAppUpdate &&
    shareWaits.length === 0 &&
    conflictIds.length === 0
  ) {
    return null;
  }
  return (
    <div data-slot={SLOT} className="flex min-w-0 flex-col gap-2.5">
      {showAppUpdate ? <AppUpdateCard update={update} remote={remote} /> : null}
      {updateRows.length === 0 ? null : (
        <AgentUpdatesCard
          rows={updateRows}
          updates={cli.updates}
          nameOf={nameOf}
        />
      )}
      {showSignIn ? (
        <AgentSignInCard
          rows={signInRows}
          login={login}
          nameOf={nameOf}
          profiles={profiles}
        />
      ) : null}
      {shareWaits.map((wait) => (
        <ShareSignInCard
          key={wait.destinationId}
          wait={wait}
          api={apis.shares}
        />
      ))}
      {conflictIds.length === 0 ? null : (
        <MemoryConflictsCard
          findingIds={conflictIds}
          onOpen={onOpenMemoryConflicts}
        />
      )}
    </div>
  );
}
