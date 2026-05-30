const TOAST_DURATION = 4500;

function resolveToastType(text, explicitType) {
  if (/already registered|already exists|account exist/i.test(text)) return 'info';
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

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const toggleSignup = document.getElementById('toggleSignup');
  const toggleLogin = document.getElementById('toggleLogin');
  const loginBox = document.getElementById('loginBox');
  const signupBox = document.getElementById('signupBox');

  function clearForm(form) {
    if (form) form.reset();
  }

  function clearAuthForms() {
    clearForm(loginForm);
    clearForm(signupForm);
  }

  function switchToLogin() {
    clearAuthForms();
    signupBox.style.display = 'none';
    loginBox.style.display = 'block';
  }

  function switchToSignup() {
    clearAuthForms();
    loginBox.style.display = 'none';
    signupBox.style.display = 'block';
  }

  if (toggleSignup && toggleLogin) {
    toggleSignup.addEventListener('click', (e) => {
      e.preventDefault();
      switchToSignup();
    });

    toggleLogin.addEventListener('click', (e) => {
      e.preventDefault();
      switchToLogin();
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;
      const submitButton = loginForm.querySelector('button[type="submit"]');

      showToast('Signing in...', 'neutral');
      if (submitButton) submitButton.disabled = true;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const json = await readResponse(res);
        if (!res.ok) {
          const errorText = json.error || 'Login failed';
          showToast(errorText, resolveToastType(errorText, 'error'));
          return;
        }

        localStorage.setItem('token', json.token);
        clearForm(loginForm);
        showToast('Login successful! Redirecting...', 'success', { duration: 2000 });
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      } catch (err) {
        console.error('login error', err);
        showToast('Login failed (network)', 'error');
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('signupEmail').value;
      const password = document.getElementById('signupPassword').value;
      const name = document.getElementById('signupName').value;
      const submitButton = signupForm.querySelector('button[type="submit"]');

      showToast('Creating account...', 'neutral');
      if (submitButton) submitButton.disabled = true;

      if (password.length < 6) {
        showToast('Password must be at least 6 characters.', 'error');
        if (submitButton) submitButton.disabled = false;
        return;
      }

      try {
        const res = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name })
        });
        const json = await readResponse(res);
        if (!res.ok) {
          console.error('signup error', json);
          const errorText = json.error || 'Signup failed';
          showToast(errorText, resolveToastType(errorText, 'error'));
          return;
        }

        showToast(
          'Account created! A confirmation email has been sent. Please confirm your email before signing in.',
          'success',
          {
            duration: 8000,
            action: {
              label: 'Go to Sign In',
              onClick: switchToLogin
            }
          }
        );
        clearForm(signupForm);
      } catch (err) {
        console.error('signup network error', err);
        showToast('Signup failed (network)', 'error');
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
    window.location.href = 'index.html';
    return null;
  }

  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      localStorage.removeItem('token');
      window.location.href = 'index.html';
      return null;
    }
    const json = await res.json();
    return json.user;
  } catch (err) {
    console.error('checkAuth error', err);
    localStorage.removeItem('token');
    window.location.href = 'index.html';
    return null;
  }
}

async function signOut() {
  localStorage.removeItem('token');
  window.location.href = 'index.html';
}
