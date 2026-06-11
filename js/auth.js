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

document.addEventListener('DOMContentLoaded', () => {
  initPasswordToggles();

  const loginForm = document.getElementById('loginForm');
  const orgContext = document.getElementById('orgContext');
  const changeOrg = document.getElementById('changeOrg');

  if (loginForm && typeof requireOrgOrRedirect === 'function') {
    if (!requireOrgOrRedirect()) return;
    if (orgContext && typeof getOrgName === 'function') {
      const name = getOrgName();
      orgContext.textContent = name ? `Sign in to ${name}` : 'Log in to manage workforce attendance';
    }
  }

  if (changeOrg) {
    changeOrg.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof clearOrg === 'function') clearOrg();
      localStorage.removeItem('token');
      window.location.href = ROUTES.org;
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;
      const org_key = typeof getOrgKey === 'function' ? getOrgKey() : '';
      const submitButton = loginForm.querySelector('button[type="submit"]');

      if (!org_key) {
        showToast('Organization key is missing. Please enter your organization key first.', 'error');
        setTimeout(() => { window.location.href = ROUTES.org; }, 1500);
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
        if (json.org_name && typeof setOrg === 'function') setOrg(json.org_key || org_key, json.org_name);
        loginForm.reset();
        showToast('Login successful! Redirecting...', 'success', { duration: 2000 });
        setTimeout(() => { window.location.href = ROUTES.dashboard; }, 800);
      } catch (err) {
        console.error('login error', err);
        showToast('Login failed (network)', 'error');
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }
});

async function readResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: text };
  }
}

async function checkAuth() {
  const token = localStorage.getItem('token');
  if (!token) {
    if (typeof getOrgKey === 'function' && !getOrgKey()) {
      window.location.href = ROUTES.org;
    } else {
      window.location.href = ROUTES.login;
    }
    return null;
  }

  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      localStorage.removeItem('token');
      window.location.href = ROUTES.login;
      return null;
    }
    const json = await res.json();
    if (json.user?.org_key && typeof setOrg === 'function') {
      setOrg(json.user.org_key, json.user.org_name);
    }
    return json.user;
  } catch (err) {
    console.error('checkAuth error', err);
    localStorage.removeItem('token');
    window.location.href = ROUTES.login;
    return null;
  }
}

async function signOut() {
  localStorage.removeItem('token');
  window.location.href = ROUTES.login;
}
