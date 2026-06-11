let currentAdminId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkAuth();
  if (!user) return;
  if (!user.is_admin) {
    window.location.replace(ROUTES.dashboard);
    return;
  }

  currentAdminId = user.id;
  document.getElementById('userName').textContent = user.name || user.email;

  const hint = document.getElementById('newUserPasswordHint');
  if (hint && typeof passwordHint === 'function') hint.textContent = passwordHint();

  initSettingsMenu();
  initUserForm();
  await loadUsers();
});

function initSettingsMenu() {
  const btn = document.getElementById('settingsBtn');
  const dropdown = document.getElementById('settingsDropdown');
  if (!btn || !dropdown) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));
}

function initUserForm() {
  document.getElementById('btnAddUser').addEventListener('click', () => {
    document.getElementById('userForm').reset();
    document.getElementById('addUserForm').style.display = 'block';
  });

  document.getElementById('btnCancelUser').addEventListener('click', () => {
    document.getElementById('addUserForm').style.display = 'none';
  });

  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newUserName').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const is_admin = document.getElementById('newUserAdmin').checked;

    const pwdErr = typeof passwordErrorMessage === 'function' ? passwordErrorMessage(password) : null;
    if (pwdErr) {
      showToast(pwdErr, 'error');
      return;
    }

    try {
      await apiRequest('/api/users', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, is_admin })
      });
      showToast('User account created.', 'success');
      document.getElementById('addUserForm').style.display = 'none';
      await loadUsers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function apiRequest(path, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json = {};
  if (text) {
    try { json = JSON.parse(text); } catch { json = { error: text }; }
  }
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';

  try {
    const { users } = await apiRequest('/api/users');
    if (!users || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No users found</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.name || '-')}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.is_verified ? 'Yes' : 'No'}</td>
        <td>${u.is_admin ? 'Yes' : 'No'}</td>
        <td class="actions-cell">
          ${String(u.id) === String(currentAdminId)
            ? '<span class="text-muted">Current user</span>'
            : `<button class="btn btn-sm ${u.is_admin ? 'btn-secondary' : 'btn-primary'}"
                 onclick="toggleAdmin('${escapeJs(u.id)}', ${!u.is_admin})">
                 ${u.is_admin ? 'Remove Admin' : 'Make Admin'}
               </button>`}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function toggleAdmin(id, makeAdmin) {
  try {
    await apiRequest(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_admin: makeAdmin })
    });
    showToast(makeAdmin ? 'Admin access granted.' : 'Admin access removed.', 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
