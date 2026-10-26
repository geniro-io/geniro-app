/** What a model reads about `list_monitors`. */
export function listMonitorsInstructions(): string {
  return (
    'List the monitors you started in this conversation (with monitor) that are still running: ' +
    'id, description, command, when it started, how many messages it has sent and its timeout. ' +
    'Use it before starting another monitor on the same thing, or to find the id stop_monitor ' +
    'needs. A monitor that has ended is not listed.'
  );
}
