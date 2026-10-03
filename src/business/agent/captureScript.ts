/**
 * The script the app injects into the sign-in WebView. The site loads in the
 * WebView as itself; this script watches the site's own API calls so the app
 * can tell when the user is signed in and read the token the site is already
 * sending, the same request header the site uses. Nothing is sent anywhere
 * except back to the app over the WebView message bridge.
 *
 * It wraps `fetch` and `XMLHttpRequest` and, for any request to `apiHost`,
 * posts `{ url, method, status, headers }` to the native side via
 * `ReactNativeWebView.postMessage`. Only request headers the page itself set
 * are visible here; cookies the browser attaches are read natively instead.
 */

/** A request the WebView observed, relayed to the app. */
export interface ObservedRequest {
  kind: 'raidr-agent/observed-request';
  url: string;
  method: string;
  status: number;
  /** Lower-cased header names → value; only headers the page set. */
  headers: Record<string, string>;
}

/**
 * Build the script for one API host. `apiHost` is interpolated as a JSON
 * string, so it cannot break out of the literal.
 */
export function buildCaptureScript(apiHost: string): string {
  return `(function () {
  var HOST = ${JSON.stringify(apiHost)};
  var KIND = 'raidr-agent/observed-request';
  function post(payload) {
    try {
      var bridge = window.ReactNativeWebView;
      if (bridge && bridge.postMessage) bridge.postMessage(JSON.stringify(payload));
    } catch (e) {}
  }
  function hostOf(url) {
    try { return new URL(url, window.location.href).host; } catch (e) { return ''; }
  }
  function headerObject(init) {
    var out = {};
    try {
      var h = init && init.headers;
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { out[String(k).toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(function (pair) { if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = pair[1]; });
      } else {
        Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
      }
    } catch (e) {}
    return out;
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var headers = headerObject(init);
      // Request objects carry their own headers.
      try {
        if (input && input.headers && typeof input.headers.forEach === 'function') {
          input.headers.forEach(function (v, k) { if (!(k.toLowerCase() in headers)) headers[String(k).toLowerCase()] = v; });
        }
      } catch (e) {}
      var p = origFetch.apply(this, arguments);
      if (hostOf(url) === HOST) {
        p.then(function (res) {
          post({ kind: KIND, url: url, method: String(method).toUpperCase(), status: (res && res.status) || 0, headers: headers });
        }).catch(function () {
          post({ kind: KIND, url: url, method: String(method).toUpperCase(), status: 0, headers: headers });
        });
      }
      return p;
    };
  }
  var open = XMLHttpRequest.prototype.open;
  var setHeader = XMLHttpRequest.prototype.setRequestHeader;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__raidr = { method: String(method || 'GET').toUpperCase(), url: url || '', headers: {} };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__raidr) this.__raidr.headers[String(name).toLowerCase()] = value;
    return setHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var info = this.__raidr;
    if (info && hostOf(info.url) === HOST) {
      this.addEventListener('loadend', function () {
        post({ kind: KIND, url: info.url, method: info.method, status: self.status || 0, headers: info.headers });
      });
    }
    return send.apply(this, arguments);
  };
  post({ kind: 'raidr-agent/capture-ready', host: HOST });
})();
true;`;
}
