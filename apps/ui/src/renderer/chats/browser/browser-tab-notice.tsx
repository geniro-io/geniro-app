import { KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import type {
  BrowserAuthRequest,
  BrowserTabError,
} from '../../../shared/contracts';
import { EmptyState } from '../../components/empty-state';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

/** A page that did not load. A certificate error is the user's call alone. */
export function BrowserLoadFailed({
  error,
  onContinueInsecure,
  onReload,
}: {
  error: BrowserTabError;
  onContinueInsecure: () => void;
  onReload: () => void;
}): React.JSX.Element {
  return (
    <EmptyState
      data-slot="browser-load-failed"
      icon={error.certificate ? <ShieldAlert /> : <TriangleAlert />}
      actions={
        error.certificate ? (
          <Button type="button" variant="outline" onClick={onContinueInsecure}>
            Continue anyway
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onReload}>
            Try again
          </Button>
        )
      }>
      <span className="block font-medium text-foreground">
        {error.certificate
          ? 'This connection is not private'
          : 'This page did not load'}
      </span>
      <span className="block break-all">{error.url}</span>
      <span className="block">{error.description}</span>
    </EmptyState>
  );
}

/** A page's basic-auth challenge: only the user answers it. */
export function BrowserAuthPrompt({
  request,
  onAnswer,
}: {
  request: BrowserAuthRequest;
  onAnswer: (
    credentials: { username: string; password: string } | null,
  ) => void;
}): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      data-slot="browser-auth-prompt"
      className="mx-auto flex max-w-xs flex-col gap-3 px-4 py-8"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ username, password });
      }}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">
          {request.host} asks you to sign in
        </span>
      </div>
      {request.realm === '' ? null : (
        <p className="text-xs break-words text-muted-foreground">
          {request.realm}
        </p>
      )}
      <Input
        aria-label="Username"
        autoFocus
        autoComplete="off"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <Input
        aria-label="Password"
        type="password"
        autoComplete="off"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onAnswer(null)}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Sign in
        </Button>
      </div>
    </form>
  );
}
