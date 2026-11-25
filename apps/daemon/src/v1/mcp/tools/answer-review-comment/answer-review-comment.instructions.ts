/** What a model reads about `answer_review_comment`. */
export function answerReviewCommentInstructions(): string {
  return (
    'Answer one comment of a review the user sent from the changes screen: a message that starts "Review of your changes" and numbers each comment (#1, #2, …). ' +
    'Call it once per comment after you have dealt with it, with the number, what you did, and fixed or not_fixed; the answer appears under that comment beside the code, where the user resolves it or reopens it. ' +
    'Answer every comment of the review, the ones you decided not to change included. ' +
    'Do not use it for anything else: it only answers review comments, and a comment the user has not sent or has already resolved is refused.'
  );
}
