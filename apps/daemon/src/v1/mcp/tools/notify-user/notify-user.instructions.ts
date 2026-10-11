/** What a model reads about `notify_user`. */
export function notifyUserInstructions(): string {
  return (
    'Tell the user, with a notification outside this app, that you are finished and they can come back. ' +
    'Use it when you have finished the task but are leaving a background process running — a dev server, a ' +
    'watcher, anything you started in the background that will not exit on its own. This app announces every ' +
    'finished turn by itself, but while something you started is still running it can only say that the turn ' +
    'ended with a command still running, and it takes that back if you resume — it cannot tell a finished ' +
    'task from a pause. This is how you say you are done, and what is ready; it replaces that plain announcement. ' +
    'Do NOT use it when nothing is left running (the app already announces that ending), when you are ' +
    'pausing to wait for a background command such as a test run or a build (you are not done), or to report ' +
    'progress. ' +
    'Call it ONCE, at the very end, with one sentence the user can act on — e.g. "The dev server is running ' +
    'at http://localhost:3000 and ready to try." The result is a short receipt.'
  );
}
