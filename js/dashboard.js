let currentUser = null;
let employeesCache = [];
let todayAttendanceCache = [];
let isEditMode = false;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await checkAuth();
  if (!currentUser) return;

  document.getElementById('userName').textContent = currentUser.name || currentUser.email;

  const navOrg = document.getElementById('navOrgName');
  if (navOrg) {
    navOrg.textContent = currentUser.org_name ? `· ${currentUser.org_name}` : '';
  }
  if (currentUser.org_key && typeof setOrg === 'function') {
    setOrg(currentUser.org_key, currentUser.org_name);
  }

  if (currentUser.is_admin) {
    document.querySelectorAll('.admin-only').forEach(el => { el.style.display = ''; });
  }

  initSettingsMenu();
  initTabs();
  initAttendanceForm();
  initRecordsFilter();
  initMasters();
  if (typeof initDashboardFeatures === 'function') initDashboardFeatures();
  setDefaultAttendanceDate();
  activateTab('dashboard');
  if (window.history.replaceState) {
    history.replaceState(null, '', ROUTES.dashboard);
  }

  await loadEmployees();
  if (currentUser.is_admin) await loadDepartments();
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

function activateTab(tab) {
  const navItems = document.querySelectorAll('.sidebar .nav-item[data-tab]');
  navItems.forEach(n => {
    n.classList.toggle('active', n.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.style.display = 'block';
  if (tab === 'attendance') showTodayAttendance();
  if (tab === 'dashboard' && typeof loadDashboardStats === 'function') loadDashboardStats();
  if (tab === 'employees' && typeof loadEmployeeDirectory === 'function') loadEmployeeDirectory();
  if (tab === 'organization' && currentUser.is_admin) loadDepartments();
  if (tab === 'leave' && typeof loadLeaveRecords === 'function') loadLeaveRecords();
  if (tab === 'late' && typeof initLateTab === 'function') initLateTab();
  if (tab === 'organization' && typeof loadHolidays === 'function') {
    const activeOrgTab = document.querySelector('[data-org-tab].active');
    if (activeOrgTab?.dataset.orgTab === 'holidays') loadHolidays();
    if (activeOrgTab?.dataset.orgTab === 'settings' && typeof loadOrgSettings === 'function') loadOrgSettings();
  }
}

function initTabs() {
  document.querySelectorAll('.sidebar .nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.dataset.tab === 'organization' && !currentUser.is_admin) return;
      activateTab(item.dataset.tab);
      if (window.history.replaceState) {
        history.replaceState(null, '', ROUTES.dashboard);
      }
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
    if (typeof populateFeatureDropdowns === 'function') populateFeatureDropdowns();
  } catch (err) {
    console.error(err);
    employeesCache = [];
    populateEmployeeDropdowns([]);
    if (typeof populateFeatureDropdowns === 'function') populateFeatureDropdowns();
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
  if (typeof loadEmployeeDirectory === 'function') return loadEmployeeDirectory();
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
  document.getElementById('employeeJoining').value = emp.joining_date ? String(emp.joining_date).slice(0, 10) : '';
  document.getElementById('employeeBirthday').value = emp.birthday ? String(emp.birthday).slice(0, 10) : '';
  document.getElementById('employeeWorkStart').value = emp.work_start_time ? String(emp.work_start_time).slice(0, 5) : '';
  document.getElementById('employeeAnnualLeave').value = emp.annual_leave_days ?? '';
  document.getElementById('employeeTrackVisit').checked = Boolean(emp.track_visit_time);
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

  loadDepartmentsForForm().then(() => {
    document.getElementById('addEmployeeForm').style.display = 'block';
    document.getElementById('addEmployeeForm').scrollIntoView({ behavior: 'smooth' });
  });
}

async function deleteEmployee(id, name) {
  if (!confirm(`Delete employee "${name}"? This will also remove their attendance records.`)) return;
  try {
    await apiRequest(`/api/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Employee deleted.', 'success');
    await loadEmployees();
    if (typeof loadEmployeeDirectory === 'function') await loadEmployeeDirectory();
    if (typeof loadPlanUsageBadge === 'function') loadPlanUsageBadge();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openEmployeeForm() {
  if (currentUser?.is_admin) {
    try {
      const { plan } = await apiRequest('/api/organization/plan');
      if (plan.max_employees != null && plan.employee_count >= plan.max_employees) {
        showToast(`Employee limit reached (${plan.max_employees} on ${plan.plan_name} plan).`, 'error');
        return;
      }
    } catch (err) {
      console.error(err);
    }
  }
  document.getElementById('employeeForm').reset();
  document.getElementById('employeeEditId').value = '';
  document.getElementById('employeeFormTitle').textContent = 'Add Employee';
  document.getElementById('currentDocument').style.display = 'none';
  loadDepartmentsForForm().then(() => {
    document.getElementById('addEmployeeForm').style.display = 'block';
    document.getElementById('addEmployeeForm').scrollIntoView({ behavior: 'smooth' });
  });
}

function initEmployeeForm() {
  const addBtn = document.getElementById('btnDirAddEmployee');
  if (addBtn) addBtn.addEventListener('click', openEmployeeForm);

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
    formData.append('joining_date', document.getElementById('employeeJoining').value);
    formData.append('birthday', document.getElementById('employeeBirthday').value);
    formData.append('work_start_time', document.getElementById('employeeWorkStart').value);
    formData.append('annual_leave_days', document.getElementById('employeeAnnualLeave').value);
    formData.append('track_visit_time', document.getElementById('employeeTrackVisit').checked ? 'true' : 'false');

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
      if (typeof loadEmployeeDirectory === 'function') await loadEmployeeDirectory();
      if (typeof loadPlanUsageBadge === 'function') loadPlanUsageBadge();
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

function updateVisitFieldsForEmployee() {
  const empId = document.getElementById('attEmployee').value;
  const emp = employeesCache.find(e => String(e.id) === String(empId));
  const section = document.getElementById('visitSection');
  if (!section) return;
  const show = emp && emp.track_visit_time;
  section.style.display = show ? '' : 'none';
  if (!show) {
    document.getElementById('attVisitFrom').value = '';
    document.getElementById('attVisitTo').value = '';
  }
}

function formatLateCategory(cat) {
  if (!cat || cat === 'on_time') return '—';
  if (cat === 'late_5') return '≤5 min';
  if (cat === 'late_15') return '≤15 min';
  if (cat === 'late_over_15') return '>15 min';
  return cat;
}

function setLeaveMode(onLeave) {
  const fields = document.getElementById('attendanceFields');
  const halfEl = document.getElementById('attHalfDay');
  if (onLeave) {
    fields.style.display = 'none';
    if (halfEl) halfEl.value = '';
    document.getElementById('attInTime').value = '';
    document.getElementById('attOutTime').value = '';
    document.getElementById('attBreakTime').value = '';
    document.getElementById('attVisitFrom').value = '';
    document.getElementById('attVisitTo').value = '';
    document.getElementById('attTotalTime').textContent = '—';
  } else {
    fields.style.display = 'block';
    updateVisitFieldsForEmployee();
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

  leaveCb.addEventListener('change', () => {
    if (leaveCb.checked) document.getElementById('attHalfDay').value = '';
    setLeaveMode(leaveCb.checked);
  });

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
    updateVisitFieldsForEmployee();
  });

  document.getElementById('attendanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const onLeave = document.getElementById('attLeave').checked;
    const payload = {
      date: document.getElementById('attDate').value,
      employee_id: Number(document.getElementById('attEmployee').value),
      leave: onLeave,
      half_day: onLeave ? null : (document.getElementById('attHalfDay').value || null),
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
          <td>—</td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-primary" onclick="loadAttendanceForEditById('${escapeJs(String(a.id))}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteAttendance('${escapeJs(String(a.id))}')">Delete</button>
          </td>
        </tr>`;
      }
      const halfLabel = a.half_day === 'first_half' ? '1st half' : a.half_day === 'second_half' ? '2nd half' : '';
      return `<tr>
        <td>${escapeHtml(a.name || '')}${halfLabel ? ` <span class="badge-half">${halfLabel}</span>` : ''}</td>
        <td>${formatTime(a.in_time)}</td>
        <td>${formatTime(a.out_time)}</td>
        <td>${formatTime(a.visit_time_from)}</td>
        <td>${formatTime(a.visit_time_to)}</td>
        <td>${formatDuration(a.break_time)}</td>
        <td>${formatLateCategory(a.late_category)}</td>
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
  document.getElementById('attHalfDay').value = a.half_day || '';
  document.getElementById('breakTimeGroup').style.display = 'block';
  updateVisitFieldsForEmployee();

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
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    document.getElementById('filterEmployee').value = '';
    document.getElementById('recordsContainer').innerHTML =
      '<p class="text-center records-empty">Use filters to view records</p>';
  });

  const exportBtn = document.getElementById('btnExportMenu');
  const exportDropdown = document.getElementById('exportDropdown');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => exportDropdown.classList.remove('open'));

  exportDropdown.querySelectorAll('.export-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdown.classList.remove('open');
      const format = item.dataset.format;
      if (format === 'csv') exportRecords();
      else if (format === 'excel') exportRecordsExcel();
      else if (format === 'pdf') exportRecordsPdf();
    });
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
              <th>Late</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>`;

    grouped[date].forEach(a => {
      if (a.leave) {
        html += `<tr class="leave-row">
          <td>${escapeHtml(a.name || '')}</td>
          <td colspan="6" class="leave-label">On leave</td>
          <td>—</td>
        </tr>`;
      } else {
        const halfLabel = a.half_day ? ` (${a.half_day})` : '';
        html += `<tr>
          <td>${escapeHtml(a.name || '')}${halfLabel}</td>
          <td>${formatTime(a.in_time)}</td>
          <td>${formatTime(a.out_time)}</td>
          <td>${formatTime(a.visit_time_from)}</td>
          <td>${formatTime(a.visit_time_to)}</td>
          <td>${formatDuration(a.break_time)}</td>
          <td>${formatLateCategory(a.late_category)}</td>
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
    ['Date', 'Name', 'In Time', 'Out Time', 'Visit From', 'Visit To', 'Break', 'Late', 'Half Day', 'Total', 'Status'],
    ...attendance.map(a => [
      a.date || '',
      a.name || '',
      a.leave ? '' : (a.in_time || ''),
      a.leave ? '' : (a.out_time || ''),
      a.leave ? '' : (a.visit_time_from || ''),
      a.leave ? '' : (a.visit_time_to || ''),
      a.leave ? '' : formatDuration(a.break_time),
      a.leave ? '' : formatLateCategory(a.late_category),
      a.half_day || '',
      a.leave ? '' : (a.total_time || ''),
      a.leave ? 'On leave' : (a.half_day ? `Half day (${a.half_day})` : 'Present')
    ])
  ];
}

async function exportRecords() {
  const btn = document.getElementById('btnExportMenu');
  btn.disabled = true;
  try {
    const attendance = await fetchRecordsForExport();
    if (!attendance) return;
    const csv = recordsToRows(attendance).map(row => row.map(csvCell).join(',')).join('\r\n');
    downloadFile(csv, `stanzahr-records-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
    showToast('CSV exported.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function exportRecordsExcel() {
  const btn = document.getElementById('btnExportMenu');
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
    showToast('Excel exported.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function exportRecordsPdf() {
  const btn = document.getElementById('btnExportMenu');
  btn.disabled = true;
  try {
    const attendance = await fetchRecordsForExport();
    if (!attendance) return;
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showToast('PDF library failed to load.', 'error');
      return;
    }
    const rows = recordsToRows(attendance);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const stamp = new Date().toISOString().slice(0, 10);

    doc.setFontSize(14);
    doc.setTextColor(26, 26, 46);
    doc.text('StanzaHR — Attendance Records', 14, 14);
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(`Exported ${stamp}`, 14, 20);

    doc.autoTable({
      head: [rows[0]],
      body: rows.slice(1),
      startY: 24,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 52, 96], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] }
    });

    doc.save(`stanzahr-records-${stamp}.pdf`);
    showToast('PDF exported.', 'success');
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
