### Improved

- When Geniro's background service stops unexpectedly, or Geniro has to force it to stop because it stopped responding, the interrupted thread now says how it ended: killed by a signal, killed by Geniro after it did not stop in time, exited with an error code, an uncaught error and where it came from, or the Mac shutting down, with the memory it last used
