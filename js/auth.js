const TOAST_DURATION = 4500;

function resolveToastType(text, explicitType) {
  if (/already registered|already exists|account exist|already taken/i.test(text)) return 'info';
  return explicitType || 'neutral';
}

function clearAllToasts() {
  const container = document.getElementById('toast-container');
  if (!container) return;
  container.querySelectorAll('.toast').forEach((toast) => {
    clearTimeout(toast._dismissTimer);
    toast.remove();
  });
}

function showToast(text, type, options = {}) {
  const container = document.getElementById('toast-container');
  if (!container || !text) return;

  clearAllToasts();

  const toastType = resolveToastType(text, type);
  const duration = options.duration ?? TOAST_DURATION;

  const toast = document.createElement('div');
  toast.className = `toast ${toastType}`;
  toast.textContent = text;

  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-action';
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener('click', () => {
      options.action.onClick();
      dismissToast(toast);
    });
    toast.appendChild(document.createElement('br'));
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);

  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._dismissTimer = timer;
}

function dismissToast(toast) {
  if (!toast || toast.classList.contains('toast-out')) return;
  clearTimeout(toast._dismissTimer);
  toast.classList.add('toast-out');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

function initPasswordToggles() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest('.password-field')) return;

    const wrap = document.createElement('div');
    wrap.className = 'password-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');

    btn.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
    });

    wrap.appendChild(btn);
  });
}

function revealAuthPage() {
  document.documentElement.classList.remove('auth-pending');
}

function redirectTo(path) {
  window.location.replace(path);
}

function isLoginPath() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return path === '/login' || path.endsWith('/index.html');
}

function runEarlyLoginGuard() {
  if (!isLoginPath()) return;
  if (typeof getOrgKey === 'function' && !getOrgKey()) {
    redirectTo(ROUTES.org);
  }
}

async function readResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: text };
  }
}

async function verifyToken() {
  const token = localStorage.getItem('token');
  if (!token) return null;

  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      localStorage.removeItem('token');
      return null;
    }
    const json = await res.json();
    if (json.user?.org_key && typeof setOrg === 'function') {
      setOrg(json.user.org_key, json.user.org_name);
    }
    return json.user;
  } catch (err) {
    console.error('verifyToken error', err);
    localStorage.removeItem('token');
    return null;
  }
}

async function checkAuth() {
  const user = await verifyToken();
  if (!user) {
    redirectTo(ROUTES.org);
    return null;
  }
  revealAuthPage();
  return user;
}

async function initLoginPage() {
  if (!getOrgKey()) {
    redirectTo(ROUTES.org);
    return false;
  }

  const user = await verifyToken();
  if (user) {
    redirectTo(ROUTES.dashboard);
    return false;
  }

  const orgContext = document.getElementById('orgContext');
  if (orgContext) {
    const name = getOrgName();
    orgContext.textContent = name ? `Sign in to ${name}` : 'Log in to manage workforce attendance';
  }

  revealAuthPage();
  return true;
}

async function initOrgPage() {
  const user = await verifyToken();
  if (user) {
    redirectTo(ROUTES.dashboard);
    return false;
  }

  const orgKeyInput = document.getElementById('orgKey');
  const savedKey = getOrgKey();
  if (orgKeyInput && savedKey) orgKeyInput.value = savedKey;

  revealAuthPage();
  return true;
}

function bindLoginForm(loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const org_key = getOrgKey();
    const submitButton = loginForm.querySelector('button[type="submit"]');

    if (!org_key) {
      showToast('Organization key is missing. Please enter your organization key first.', 'error');
      redirectTo(ROUTES.org);
      return;
    }

    showToast('Signing in...', 'neutral');
    if (submitButton) submitButton.disabled = true;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, org_key })
      });
      const json = await readResponse(res);
      if (!res.ok) {
        const errorText = json.error || 'Login failed';
        showToast(errorText, resolveToastType(errorText, 'error'));
        return;
      }

      localStorage.setItem('token', json.token);
      if (json.org_name) setOrg(json.org_key || org_key, json.org_name);
      loginForm.reset();
      showToast('Login successful! Redirecting...', 'success', { duration: 2000 });
      setTimeout(() => redirectTo(ROUTES.dashboard), 800);
    } catch (err) {
      console.error('login error', err);
      showToast('Login failed (network)', 'error');
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initPasswordToggles();

  const loginForm = document.getElementById('loginForm');
  const orgForm = document.getElementById('orgForm');
  const changeOrg = document.getElementById('changeOrg');

  if (loginForm) {
    const ready = await initLoginPage();
    if (!ready) return;
    bindLoginForm(loginForm);
  } else if (orgForm) {
    const ready = await initOrgPage();
    if (!ready) return;
  } else {
    revealAuthPage();
  }

  if (changeOrg) {
    changeOrg.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof clearOrg === 'function') clearOrg();
      localStorage.removeItem('token');
      redirectTo(ROUTES.org);
    });
  }
});

async function signOut() {
  localStorage.removeItem('token');
  redirectTo(ROUTES.org);
}
