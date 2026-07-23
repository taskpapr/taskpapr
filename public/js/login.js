    (function () {
      const params = new URLSearchParams(location.search);
      const error  = params.get('error');
      if (error === 'not_invited') document.getElementById('error-not-invited').hidden = false;
      if (error === 'no_email')    document.getElementById('error-no-email').hidden    = false;

      fetch('/api/auth-providers')
        .then(r => r.json())
        .then(p => {
          if (p.github) document.getElementById('btn-github').hidden = false;
          if (p.google) document.getElementById('btn-google').hidden = false;
          if (p.oidc)   document.getElementById('btn-sso').hidden    = false;
          if (!p.github && !p.google && !p.oidc) {
            document.getElementById('no-providers').hidden = false;
          }
        })
        .catch(() => {
          document.getElementById('no-providers').hidden = false;
        });
    })();
