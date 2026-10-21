/** What a model reads about `stop_monitor`. */
export function stopMonitorInstructions(): string {
  return (
    'Stop one of your monitors (started with monitor) before its command ends — once its output ' +
    'has told you what you were waiting for, or it watches something no longer needed. Its whole ' +
    'process group is stopped and nothing more is sent to you from it, not even its end. Only a ' +
    'monitor you started in this conversation can be stopped; list_monitors names them. Do not ' +
    'use it on a monitor that has already ended — its last message said so.'
  );
}
