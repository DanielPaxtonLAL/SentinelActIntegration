const { randomBytes } = require('crypto');

const COOKIE_NAME = 'act_session';
const SESSION_MS = 12 * 60 * 60 * 1000;

function createActSessions(createClient) {
  const sessions = new Map();
  function idFrom(req) {
    const cookie = (req.headers?.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    const id = cookie?.slice(COOKIE_NAME.length + 1);
    return /^[a-f0-9]{64}$/.test(id || '') ? id : null;
  }
  function remove(req) {
    const id = idFrom(req);
    if (id) sessions.delete(id);
  }
  function get(req) {
    const id = idFrom(req);
    const session = id && sessions.get(id);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return session.client;
  }
  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  }
  return {
    get,
    remove,
    async login(req, res, username, password) {
      const client = createClient();
      await client.authenticate(username, password);
      prune();
      remove(req);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { client, expires: Date.now() + SESSION_MS });
      res.cookie(COOKIE_NAME, id, {
        httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: SESSION_MS,
      });
    },
    logout(req, res) {
      remove(req);
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
    },
  };
}

module.exports = { createActSessions };
