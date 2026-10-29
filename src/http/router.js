import { HttpError } from './util.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  // options : { auth: false } pour une route publique
  add(method, pattern, handler, options = {}) {
    const keys = [];
    const source = pattern.replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.routes.push({
      method,
      regex: new RegExp(`^${source}/?$`),
      keys,
      handler,
      auth: options.auth !== false,
    });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, 'URL invalide');
        }
      });
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, 'Méthode non autorisée');
    return null;
  }
}
