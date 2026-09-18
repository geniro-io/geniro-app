import { FolderOpen, Loader2, LogIn, LogOut, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  type ConfigProfile,
  MAX_CONFIG_PROFILE_NAME,
  MAX_CONFIG_PROFILES,
  PROFILE_COLORS,
  type ProfileColor,
} from '../../shared/contracts';
import { shortenPath } from '../chats/directory-select';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { PALETTE_LABEL } from '../components/ui/palette';
import { PaletteDot } from '../components/ui/palette-dot';
import { Select } from '../components/ui/select';

/**
 * The user's named agent configurations, as a list they can keep in order.
 *
 * A config directory is the profile a CLI runs as — its credentials, its
 * plugins, its history — and until now the app could only ever point a run at
 * one BY PATH. A user with three accounts picked between
 * `/Users/x/.claude-work`, `/Users/x/.claude-personal` and `/Users/x/.claude-lab`
 * by reading their tails. This is where a directory gets a name in the user's
 * own words and a colour that makes it recognisable without reading at all.
 *
 * It is drawn INSIDE the claude card in Settings rather than as a section of
 * its own — asked for there ("should be in claude settings menu"), and it is
 * the same rule the browser-tools switch beside it already follows: whatever is
 * true of one CLI lives on that CLI's card, or a reader looking for what they
 * can change about claude finds half of it under a heading that names a topic.
 *
 * Every edit PERSISTS AT ONCE through `onChange` — there is no Save button and
 * no draft. The card it sits in says "Changes are saved automatically", and a
 * list of four fields is not a form worth a commit step. The NAME is the one
 * field that commits on blur rather than per keystroke, which is what keeps a
 * rename from writing settings.json once per letter.
 */
export function ConfigProfileList({
  profiles,
  onChange,
  onPickDirectory,
  onSignIn,
  onSignOut,
  signingIn = null,
  busy = false,
}: {
  profiles: readonly ConfigProfile[];
  /**
   * The whole list, after an edit. WHOLE rather than one entry, because adding,
   * removing and reordering are all edits to the list itself — a per-entry
   * callback would need three more beside it, and the caller writes one key
   * either way.
   */
  onChange: (next: ConfigProfile[]) => void;
  /**
   * Open the OS directory picker; resolves to null when the user cancels.
   *
   * The caller's, because it is an IPC round trip and this component is a
   * rendering of a list. Absent is not a case: a profile is a directory, so a
   * list that could not choose one would be unusable, and the caller always has
   * the channel.
   */
  onPickDirectory: () => Promise<string | null>;
  /**
   * Sign this configuration's ACCOUNT in, and out.
   *
   * A config directory is where claude keeps its credentials, so an account
   * lapses PER PROFILE — and until these existed the app's only sign-in was the
   * card's own, which passes no directory and therefore always reached the
   * default profile. A user whose second account expired could not repair it
   * from the app at all; the cure was a terminal with `CLAUDE_CONFIG_DIR` set.
   * That is the whole reason this pair is on the ROW rather than being a
   * profile picker beside one global Sign in button: the row already names the
   * account, so the control belongs to it.
   *
   * Omitted where the caller has no daemon to ask — the same rule
   * `AgentConfigList` follows, and it renders nothing rather than a control
   * that could only report its own inability.
   */
  onSignIn?: (dir: string) => void;
  onSignOut?: (dir: string) => void;
  /**
   * The profile whose sign-in has been ASKED for and not yet answered.
   *
   * The daemon holds that reply until the CLI prints its URL (measured at ~4s),
   * so without this the row sits unchanged while a browser tab opens behind the
   * window — the defect `CliLoginController.starting` exists to cover, reaching
   * one more surface.
   */
  signingIn?: string | null;
  /**
   * Whether ANY sign-in owns this card right now — the starting window above,
   * or a flow the progress panel is already showing.
   *
   * Separate from {@link signingIn} because the two answer different questions:
   * that one says which ROW to spin, this one says that no second sign-in may
   * begin. One sign-in runs at a time by design — two browser challenges are
   * indistinguishable once open, and the second invalidates the first — and a
   * sign-in to the DEFAULT profile carries a null directory, so `signingIn`
   * alone could never disable these rows during it.
   */
  busy?: boolean;
}): React.JSX.Element {
  // Which name field is being typed in, and what is in it. Held here rather
  // than in the persisted list so a half-typed name is never written: the row
  // reads from this while it is focused and from the profile otherwise.
  const [draftName, setDraftName] = useState<{
    id: string;
    value: string;
  } | null>(null);

  const replace = (id: string, patch: Partial<ConfigProfile>): void => {
    onChange(
      profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    );
  };

  /**
   * Whether some OTHER entry already stands for this directory.
   *
   * The DIRECTORY is the identity, so the same one twice would be two names for
   * one account with nothing able to say which a run was using. Both ways of
   * setting one go through this — adding a new entry and re-pointing an
   * existing one — because an invariant enforced on one of two paths is not an
   * invariant: the row's own directory button could otherwise be aimed at a
   * folder already in the list. `exceptId` is what lets a row be re-picked onto
   * the folder it is already on without refusing itself.
   *
   * Silently ignoring the pick is the right refusal here: the user chose a
   * folder that is already in the list, and the list is showing it.
   */
  const alreadyListed = (dir: string, exceptId?: string): boolean =>
    profiles.some((profile) => profile.dir === dir && profile.id !== exceptId);

  const add = async (): Promise<void> => {
    const dir = await onPickDirectory();
    if (dir === null || alreadyListed(dir)) {
      return;
    }
    if (profiles.length >= MAX_CONFIG_PROFILES) {
      return;
    }
    onChange([
      ...profiles,
      {
        id: crypto.randomUUID(),
        // The folder's own last segment, which is very often already the
        // answer (`.claude-work` → `claude-work`). A blank name would fail the
        // schema's `min(1)` on the very next write, so the row has to open on
        // something real rather than on a placeholder.
        name: defaultName(dir),
        dir,
        // Cycled rather than fixed, so a user who adds three in a row gets
        // three distinguishable rows without touching the colour picker —
        // which is the whole point of the colour.
        color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]!,
      },
    ]);
  };

  return (
    <div data-slot="config-profiles" className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Configurations</span>
        <span className="text-sm text-muted-foreground">
          Name the config directories you run claude as, so a chat can be
          pointed at an account rather than at a path.
        </span>
      </div>

      {profiles.length === 0 ? (
        // A sentence, not an empty box: this list is empty for most installs
        // and will stay that way, so the empty state has to say what the
        // feature is FOR rather than that there is nothing here.
        <p className="text-sm text-muted-foreground">
          None yet — add one to give a config directory a name and a colour.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              data-slot="config-profile-row"
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
              {/* The app's ONE dropdown — never a native `<select>`, whose OS
                  menu ignores every token and cannot draw a swatch at all. The
                  colour NAME rides the trigger beside the dot: colour is not a
                  label, and a row of eight identical dots is unreadable to
                  anyone who cannot tell them apart.

                  FIXED width, and that is what makes the list line up. It was
                  the one content-sized cell in the row AND the first, so `Blue`
                  and `Orange` started their neighbours at different x and every
                  column after them was ragged — the delete buttons agreed only
                  because they are pushed against the right edge. `w-28` clears
                  the longest label the palette holds (`Orange`) beside the dot
                  and the chevron; the row's other three cells were already
                  fixed, flexible or shrink-0. */}
              <Select
                aria-label={`Colour for ${profile.name}`}
                value={profile.color}
                variant="ghost"
                className="w-28 shrink-0"
                leadingIcon={<PaletteDot color={profile.color} size="lg" />}
                triggerLabel={PALETTE_LABEL[profile.color]}
                groups={[
                  {
                    label: 'Colour',
                    items: PROFILE_COLORS.map((color) => ({
                      value: color,
                      label: PALETTE_LABEL[color],
                      icon: <PaletteDot color={color} size="lg" />,
                    })),
                  },
                ]}
                onValueChange={(color) =>
                  replace(profile.id, { color: color as ProfileColor })
                }
              />
              <Input
                aria-label={`Name for ${shortenPath(profile.dir)}`}
                className="h-7 w-40 shrink-0 text-sm"
                maxLength={MAX_CONFIG_PROFILE_NAME}
                value={
                  draftName?.id === profile.id ? draftName.value : profile.name
                }
                onChange={(event) =>
                  setDraftName({ id: profile.id, value: event.target.value })
                }
                onBlur={() => {
                  const typed = draftName?.value.trim() ?? '';
                  setDraftName(null);
                  // An emptied name is a REVERT, not a save: the schema refuses
                  // one, so writing it would fail the whole patch and lose the
                  // rest of the list with it.
                  if (draftName?.id === profile.id && typed !== '') {
                    replace(profile.id, { name: typed });
                  }
                }}
              />
              {/* The path is the identity and cannot be typed — a hand-edited
                  one is a directory that may not exist, and the picker is the
                  only thing that can answer that. Pressing it re-picks. */}
              <button
                type="button"
                title={`${profile.dir} — press to point this configuration somewhere else`}
                aria-label={`Change the directory for ${profile.name}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  void onPickDirectory().then((dir) => {
                    if (dir !== null && !alreadyListed(dir, profile.id)) {
                      replace(profile.id, { dir });
                    }
                  });
                }}>
                <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                {/* TWO segments, not the default three. This cell is the last
                    thing in a row that has already spent its width on a colour,
                    a name field and a delete button, and at three segments the
                    path overran it and was CSS-truncated — which eats the TAIL,
                    the one end that says which directory it is:
                    `/Users/me/.claude-perso…`. Eliding the head instead is the
                    rule `shortenPath` exists for, and two is the count that
                    makes it fit here (the same reason the context panel passes
                    two). The full path is still on the row's title. */}
                <span className="min-w-0 truncate">
                  {shortenPath(profile.dir, 2)}
                </span>
              </button>
              {/* BOTH verbs, where the card's own footer shows one — and the
                  difference is a fact about what is knowable, not a style
                  choice. `AgentConfigList` picks its verb from `loggedIn`,
                  which `detectClis` probes for the DEFAULT profile only;
                  nothing on this machine reports whether a given config
                  directory holds a live session, so a row that guessed would
                  offer Sign out on an account that had already lapsed. Two
                  honest actions beat one confident wrong one. */}
              {onSignIn ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Sign in to ${profile.name}`}
                  title={`Sign in to ${profile.name} — runs here and opens your browser`}
                  disabled={busy}
                  onClick={() => onSignIn(profile.dir)}>
                  {signingIn === profile.dir ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-3.5 shrink-0 animate-spin"
                    />
                  ) : (
                    <LogIn className="size-3.5 shrink-0" />
                  )}
                </Button>
              ) : null}
              {onSignOut ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Sign out of ${profile.name}`}
                  title={`Sign out of ${profile.name}`}
                  disabled={busy}
                  onClick={() => onSignOut(profile.dir)}>
                  <LogOut className="size-3.5 shrink-0" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${profile.name}`}
                title="Remove"
                onClick={() =>
                  onChange(profiles.filter((row) => row.id !== profile.id))
                }>
                <Trash2 className="size-3.5 shrink-0" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Withheld at the cap rather than failing on press: the write would be
          refused by the schema and the user would be told nothing. */}
      {profiles.length < MAX_CONFIG_PROFILES ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit gap-1.5"
          onClick={() => void add()}>
          <Plus className="size-3.5 shrink-0" />
          Add configuration
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The name a freshly added configuration opens on — the directory's own last
 * segment, with a leading dot dropped.
 *
 * `.claude-work` is a hidden folder and `claude-work` is what the user calls
 * it; the dot is a filesystem convention, not part of the name. A path that
 * ends in a separator (or is one) has no segment to take, and falls back to a
 * word rather than to the empty string the schema would refuse.
 */
export function defaultName(dir: string): string {
  const leaf = dir.split('/').filter(Boolean).at(-1) ?? '';
  const trimmed = leaf.startsWith('.') ? leaf.slice(1) : leaf;
  return (trimmed === '' ? 'Configuration' : trimmed).slice(
    0,
    MAX_CONFIG_PROFILE_NAME,
  );
}
