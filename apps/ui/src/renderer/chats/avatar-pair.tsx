import { ArrowRight } from 'lucide-react';

import { type AvatarLook, MemberAvatar } from '../components/member-avatar';

/** Caller → callee faces, as a call card's header and the Agents chip's rows draw them. */
export function AvatarPair({
  caller,
  callerKey,
  callerAvatar,
  callee,
  calleeKey,
  calleeAvatar,
}: {
  caller: string;
  callerKey: string;
  callerAvatar?: AvatarLook;
  callee: string;
  calleeKey: string;
  calleeAvatar?: AvatarLook;
}): React.JSX.Element {
  return (
    <span data-slot="avatar-pair" className="flex shrink-0 items-center gap-1">
      <MemberAvatar
        name={caller}
        colorKey={callerKey}
        avatar={callerAvatar}
        size={20}
      />
      <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
      <MemberAvatar
        name={callee}
        colorKey={calleeKey}
        avatar={calleeAvatar}
        size={20}
      />
    </span>
  );
}
