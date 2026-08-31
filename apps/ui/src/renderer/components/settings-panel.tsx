import { cva, type VariantProps } from 'class-variance-authority';
import type React from 'react';

import { Label } from './ui/label';
import { cn } from './ui/utils';

/**
 * A settings SECTION's rows, enclosed and separated.
 *
 * The shape it replaces was a flat stack: a heading, a `flex` row holding the
 * control, then a muted `<p>` under the whole row at full width. Nothing tied a
 * description to the control it describes, and nothing marked where one setting
 * ended and the next began — so a section of three switches read as six loose
 * elements, and the eye had to re-derive the pairing on every line. Enclosing
 * them says which lines belong together, and the divider says how many settings
 * there are, both without a word of new text.
 *
 * NOT `SettingRow` next door, which is a different component for a different
 * layout: there the LABEL column is fixed and narrow (7rem) and the control
 * takes the rest, which is right for a dense inspector of pickers. Here the
 * label column is the wide one and the control is a fixed thing at the end,
 * which is what a page of switches and swatches needs. The two are inverses of
 * each other and neither can be expressed as a variant of the other without a
 * prop that flips which side grows.
 *
 * No `overflow-hidden`, deliberately: a row may hold a `Select`, whose panel is
 * absolutely placed, and clipping it to the panel's rounded corners would cut
 * the menu off at the row below.
 */
export function SettingsPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-slot="settings-panel"
      // `@container`: the rows below fold at a CONTAINER width, not a viewport
      // one — the reading column this sits in is capped at 42rem and shares the
      // window with a nav column, so the viewport says nothing useful about how
      // much room a row actually has.
      className={cn(
        '@container divide-y divide-border rounded-lg border border-border bg-card',
        className,
      )}>
      {children}
    </div>
  );
}

const settingsPanelRow = cva('flex flex-col gap-2 px-4 py-3', {
  variants: {
    /**
     * `inline` is the ordinary setting — a name on the left, the thing that
     * changes it on the right. It STACKS below `26rem` of container width
     * rather than let either half give way: a description is a sentence, so
     * truncating it says nothing, and a control pushed to a 3rem cell is
     * unusable. The threshold is where a description still holds a short line
     * beside the widest control these rows carry.
     *
     * `block` is for content that IS the width — a textarea, a run of swatches
     * — where the label sits above it and nothing is right-aligned.
     */
    layout: {
      inline: '@[26rem]:flex-row @[26rem]:items-center @[26rem]:gap-4',
      block: '',
    },
  },
  defaultVariants: { layout: 'inline' },
});

const settingsPanelHeading = cva('flex min-w-0 flex-col gap-0.5', {
  variants: {
    layout: { inline: '@[26rem]:flex-1', block: '' },
  },
  defaultVariants: { layout: 'inline' },
});

const settingsPanelControl = cva('flex min-w-0 items-center gap-2', {
  variants: {
    layout: {
      inline: '@[26rem]:shrink-0 @[26rem]:justify-end',
      block: 'w-full flex-col items-stretch',
    },
  },
  defaultVariants: { layout: 'inline' },
});

/**
 * One setting inside a {@link SettingsPanel}.
 *
 * `label` is optional so a panel can carry a row that is not a setting — the
 * actions under a section, a status line — without a heading invented to give
 * it one. `htmlFor` points the label at the control, which is what makes the
 * words clickable for a switch; it is omitted where the control is not a single
 * labelable element (a run of buttons, a swatch group with its own group name).
 */
export function SettingsPanelRow({
  label,
  htmlFor,
  description,
  layout,
  children,
}: {
  label?: string;
  htmlFor?: string;
  /** One line: what changing this does, never what it is. */
  description?: React.ReactNode;
  children: React.ReactNode;
} & VariantProps<typeof settingsPanelRow>): React.JSX.Element {
  return (
    <div
      data-slot="settings-panel-row"
      className={cn(settingsPanelRow({ layout }))}>
      {label === undefined ? null : (
        <div className={cn(settingsPanelHeading({ layout }))}>
          <Label
            htmlFor={htmlFor}
            className={htmlFor === undefined ? undefined : 'cursor-pointer'}>
            {label}
          </Label>
          {description === undefined ? null : (
            <span className="text-xs text-muted-foreground">{description}</span>
          )}
        </div>
      )}
      <div className={cn(settingsPanelControl({ layout }))}>{children}</div>
    </div>
  );
}
