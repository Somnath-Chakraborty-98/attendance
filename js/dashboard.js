let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  const session = await checkAuth();
  if (!session) return;
  currentUser = session.user;
  document.getElementById('userName').textContent = currentUser.user_metadata?.name || currentUser.email;

  await loadWorkers();
  initTabs();
  initWorkerForm();
  initAttendanceForm();
  initRecordsFilter();
});

/* ── Tab Navigation ── */
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

/* ── Workers ── */
async function loadWorkers() {
  const { data, error } = await supabase
    .from('workers')
    .select('*')
    .order('worker_id', { ascending: true });

  const tbody = document.getElementById('workersTableBody');
  if (error) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center">Error loading workers</td></tr>';
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center">No workers added yet</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(w => `
    <tr>
      <td>${escapeHtml(w.worker_id)}</td>
      <td>${escapeHtml(w.name)}</td>
      <td class="actions-cell">
        <button class="btn btn-sm btn-primary" onclick="editWorker('${escapeHtml(w.id)}', '${escapeHtml(w.worker_id)}', '${escapeHtml(w.name)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteWorker('${escapeHtml(w.id)}', '${escapeHtml(w.worker_id)}')">Delete</button>
      </td>
    </tr>
  `).join('');

  populateWorkerDropdowns(data);
}

function populateWorkerDropdowns(workers) {
  const selects = ['attWorker', 'filterWorker'];
  const opts = '<option value="">Select Worker</option>' +
    workers.map(w => `<option value="${escapeHtml(w.worker_id)}">${escapeHtml(w.name)} (${escapeHtml(w.worker_id)})</option>`).join('');
  selects.forEach(id => {
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

    if (editId) {
      const { error } = await supabase
        .from('workers')
        .update({ worker_id, name })
        .eq('id', editId);
      if (error) { alert(error.message); return; }
    } else {
      const { error } = await supabase
        .from('workers')
        .insert({ worker_id, name });
      if (error) {
        if (error.code === '23505') alert('Worker ID already exists.');
        else alert(error.message);
        return;
      }
    }

    document.getElementById('addWorkerForm').style.display = 'none';
    await loadWorkers();
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

  const { error } = await supabase.from('attendance').delete().eq('worker_id', worker_id);
  if (error) { alert('Failed to delete related attendance records: ' + error.message); return; }

  const { error: err2 } = await supabase.from('workers').delete().eq('id', id);
  if (err2) { alert(err2.message); return; }

  await loadWorkers();
}

/* ── Attendance ── */
document.addEventListener('DOMContentLoaded', () => {
  const attDateInput = document.getElementById('attDate');
  if (attDateInput) attDateInput.value = new Date().toISOString().split('T')[0];
});

async function initAttendanceForm() {
  document.getElementById('attendanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('attDate').value;
    const worker_id = document.getElementById('attWorker').value;
    const in_time = document.getElementById('attInTime').value || null;
    const out_time = document.getElementById('attOutTime').value || null;
    const visit_time_from = document.getElementById('attVisitFrom').value || null;
    const visit_time_to = document.getElementById('attVisitTo').value || null;

    if (!date || !worker_id) return;

    const existing = await supabase
      .from('attendance')
      .select('id')
      .eq('date', date)
      .eq('worker_id', worker_id)
      .single();

    let error;
    if (existing.data) {
      ({ error } = await supabase
        .from('attendance')
        .update({ in_time, out_time, visit_time_from, visit_time_to })
        .eq('id', existing.data.id));
    } else {
      ({ error } = await supabase
        .from('attendance')
        .insert({ date, worker_id, in_time, out_time, visit_time_from, visit_time_to }));
    }

    const msg = document.getElementById('attMessage');
    if (error) {
      msg.textContent = error.message;
      msg.className = 'message error';
      msg.style.display = 'block';
      return;
    }

    msg.textContent = 'Attendance saved!';
    msg.className = 'message success';
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);

    showTodayAttendance();
  });

  const attDateInput = document.getElementById('attDate');
  if (attDateInput) {
    attDateInput.addEventListener('change', showTodayAttendance);
    attDateInput.value = attDateInput.value || new Date().toISOString().split('T')[0];
  }
}

async function showTodayAttendance() {
  const date = document.getElementById('attDate').value;
  const tbody = document.getElementById('todayAttendanceBody');
  if (!date) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Select a date</td></tr>';
    return;
  }

  const { data, error } = await supabase
    .from('attendance')
    .select('*, workers!inner(name)')
    .eq('date', date)
    .order('worker_id', { ascending: true });

  if (error) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Error loading data</td></tr>';
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">No records for this date</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(a => `
    <tr>
      <td>${escapeHtml(a.workers?.name || '')}</td>
      <td>${a.in_time || '-'}</td>
      <td>${a.out_time || '-'}</td>
      <td>${a.visit_time_from || '-'}</td>
      <td>${a.visit_time_to || '-'}</td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteAttendance('${escapeHtml(a.id)}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

async function deleteAttendance(id) {
  if (!confirm('Delete this attendance record?')) return;
  const { error } = await supabase.from('attendance').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  showTodayAttendance();
}

/* ── Records ── */
function initRecordsFilter() {
  document.getElementById('btnFilter').addEventListener('click', loadRecords);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('filterDate').value = '';
    document.getElementById('filterWorker').value = '';
    document.getElementById('recordsTableBody').innerHTML =
      '<tr><td colspan="7" class="text-center">Use filters to view records</td></tr>';
  });
}

async function loadRecords() {
  const tbody = document.getElementById('recordsTableBody');
  const date = document.getElementById('filterDate').value;
  const workerId = document.getElementById('filterWorker').value;

  tbody.innerHTML = '<tr><td colspan="7" class="text-center">Loading...</td></tr>';

  let query = supabase.from('attendance').select('*, workers!inner(name)').order('date', { ascending: false }).order('worker_id');

  if (date) query = query.eq('date', date);
  if (workerId) query = query.eq('worker_id', workerId);

  const { data, error } = await query.limit(200);

  if (error) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">Error: ' + error.message + '</td></tr>';
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">No records found</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(a => `
    <tr>
      <td>${a.date}</td>
      <td>${escapeHtml(a.worker_id)}</td>
      <td>${escapeHtml(a.workers?.name || '')}</td>
      <td>${a.in_time || '-'}</td>
      <td>${a.out_time || '-'}</td>
      <td>${a.visit_time_from || '-'}</td>
      <td>${a.visit_time_to || '-'}</td>
    </tr>
  `).join('');
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