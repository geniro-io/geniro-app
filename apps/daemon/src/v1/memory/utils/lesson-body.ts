const LESSON_BODY =
  /^([\s\S]*?)\n\nWhy: [\s\S]*\n\nLesson from (?:a thread|"[^\n]*"), message #\d+: “[\s\S]*”$/;

export interface LessonBodySource {
  why: string;
  sourceTitle: string | null;
  evidenceSeq: number;
  evidenceQuote: string;
}

/** A lesson's memory entry body: the rule in full, then why, then where it came from. */
export function memoryBodyOf(source: LessonBodySource, rule: string): string {
  const from =
    source.sourceTitle === null ? 'a thread' : `"${source.sourceTitle}"`;
  return `${rule}\n\nWhy: ${source.why}\n\nLesson from ${from}, message #${source.evidenceSeq}: “${source.evidenceQuote}”`;
}

/** The rule a {@link memoryBodyOf} body opens with; any other body whole. */
export function ruleOfLessonBody(body: string): string {
  return LESSON_BODY.exec(body)?.[1] ?? body;
}
