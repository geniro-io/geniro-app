import * as React from 'react';

import { PAIRING_CODE_LENGTH } from '../../shared/remote';
import { submitPairingCode } from '../remote/remote-session';
import { ErrorText } from './error-text';
import { Button } from './ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';

export interface PairingScreenProps {
  /** Fires once the gateway accepts the code — the caller re-renders into the app. */
  onPaired: () => void;
}

/** Keeps only digits, and never more of them than the code carries. */
function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH);
}

/** A lockout's `retryAfterMs`, in whole minutes rounded up — the reader is deciding when to come back, not counting seconds. */
function formatRetryAfter(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The gate a phone's browser sees before anything else in the app — there is
 * no preload bridge to have already let it in, so it has to ask for the code
 * Settings is showing on the Mac.
 *
 * Single column, no fixed pixel widths: this is the first screen a phone
 * ever renders, not a desktop dialog resized down as an afterthought.
 */
export function PairingScreen({
  onPaired,
}: PairingScreenProps): React.JSX.Element {
  const [code, setCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const complete = code.length === PAIRING_CODE_LENGTH;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!complete || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    void submitPairingCode(code).then((result) => {
      setSubmitting(false);
      if (result.ok) {
        onPaired();
        return;
      }
      // The server's own wording for a wrong code or a lockout — never
      // rewritten here, since only the gateway knows which refusal this is
      // and how many attempts remain. `retryAfterMs` is set only on a
      // lockout, so the screen can say WHEN to try again instead of leaving
      // that invisible.
      setError(
        result.retryAfterMs === undefined
          ? result.message
          : `${result.message} Try again in ${formatRetryAfter(result.retryAfterMs)}.`,
      );
    });
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Pair this device</CardTitle>
          <CardDescription>
            Enter the {PAIRING_CODE_LENGTH}-digit code shown in Geniro&rsquo;s
            Settings on your Mac.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pairing-code">Pairing code</Label>
              <Input
                id="pairing-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder={'•'.repeat(PAIRING_CODE_LENGTH)}
                value={code}
                disabled={submitting}
                onChange={(event) => {
                  setCode(sanitizeCode(event.target.value));
                  setError(null);
                }}
                className="h-14 text-center text-2xl tracking-[0.5em]"
              />
            </div>
            {error ? <ErrorText>{error}</ErrorText> : null}
            <Button
              type="submit"
              size="lg"
              disabled={!complete || submitting}
              className="w-full">
              {submitting ? (
                <>
                  <Spinner className="text-primary-foreground" />
                  Pairing…
                </>
              ) : (
                'Pair this device'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
