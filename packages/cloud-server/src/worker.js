function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        runtime: 'cloudflare-worker-scaffold',
        appUrl: env.APP_URL ?? null,
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json(
      {
        error: 'Cloudflare worker routes are not fully ported yet.',
      },
      { status: 501 },
    );
  },

  async scheduled(_event, _env, _ctx) {
    console.warn('Scheduled brain compaction is not ported yet.');
  },
};