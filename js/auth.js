document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const toggleSignup = document.getElementById('toggleSignup');
  const toggleLogin = document.getElementById('toggleLogin');
  const loginBox = document.getElementById('loginBox');
  const signupBox = document.getElementById('signupBox');
  const message = document.getElementById('message');

  async function readResponse(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (err) {
      return { error: text };
    }
  }

  if (toggleSignup && toggleLogin) {
    toggleSignup.addEventListener('click', (e) => {
      e.preventDefault();
      loginBox.style.display = 'none';
      signupBox.style.display = 'block';
      message.textContent = '';
    });

    toggleLogin.addEventListener('click', (e) => {
      e.preventDefault();
      signupBox.style.display = 'none';
      loginBox.style.display = 'block';
      message.textContent = '';
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;
      const submitButton = loginForm.querySelector('button[type="submit"]');

      message.textContent = 'Signing in...';
      message.className = 'message';
      if (submitButton) submitButton.disabled = true;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const json = await readResponse(res);
        if (!res.ok) {
          message.textContent = json.error || 'Login failed';
          message.className = 'message error';
          return;
        }

        // store token and redirect
        localStorage.setItem('token', json.token);
        message.textContent = 'Login successful! Redirecting...';
        message.className = 'message success';
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      } catch (err) {
        console.error('login error', err);
        message.textContent = 'Login failed (network)';
        message.className = 'message error';
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

      message.textContent = 'Creating account...';
      message.className = 'message';
      if (submitButton) submitButton.disabled = true;

      if (password.length < 6) {
        message.textContent = 'Password must be at least 6 characters.';
        message.className = 'message error';
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
          message.textContent = json.error || 'Signup failed';
          message.className = 'message error';
          return;
        }

        // Inform user to confirm their email and offer a sign-in button
        message.textContent = 'Account created! A confirmation email has been sent. Please confirm your email address before signing in.';
        message.className = 'message success';

        // Remove any previous action button
        const existingAction = document.getElementById('authActionButton');
        if (existingAction) existingAction.remove();

        // Create a button to let user go to the sign-in form
        const loginBtn = document.createElement('button');
        loginBtn.id = 'authActionButton';
        loginBtn.textContent = 'Go to Sign In';
        loginBtn.className = 'btn btn-primary';
        loginBtn.style.marginTop = '8px';
        loginBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          signupBox.style.display = 'none';
          loginBox.style.display = 'block';
          // clear the message once navigated to sign-in
          message.textContent = '';
        });

        // Append a small break and the button to the message container
        message.appendChild(document.createElement('br'));
        message.appendChild(loginBtn);
      } catch (err) {
        console.error('signup network error', err);
        message.textContent = 'Signup failed (network)';
        message.className = 'message error';
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }
});

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
