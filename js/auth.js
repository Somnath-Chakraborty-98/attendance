document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const toggleSignup = document.getElementById('toggleSignup');
  const toggleLogin = document.getElementById('toggleLogin');
  const loginBox = document.getElementById('loginBox');
  const signupBox = document.getElementById('signupBox');
  const message = document.getElementById('message');

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

      message.textContent = '';
      message.className = 'message';

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        message.textContent = error.message;
        message.className = 'message error';
        return;
      }

      message.textContent = 'Login successful! Redirecting...';
      message.className = 'message success';
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
    });
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('signupEmail').value;
      const password = document.getElementById('signupPassword').value;
      const name = document.getElementById('signupName').value;

      message.textContent = '';
      message.className = 'message';

      if (password.length < 6) {
        message.textContent = 'Password must be at least 6 characters.';
        message.className = 'message error';
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } }
      });

      if (error) {
        message.textContent = error.message;
        message.className = 'message error';
        return;
      }

      message.textContent = 'Account created! You can now log in.';
      message.className = 'message success';
      signupBox.style.display = 'none';
      loginBox.style.display = 'block';
    });
  }
});

async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  return session;
}

async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
}