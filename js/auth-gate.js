(function () {
  var ORG_KEY = 'stanzahr_org_key';
  var ORG_READY = 'stanzahr_org_ready';
  var page = document.documentElement.getAttribute('data-auth-page');
  if (!page) return;

  function redirect(path) {
    window.location.replace(path);
  }

  function reveal() {
    document.documentElement.classList.remove('auth-gate');
  }

  if (page === 'org') {
    if (localStorage.getItem('token')) {
      document.documentElement.classList.add('auth-gate');
    } else {
      reveal();
    }
    return;
  }

  if (page === 'login') {
    if (!sessionStorage.getItem(ORG_KEY) || !sessionStorage.getItem(ORG_READY)) {
      redirect('/');
      return;
    }
    return;
  }

  if (page === 'protected') {
    if (!localStorage.getItem('token')) {
      redirect('/');
      return;
    }
  }
})();
