(function () {
  var LOGIN_ALLOWED = 'stanzahr_login_allowed';
  var page = document.documentElement.getAttribute('data-auth-page');
  if (!page) return;

  function redirect(path) {
    window.location.replace(path);
  }

  function reveal() {
    document.documentElement.classList.remove('auth-gate');
  }

  if (page === 'org') {
    sessionStorage.removeItem(LOGIN_ALLOWED);
    if (localStorage.getItem('token')) {
      document.documentElement.classList.add('auth-gate');
    } else {
      reveal();
    }
    return;
  }

  if (page === 'login') {
    if (sessionStorage.getItem(LOGIN_ALLOWED) !== '1') {
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
