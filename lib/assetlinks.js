'use strict';

// Digital Asset Links for the Android app (a Trusted Web Activity).
//
// Chrome only opens a TWA full-screen, without a URL bar, when the site
// vouches for the app: /.well-known/assetlinks.json must list the app's
// package name and the SHA-256 fingerprint of its signing certificate.
// Without that, the app still works but falls back to a Custom Tab with a
// URL bar.
//
// The statements come from the ANDROID_APP_LINKS env var, not from the repo,
// so self-hosters can point their own builds at their own server (DESIGN.md
// tenet 16) and no fingerprints are committed. Format: comma- or
// whitespace-separated `package=FINGERPRINT` entries. A package may appear
// more than once, for example during a signing-key rotation:
//
//   ANDROID_APP_LINKS=com.taskpapr.app=AB:CD:…:EF,com.taskpapr.app.staging=AB:CD:…:EF
//
// Fingerprints are the colon-separated SHA-256 form that `keytool -list -v`
// and `apksigner verify --print-certs` print, in upper or lower case.

const PACKAGE_RE     = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

// Returns { statements, errors }. statements is the assetlinks.json array, or
// null when nothing valid is configured. errors lists rejected entries, so
// the caller can log them at startup instead of silently dropping them
// (tenet 15).
function parseAppLinks(raw) {
  const errors = [];
  const byPackage = new Map();

  for (const entry of String(raw || '').split(/[\s,]+/).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const pkg = eq > 0 ? entry.slice(0, eq) : '';
    const fp  = eq > 0 ? entry.slice(eq + 1) : '';
    if (!PACKAGE_RE.test(pkg) || !FINGERPRINT_RE.test(fp)) {
      errors.push(entry);
      continue;
    }
    if (!byPackage.has(pkg)) byPackage.set(pkg, new Set());
    byPackage.get(pkg).add(fp.toUpperCase());
  }

  if (byPackage.size === 0) return { statements: null, errors };

  const statements = [...byPackage].map(([pkg, fps]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: pkg,
      sha256_cert_fingerprints: [...fps],
    },
  }));
  return { statements, errors };
}

module.exports = { parseAppLinks };
