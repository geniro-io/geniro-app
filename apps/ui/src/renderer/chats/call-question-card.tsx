import { MessageCircleQuestion } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { OptionList } from '../components/ui/option-list';

/**
 * A question one agent put to ANOTHER, drawn as the question card it is —
 * inert.
 *
 * It is a CARD rather than prose because the fact worth reading at a glance is
 * that a question was asked and how many answers are on offer — which a
 * sentence with its options folded into it makes a reader parse for.
 *
 * So it borrows the live card's shape (`approval-card.tsx`): the same glyph,
 * the same arity line, the same {@link OptionList} — under its `inert` arm,
 * which is why no second option control had to be written.
 *
 * **What it must NOT borrow is the promise.** The live card is the user's to
 * answer; this one is the CALLER's, over `answer_agent`, and the user only
 * ever sees it here because the transcript shows both sides of a call. So it
 * is muted rather than primary-bordered, its options are inert, and it SAYS
 * who owes the answer — a card that looked answerable and did nothing on a
 * press would be worse than the bubble it replaces.
 *
 * `arity="one"` because that is the shape of the answer owed: `answer_agent`
 * takes ONE string, whatever the callee offered.
 */
export function CallQuestionCard({
  question,
  options,
  caller,
  callee,
}: {
  question: string;
  options: readonly string[];
  /** The agent that owes the answer; null when the row does not name it. */
  caller: string | null;
  /** The agent that asked; null when the row does not name it. */
  callee: string | null;
}): React.JSX.Element {
  return (
    <Card
      data-slot="call-question"
      className="flex w-full flex-col gap-2 border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="text-sm font-medium">
          {caller ? `Question for ${caller}` : 'Question for the caller'}
        </span>
        {callee ? <Badge variant="muted">from {callee}</Badge> : null}
      </div>
      <p className="m-0 text-sm whitespace-pre-wrap">{question}</p>
      {options.length > 0 ? (
        <>
          <p className="m-0 text-xs text-muted-foreground">Pick one.</p>
          <OptionList
            options={options}
            selected={[]}
            arity="one"
            // INERT rather than `disabled`: unpressable either way, but the
            // options are what this card exists to show at a glance and the
            // disabled tint puts them below the AA contrast floor for text this
            // size. There is also no channel from this row to the parked callee
            // — the answer travels `answer_agent`, from the caller's own turn.
            inert
            label="Options"
            onPick={() => undefined}
          />
        </>
      ) : null}
      <p className="m-0 text-xs text-muted-foreground">
        {caller
          ? `${caller} answers this — or passes it on to you as its own question.`
          : 'The calling agent answers this — or passes it on to you as its own question.'}
      </p>
    </Card>
  );
}
