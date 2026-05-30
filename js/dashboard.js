let currentUser = null;
let employeesCache = [];
let todayAttendanceCache = [];
let isEditMode = false;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await checkAuth();
  if (!currentUser) return;

  document.getElementById('userName').textContent = currentUser.name || currentUser.email;

  if (currentUser.is_admin) {
    document.querySelectorAll('.admin-only').forEach(el => { el.style.display = ''; });
  }

  initSettingsMenu();
  initTabs();
  initAttendanceForm();
  initRecordsFilter();
  initMasters();
  setDefaultAttendanceDate();
  handleHashNavigation();

  await loadEmployees();
  if (currentUser.is_admin) await loadDepartments();
});

function handleHashNavigation() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'records' || hash === 'masters' || hash === 'attendance') {
    activateTab(hash);
  }
}

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

function activateTab(tab) {
  const navItems = document.querySelectorAll('.sidebar .nav-item[data-tab]');
  navItems.forEach(n => {
    n.classList.toggle('active', n.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.style.display = 'block';
  if (tab === 'attendance') showTodayAttendance();
  if (tab === 'masters' && currentUser.is_admin) {
    loadDepartments();
    loadEmployeesTable();
  }
}

function initTabs() {
  document.querySelectorAll('.sidebar .nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.dataset.tab === 'masters' && !currentUser.is_admin) return;
      activateTab(item.dataset.tab);
    });
  });
}

async function apiRequest(path, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json = {};
  if (text) {
    try { json = JSON.parse(text); } catch {
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      json = { error: plain.length > 120 ? 'Request failed' : plain };
    }
  }
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// ── Employees ──

async function loadEmployees() {
  try {
    const { employees } = await apiRequest('/api/employees');
    employeesCache = employees || [];
    populateEmployeeDropdowns(employeesCache);
  } catch (err) {
    console.error(err);
    employeesCache = [];
    populateEmployeeDropdowns([]);
  }
}

function populateEmployeeDropdowns(employees) {
  const attOpts = '<option value="">Select Employee</option>' +
    employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  const filterOpts = '<option value="">All Employees</option>' +
    employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');

  const attEl = document.getElementById('attEmployee');
  const filterEl = document.getElementById('filterEmployee');
  const deptFormEl = document.getElementById('employeeDepartment');
  if (attEl) attEl.innerHTML = attOpts;
  if (filterEl) filterEl.innerHTML = filterOpts;
}

async function loadEmployeesTable() {
  const tbody = document.getElementById('employeesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';

  try {
    const { employees } = await apiRequest('/api/employees');
    employeesCache = employees || [];

    if (!employees.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No employees added yet</td></tr>';
      populateDepartmentDropdown([]);
      return;
    }

    tbody.innerHTML = employees.map(e => `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td>${escapeHtml(e.mobile || '-')}</td>
        <td>${escapeHtml(e.email_id || '-')}</td>
        <td>${escapeHtml(e.department_name || '-')}</td>
        <td>${e.documents ? `<a href="${escapeHtml(e.documents)}" target="_blank" rel="noopener">View</a>` : '-'}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-primary" onclick="editEmployeeById('${escapeJs(String(e.id))}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteEmployee('${escapeJs(String(e.id))}', '${escapeJs(e.name)}')">Delete</button>
        </td>
      </tr>
    `).join('');

    populateEmployeeDropdowns(employees);
    await loadDepartmentsForForm();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function editEmployeeById(id) {
  const emp = employeesCache.find(e => String(e.id) === String(id));
  if (emp) editEmployee(emp);
}

function editEmployee(emp) {
  document.getElementById('employeeEditId').value = emp.id;
  document.getElementById('employeeName').value = emp.name || '';
  document.getElementById('employeeMobile').value = emp.mobile || '';
  document.getElementById('employeeEmail').value = emp.email_id || '';
  document.getElementById('employeeDepartment').value = emp.department_id || '';
  document.getElementById('employeeDocument').value = '';
  document.getElementById('employeeFormTitle').textContent = 'Edit Employee';

  const docEl = document.getElementById('currentDocument');
  if (emp.documents) {
    docEl.style.display = 'block';
    docEl.innerHTML = `Current: <a href="${escapeHtml(emp.documents)}" target="_blank">View document</a>
      <label class="checkbox-label"><input type="checkbox" id="removeDocument"> Remove document</label>`;
  } else {
    docEl.style.display = 'none';
    docEl.innerHTML = '';
  }

  document.getElementById('addEmployeeForm').style.display = 'block';
}

async function deleteEmployee(id, name) {
  if (!confirm(`Delete employee "${name}"? This will also remove their attendance records.`)) return;
  try {
    await apiRequest(`/api/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Employee deleted.', 'success');
    await loadEmployees();
    await loadEmployeesTable();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initEmployeeForm() {
  document.getElementById('btnAddEmployee').addEventListener('click', async () => {
    document.getElementById('employeeForm').reset();
    document.getElementById('employeeEditId').value = '';
    document.getElementById('employeeFormTitle').textContent = 'Add Employee';
    document.getElementById('currentDocument').style.display = 'none';
    await loadDepartmentsForForm();
    document.getElementById('addEmployeeForm').style.display = 'block';
  });

  document.getElementById('btnCancelEmployee').addEventListener('click', () => {
    document.getElementById('addEmployeeForm').style.display = 'none';
  });

  document.getElementById('employeeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('employeeEditId').value;
    const formData = new FormData();
    formData.append('name', document.getElementById('employeeName').value.trim());
    formData.append('mobile', document.getElementById('employeeMobile').value.trim());
    formData.append('email_id', document.getElementById('employeeEmail').value.trim());
    formData.append('department_id', document.getElementById('employeeDepartment').value);

    const fileInput = document.getElementById('employeeDocument');
    if (fileInput.files[0]) formData.append('document', fileInput.files[0]);

    const removeDoc = document.getElementById('removeDocument');
    if (removeDoc && removeDoc.checked) formData.append('remove_document', 'true');

    try {
      if (editId) {
        formData.append('id', editId);
        await apiRequest('/api/employees/update', { method: 'POST', body: formData });
        showToast('Employee updated.', 'success');
      } else {
        await apiRequest('/api/employees', { method: 'POST', body: formData });
        showToast('Employee added.', 'success');
      }
      document.getElementById('addEmployeeForm').style.display = 'none';
      await loadEmployees();
      await loadEmployeesTable();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function loadDepartmentsForForm() {
  try {
    const { departments } = await apiRequest('/api/departments');
    populateDepartmentDropdown(departments || []);
  } catch (err) {
    populateDepartmentDropdown([]);
  }
}

function populateDepartmentDropdown(departments) {
  const el = document.getElementById('employeeDepartment');
  if (!el) return;
  el.innerHTML = '<option value="">Select Department</option>' +
    departments.map(d => `<option value="${d.id}">${escapeHtml(d.dep_name)}</option>`).join('');
}

// ── Departments ──

async function loadDepartments() {
  const tbody = document.getElementById('departmentsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="2" class="text-center">Loading...</td></tr>';

  try {
    const { departments } = await apiRequest('/api/departments');
    if (!departments || !departments.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="text-center">No departments yet</td></tr>';
      populateDepartmentDropdown([]);
      return;
    }

    tbody.innerHTML = departments.map(d => `
      <tr>
        <td>${escapeHtml(d.dep_name)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-primary" onclick="editDepartment('${escapeJs(String(d.id))}', '${escapeJs(d.dep_name)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDepartment('${escapeJs(String(d.id))}', '${escapeJs(d.dep_name)}')">Delete</button>
        </td>
      </tr>
    `).join('');
    populateDepartmentDropdown(departments);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function editDepartment(id, name) {
  document.getElementById('departmentEditId').value = id;
  document.getElementById('departmentName').value = name;
  document.getElementById('addDepartmentForm').style.display = 'block';
}

async function deleteDepartment(id, name) {
  if (!confirm(`Delete department "${name}"?`)) return;
  try {
    await apiRequest(`/api/departments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Department deleted.', 'success');
    await loadDepartments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initDepartmentForm() {
  document.getElementById('btnAddDepartment').addEventListener('click', () => {
    document.getElementById('departmentForm').reset();
    document.getElementById('departmentEditId').value = '';
    document.getElementById('addDepartmentForm').style.display = 'block';
  });

  document.getElementById('btnCancelDepartment').addEventListener('click', () => {
    document.getElementById('addDepartmentForm').style.display = 'none';
  });

  document.getElementById('departmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('departmentEditId').value;
    const dep_name = document.getElementById('departmentName').value.trim();
    try {
      if (editId) {
        await apiRequest(`/api/departments/${encodeURIComponent(editId)}`, {
          method: 'PUT',
          body: JSON.stringify({ dep_name })
        });
        showToast('Department updated.', 'success');
      } else {
        await apiRequest('/api/departments', {
          method: 'POST',
          body: JSON.stringify({ dep_name })
        });
        showToast('Department added.', 'success');
      }
      document.getElementById('addDepartmentForm').style.display = 'none';
      await loadDepartments();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function initMasters() {
  document.querySelectorAll('.masters-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.masters-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('master-departments').style.display =
        tab.dataset.master === 'departments' ? 'block' : 'none';
      document.getElementById('master-employees').style.display =
        tab.dataset.master === 'employees' ? 'block' : 'none';
    });
  });

  if (currentUser && currentUser.is_admin) {
    initDepartmentForm();
    initEmployeeForm();
  }
}

// ── Attendance helpers ──

function timeToMinutes(t) {
  if (!t) return 0;
  const p = String(t).split(':').map(Number);
  return p[0] * 60 + (p[1] || 0);
}

function minutesToDisplay(m) {
  if (m == null || m <= 0) return '—';
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  return `${h}h ${String(min).padStart(2, '0')}m`;
}

function calcTotalDisplay(inTime, outTime, breakTime) {
  if (!inTime || !outTime) return '—';
  let total = timeToMinutes(outTime) - timeToMinutes(inTime);
  if (breakTime) total -= pgIntervalToMinutes(breakTime);
  return total > 0 ? minutesToDisplay(total) : '0h 00m';
}

function formatTime(t) {
  if (!t) return '—';
  return String(t).slice(0, 5);
}

function updateTotalTimePreview() {
  const el = document.getElementById('attTotalTime');
  if (!el) return;
  el.textContent = calcTotalDisplay(
    document.getElementById('attInTime').value,
    document.getElementById('attOutTime').value,
    document.getElementById('attBreakTime').value
  );
}

function updateVisitSectionVisibility() {
  const from = document.getElementById('attVisitFrom').value;
  const to = document.getElementById('attVisitTo').value;
  const section = document.getElementById('visitSection');
  const body = document.getElementById('visitBody');
  const hasData = Boolean(from || to);

  if (hasData || isEditMode) {
    section.classList.remove('collapsed');
    body.style.display = 'block';
  } else {
    section.classList.add('collapsed');
    body.style.display = 'none';
  }
}

function setLeaveMode(onLeave) {
  const fields = document.getElementById('attendanceFields');
  if (onLeave) {
    fields.style.display = 'none';
    document.getElementById('attInTime').value = '';
    document.getElementById('attOutTime').value = '';
    document.getElementById('attBreakTime').value = '';
    document.getElementById('attVisitFrom').value = '';
    document.getElementById('attVisitTo').value = '';
    document.getElementById('attTotalTime').textContent = '—';
  } else {
    fields.style.display = 'block';
    updateVisitSectionVisibility();
    updateTotalTimePreview();
  }
}

function resetAttendanceForm() {
  isEditMode = false;
  document.getElementById('attendanceForm').reset();
  setDefaultAttendanceDate();
  document.getElementById('attLeave').checked = false;
  document.getElementById('breakTimeGroup').style.display = 'none';
  setLeaveMode(false);
  updateVisitSectionVisibility();
}

function setDefaultAttendanceDate() {
  const el = document.getElementById('attDate');
  if (el) el.value = new Date().toISOString().split('T')[0];
}

function initAttendanceForm() {
  const leaveCb = document.getElementById('attLeave');
  const visitToggle = document.getElementById('visitToggle');

  leaveCb.addEventListener('change', () => setLeaveMode(leaveCb.checked));

  visitToggle.addEventListener('click', () => {
    const body = document.getElementById('visitBody');
    const section = document.getElementById('visitSection');
    const collapsed = section.classList.toggle('collapsed');
    body.style.display = collapsed ? 'none' : 'block';
  });

  ['attInTime', 'attOutTime', 'attBreakTime'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateTotalTimePreview);
  });

  ['attVisitFrom', 'attVisitTo'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateVisitSectionVisibility);
  });

  document.getElementById('attEmployee').addEventListener('change', () => {
    isEditMode = false;
    document.getElementById('breakTimeGroup').style.display = 'none';
  });

  document.getElementById('attendanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const onLeave = document.getElementById('attLeave').checked;
    const payload = {
      date: document.getElementById('attDate').value,
      employee_id: Number(document.getElementById('attEmployee').value),
      leave: onLeave,
      in_time: onLeave ? null : (document.getElementById('attInTime').value || null),
      out_time: onLeave ? null : (document.getElementById('attOutTime').value || null),
      break_time: onLeave ? null : (document.getElementById('attBreakTime').value || null),
      visit_time_from: onLeave ? null : (document.getElementById('attVisitFrom').value || null),
      visit_time_to: onLeave ? null : (document.getElementById('attVisitTo').value || null)
    };

    if (!payload.date || !payload.employee_id) return;

    try {
      await apiRequest('/api/attendance', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Attendance saved.', 'success');
      resetAttendanceForm();
      showTodayAttendance();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('attDate').addEventListener('change', showTodayAttendance);

  document.getElementById('breakTimeGroup').style.display = 'none';
  updateVisitSectionVisibility();
}

async function showTodayAttendance() {
  const date = document.getElementById('attDate').value;
  const tbody = document.getElementById('todayAttendanceBody');
  if (!date) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center">Select a date</td></tr>';
    return;
  }

  try {
    const { attendance } = await apiRequest(`/api/attendance?date=${encodeURIComponent(date)}`);
    todayAttendanceCache = attendance || [];
    if (!attendance || !attendance.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">No records for this date</td></tr>';
      return;
    }

    tbody.innerHTML = attendance.map(a => {
      if (a.leave) {
        return `<tr class="leave-row">
          <td>${escapeHtml(a.name || '')}</td>
          <td colspan="6" class="leave-label">On leave</td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-primary" onclick="loadAttendanceForEditById('${escapeJs(String(a.id))}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteAttendance('${escapeJs(String(a.id))}')">Delete</button>
          </td>
        </tr>`;
      }
      return `<tr>
        <td>${escapeHtml(a.name || '')}</td>
        <td>${formatTime(a.in_time)}</td>
        <td>${formatTime(a.out_time)}</td>
        <td>${formatTime(a.visit_time_from)}</td>
        <td>${formatTime(a.visit_time_to)}</td>
        <td>${formatDuration(a.break_time)}</td>
        <td>${a.total_time || calcTotalDisplay(a.in_time, a.out_time, a.break_time)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-primary" onclick="loadAttendanceForEditById('${escapeJs(String(a.id))}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAttendance('${escapeJs(String(a.id))}')">Delete</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function loadAttendanceForEditById(id) {
  const a = todayAttendanceCache.find(r => String(r.id) === String(id));
  if (a) loadAttendanceForEdit(a);
}

function loadAttendanceForEdit(a) {
  isEditMode = true;
  document.getElementById('attDate').value = a.date;
  document.getElementById('attEmployee').value = a.employee_id;
  document.getElementById('attLeave').checked = Boolean(a.leave);
  document.getElementById('breakTimeGroup').style.display = 'block';

  if (a.leave) {
    setLeaveMode(true);
  } else {
    setLeaveMode(false);
    document.getElementById('attInTime').value = a.in_time ? String(a.in_time).slice(0, 5) : '';
    document.getElementById('attOutTime').value = a.out_time ? String(a.out_time).slice(0, 5) : '';
    document.getElementById('attBreakTime').value = durationToInputValue(a.break_time);
    document.getElementById('attVisitFrom').value = a.visit_time_from ? String(a.visit_time_from).slice(0, 5) : '';
    document.getElementById('attVisitTo').value = a.visit_time_to ? String(a.visit_time_to).slice(0, 5) : '';
    updateVisitSectionVisibility();
    updateTotalTimePreview();
  }

  document.getElementById('attendanceForm').scrollIntoView({ behavior: 'smooth' });
}

async function deleteAttendance(id) {
  if (!confirm('Delete this attendance record?')) return;
  try {
    await apiRequest(`/api/attendance/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Record deleted.', 'success');
    showTodayAttendance();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Records ──

function initRecordsFilter() {
  document.getElementById('btnFilter').addEventListener('click', loadRecords);
  document.getElementById('btnExport').addEventListener('click', exportRecords);
  document.getElementById('btnExportExcel').addEventListener('click', exportRecordsExcel);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    document.getElementById('filterEmployee').value = '';
    document.getElementById('recordsContainer').innerHTML =
      '<p class="text-center records-empty">Use filters to view records</p>';
  });
}

function getRecordFilterParams() {
  const dateFrom = document.getElementById('filterDateFrom').value;
  const dateTo = document.getElementById('filterDateTo').value;
  const employeeId = document.getElementById('filterEmployee').value;
  const params = new URLSearchParams();

  if (dateFrom) {
    params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
  }
  if (employeeId) params.set('employee_id', employeeId);
  return params;
}

function renderRecordsGrouped(attendance) {
  const container = document.getElementById('recordsContainer');
  const grouped = {};

  attendance.forEach(a => {
    const d = a.date;
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(a);
  });

  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  let html = '';

  dates.forEach(date => {
    html += `<div class="records-date-group">
      <h4 class="records-date-heading">${escapeHtml(date)}</h4>
      <div class="table-container">
        <table class="table table-attendance">
          <thead>
            <tr>
              <th>Name</th>
              <th>In Time</th>
              <th>Out Time</th>
              <th>Visit From</th>
              <th>Visit To</th>
              <th>Break</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>`;

    grouped[date].forEach(a => {
      if (a.leave) {
        html += `<tr class="leave-row">
          <td>${escapeHtml(a.name || '')}</td>
          <td colspan="5" class="leave-label">On leave</td>
          <td>—</td>
        </tr>`;
      } else {
        html += `<tr>
          <td>${escapeHtml(a.name || '')}</td>
          <td>${formatTime(a.in_time)}</td>
          <td>${formatTime(a.out_time)}</td>
          <td>${formatTime(a.visit_time_from)}</td>
          <td>${formatTime(a.visit_time_to)}</td>
          <td>${formatDuration(a.break_time)}</td>
          <td>${a.total_time || calcTotalDisplay(a.in_time, a.out_time, a.break_time)}</td>
        </tr>`;
      }
    });

    html += '</tbody></table></div></div>';
  });

  container.innerHTML = html;
}

async function loadRecords() {
  const container = document.getElementById('recordsContainer');
  const dateFrom = document.getElementById('filterDateFrom').value;

  if (!dateFrom) {
    showToast('Please select a from date.', 'error');
    return;
  }

  container.innerHTML = '<p class="text-center records-empty">Loading...</p>';

  try {
    const { attendance } = await apiRequest(`/api/attendance?${getRecordFilterParams().toString()}`);
    if (!attendance || !attendance.length) {
      container.innerHTML = '<p class="text-center records-empty">No records found</p>';
      return;
    }
    renderRecordsGrouped(attendance);
  } catch (err) {
    container.innerHTML = `<p class="text-center records-empty">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function fetchRecordsForExport() {
  const dateFrom = document.getElementById('filterDateFrom').value;
  if (!dateFrom) {
    showToast('Please select a from date before exporting.', 'error');
    return null;
  }
  const { attendance } = await apiRequest(`/api/attendance?${getRecordFilterParams().toString()}`);
  if (!attendance || !attendance.length) {
    showToast('No records to export.', 'info');
    return null;
  }
  return attendance;
}

function recordsToRows(attendance) {
  return [
    ['Date', 'Name', 'In Time', 'Out Time', 'Visit From', 'Visit To', 'Break', 'Total', 'Status'],
    ...attendance.map(a => [
      a.date || '',
      a.name || '',
      a.leave ? '' : (a.in_time || ''),
      a.leave ? '' : (a.out_time || ''),
      a.leave ? '' : (a.visit_time_from || ''),
      a.leave ? '' : (a.visit_time_to || ''),
      a.leave ? '' : formatDuration(a.break_time),
      a.leave ? '' : (a.total_time || ''),
      a.leave ? 'On leave' : 'Present'
    ])
  ];
}

async function exportRecords() {
  const btn = document.getElementById('btnExport');
  btn.disabled = true;
  try {
    const attendance = await fetchRecordsForExport();
    if (!attendance) return;
    const csv = recordsToRows(attendance).map(row => row.map(csvCell).join(',')).join('\r\n');
    downloadFile(csv, `stanzahr-records-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function exportRecordsExcel() {
  const btn = document.getElementById('btnExportExcel');
  btn.disabled = true;
  try {
    const attendance = await fetchRecordsForExport();
    if (!attendance) return;
    const rows = recordsToRows(attendance);
    const tableRows = rows.map(row =>
      '<tr>' + row.map(v => `<td>${escapeHtml(String(v))}</td>`).join('') + '</tr>'
    ).join('');
    const html = `<html><head><meta charset="UTF-8"></head><body><table>${tableRows}</table></body></html>`;
    downloadFile(html, `stanzahr-records-${new Date().toISOString().slice(0, 10)}.xls`, 'application/vnd.ms-excel');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
