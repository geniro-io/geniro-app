// A stand-in for the embedding child: the same IPC envelope, no model. The
// spec starts it under Electron's Node (ELECTRON_RUN_AS_NODE=1), like the real
// child. Its `getMeta` keys choose what it does: `slow` never answers, `crash`
// exits, `env` and `pid` report the process, `models` reports what it was sent,
// anything else is echoed back. Its one work op, `score`, answers no matches.
let models = { active: null, pending: null };

function reply(id, result) {
  process.send({ id, ok: true, result });
}

process.on('message', (message) => {
  const { id, op } = message;
  if (op === 'open') {
    reply(id, { indexBytes: 0 });
    return;
  }
  if (op === 'models') {
    models = { active: message.active, pending: message.pending };
    reply(id, null);
    return;
  }
  if (op === 'score') {
    reply(id, []);
    return;
  }
  if (op === 'getMeta') {
    switch (message.key) {
      case 'slow':
        return;
      case 'crash':
        process.exit(3);
        return;
      case 'env':
        reply(id, process.env.ELECTRON_RUN_AS_NODE ?? null);
        return;
      case 'pid':
        reply(id, String(process.pid));
        return;
      case 'models':
        reply(id, JSON.stringify(models));
        return;
      default:
        reply(id, message.key);
        return;
    }
  }
  process.send({ id, ok: false, error: `unknown op ${op}` });
});

process.on('disconnect', () => process.exit(0));
