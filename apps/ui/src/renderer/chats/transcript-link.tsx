import { ChatLink } from './browser/chat-link';

/**
 * A transcript link, with the chat's link rules (`chats/browser/chat-link.tsx`).
 */
export function TranscriptLink({
  href,
  title,
  children,
}: {
  href: string | undefined;
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // `break-all` for the same reason as inline code, and this one was
    // measured as the widest offender in a real transcript: an autolinked
    // URL is a single unbreakable token whose link TEXT is the URL, and one
    // of them pushed the transcript 139px past its pane.
    <ChatLink
      href={href}
      title={title}
      className="text-primary underline underline-offset-2 break-all">
      {children}
    </ChatLink>
  );
}
