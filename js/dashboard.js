let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await checkAuth();
  if (!currentUser) return;

  document.getElementById('userName').textContent = currentUser.name || currentUser.email;

  initTabs();
  initWorkerForm();
  initAttendanceForm();
  initRecordsFilter();
  setDefaultAttendanceDate();
  await loadWorkers();
});

async function apiRequest(path, options = {}) {
  const token = localStorage.getItem('token');
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json = {};

  if (text) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = { error: text };
    }
  }

  if (!res.ok) {
    throw new Error(json.error || 'Request failed');
  }

  return json;
}

function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
      document.getElementById('tab-' + tab).style.display = 'block';

      if (tab === 'attendance') showTodayAttendance();
    });
  });
}

async function loadWorkers() {
  const tbody = document.getElementById('workersTableBody');
  tbody.innerHTML = '<tr><td colspan="3" class="text-center">Loading...</td></tr>';

  try {
    const { workers } = await apiRequest('/api/workers');

    if (!workers || workers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center">No workers added yet</td></tr>';
      populateWorkerDropdowns([]);
      return;
    }

    tbody.innerHTML = workers.map(w => `
      <tr>
        <td>${escapeHtml(w.worker_id)}</td>
        <td>${escapeHtml(w.name)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-primary" onclick="editWorker('${escapeJs(w.id)}', '${escapeJs(w.worker_id)}', '${escapeJs(w.name)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteWorker('${escapeJs(w.id)}', '${escapeJs(w.worker_id)}')">Delete</button>
        </td>
      </tr>
    `).join('');

    populateWorkerDropdowns(workers);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function populateWorkerDropdowns(workers) {
  const opts = '<option value="">Select Worker</option>' +
    workers.map(w => `<option value="${escapeHtml(w.worker_id)}">${escapeHtml(w.name)} (${escapeHtml(w.worker_id)})</option>`).join('');

  ['attWorker', 'filterWorker'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

function initWorkerForm() {
  document.getElementById('btnAddWorker').addEventListener('click', () => {
    document.getElementById('workerForm').reset();
    document.getElementById('workerEditId').value = '';
    document.getElementById('workerFormTitle').textContent = 'Add Worker';
    document.getElementById('addWorkerForm').style.display = 'block';
  });

  document.getElementById('btnCancelWorker').addEventListener('click', () => {
    document.getElementById('addWorkerForm').style.display = 'none';
  });

  document.getElementById('workerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('workerEditId').value;
    const worker_id = document.getElementById('workerId').value.trim();
    const name = document.getElementById('workerName').value.trim();

    if (!worker_id || !name) return;

    try {
      if (editId) {
        await apiRequest(`/api/workers/${encodeURIComponent(editId)}`, {
          method: 'PUT',
          body: JSON.stringify({ worker_id, name })
        });
      } else {
        await apiRequest('/api/workers', {
          method: 'POST',
          body: JSON.stringify({ worker_id, name })
        });
      }

      document.getElementById('addWorkerForm').style.display = 'none';
      await loadWorkers();
    } catch (err) {
      alert(err.message);
    }
  });
}

function editWorker(id, worker_id, name) {
  document.getElementById('workerEditId').value = id;
  document.getElementById('workerId').value = worker_id;
  document.getElementById('workerName').value = name;
  document.getElementById('workerFormTitle').textContent = 'Edit Worker';
  document.getElementById('addWorkerForm').style.display = 'block';
}

async function deleteWorker(id, worker_id) {
  if (!confirm(`Delete worker "${worker_id}"? This cannot be undone.`)) return;

  try {
    await apiRequest(`/api/workers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadWorkers();
  } catch (err) {
    alert(err.message);
  }
}

function setDefaultAttendanceDate() {
  const attDateInput = document.getElementById('attDate');
  if (attDateInput) attDateInput.value = new Date().toISOString().split('T')[0];
}

function initAttendanceForm() {
  document.getElementById('attendanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('attDate').value;
    const worker_id = document.getElementById('attWorker').value;
    const in_time = document.getElementById('attInTime').value || null;
    const out_time = document.getElementById('attOutTime').value || null;
    const visit_time_from = document.getElementById('attVisitFrom').value || null;
    const visit_time_to = document.getElementById('attVisitTo').value || null;
    const msg = document.getElementById('attMessage');

    if (!date || !worker_id) return;

    try {
      await apiRequest('/api/attendance', {
        method: 'POST',
        body: JSON.stringify({ date, worker_id, in_time, out_time, visit_time_from, visit_time_to })
      });

      msg.textContent = 'Attendance saved!';
      msg.className = 'message success';
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
      showTodayAttendance();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'message error';
      msg.style.display = 'block';
    }
  });

  const attDateInput = document.getElementById('attDate');
  if (attDateInput) {
    attDateInput.addEventListener('change', showTodayAttendance);
  }
}

async function showTodayAttendance() {
  const date = document.getElementById('attDate').value;
  const tbody = document.getElementById('todayAttendanceBody');
  if (!date) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Select a date</td></tr>';
    return;
  }

  try {
    const { attendance } = await apiRequest(`/api/attendance?date=${encodeURIComponent(date)}`);

    if (!attendance || attendance.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No records for this date</td></tr>';
      return;
    }

    tbody.innerHTML = attendance.map(a => `
      <tr>
        <td>${escapeHtml(a.name || '')}</td>
        <td>${a.in_time || '-'}</td>
        <td>${a.out_time || '-'}</td>
        <td>${a.visit_time_from || '-'}</td>
        <td>${a.visit_time_to || '-'}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteAttendance('${escapeJs(a.id)}')">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteAttendance(id) {
  if (!confirm('Delete this attendance record?')) return;

  try {
    await apiRequest(`/api/attendance/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showTodayAttendance();
  } catch (err) {
    alert(err.message);
  }
}

function initRecordsFilter() {
  document.getElementById('btnFilter').addEventListener('click', loadRecords);
  document.getElementById('btnExport').addEventListener('click', exportRecords);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('filterDate').value = '';
    document.getElementById('filterWorker').value = '';
    document.getElementById('recordsTableBody').innerHTML =
      '<tr><td colspan="7" class="text-center">Use filters to view records</td></tr>';
  });
}

function getRecordFilterParams() {
  const date = document.getElementById('filterDate').value;
  const workerId = document.getElementById('filterWorker').value;
  const params = new URLSearchParams();

  if (date) params.set('date', date);
  if (workerId) params.set('worker_id', workerId);

  return params;
}

async function loadRecords() {
  const tbody = document.getElementById('recordsTableBody');
  const params = getRecordFilterParams();

  tbody.innerHTML = '<tr><td colspan="7" class="text-center">Loading...</td></tr>';

  try {
    const { attendance } = await apiRequest(`/api/attendance?${params.toString()}`);

    if (!attendance || attendance.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No records found</td></tr>';
      return;
    }

    tbody.innerHTML = attendance.map(a => `
      <tr>
        <td>${a.date}</td>
        <td>${escapeHtml(a.worker_id)}</td>
        <td>${escapeHtml(a.name || '')}</td>
        <td>${a.in_time || '-'}</td>
        <td>${a.out_time || '-'}</td>
        <td>${a.visit_time_from || '-'}</td>
        <td>${a.visit_time_to || '-'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function exportRecords() {
  const exportButton = document.getElementById('btnExport');
  const params = getRecordFilterParams();

  exportButton.disabled = true;
  exportButton.textContent = 'Exporting...';

  try {
    const { attendance } = await apiRequest(`/api/attendance?${params.toString()}`);
    if (!attendance || attendance.length === 0) {
      alert('No records to export.');
      return;
    }

    const rows = [
      ['Date', 'Worker ID', 'Name', 'In Time', 'Out Time', 'Visit From', 'Visit To'],
      ...attendance.map(a => [
        a.date || '',
        a.worker_id || '',
        a.name || '',
        a.in_time || '',
        a.out_time || '',
        a.visit_time_from || '',
        a.visit_time_to || ''
      ])
    ];

    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `attendance-records-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message);
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = 'Export CSV';
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
