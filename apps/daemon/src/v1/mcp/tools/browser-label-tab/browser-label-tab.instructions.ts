import {
  HOST_BROWSER_OPEN_TOOL,
  HOST_BROWSER_TABS_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `browser_label_tab`. */
export function browserLabelTabInstructions(): string {
  return (
    `Rename a tab, give it a colour, or both: the name and colour dot the user sees on it in the pane. ` +
    `Use it when a tab you opened now holds something else (you signed in, moved to another part of the site), or one has no name yet, so the tab says what it is for. ` +
    `A name or colour the user set themselves is theirs: it is kept, and the reply says so. ` +
    `Do NOT use it to open a tab (name and colour a new one in ${HOST_BROWSER_OPEN_TOOL}) or to find a tab id (use ${HOST_BROWSER_TABS_TOOL}).`
  );
}
