/* Dashboard features: leave, reports, directory */

let leaveCache = [];

function initDashboardFeatures() {
  const year = new Date().getFullYear();
  ['lateYear', 'leaveYear', 'rptLeaveYear', 'rptLateYear'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = year;
  });

  fillMonthSelect('rptLateMonth');

  initMastersTabs();
  initLeaveForm();
  initOrgSettingsForm();
  initLateReport();
  initReports();

  document.getElementById('btnLoadLeaves')?.addEventListener('click', loadLeaveRecords);
  document.getElementById('btnCloseTimeline')?.addEventListener('click', () => {
    document.getElementById('employeeTimelinePanel').style.display = 'none';
  });

  document.getElementById('btnAddLeave')?.addEventListener('click', () => {
    document.getElementById('leaveForm').reset();
    populateFeatureDropdowns();
    document.getElementById('addLeaveForm').style.display = 'block';
  });
  document.getElementById('btnCancelLeave')?.addEventListener('click', () => {
    document.getElementById('addLeaveForm').style.display = 'none';
  });

  populateFeatureDropdowns();
  initDateFields();
}

function fillMonthSelect(id) {
  const el = document.getElementById(id);
  if (!el || el.options.length > 1) return;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = String(i + 1);
    opt.textContent = m;
    el.appendChild(opt);
  });
  el.value = String(new Date().getMonth() + 1);
}

async function populateFeatureDropdowns() {
  let departments = [];
  try {
    const data = await apiRequest('/api/departments');
    departments = data.departments || [];
  } catch (err) {
    console.error(err);
  }

  const deptOptionRows = departments.map(d =>
    `<option value="${d.id}">${escapeHtml(d.dep_name)}</option>`
  ).join('');

  const deptSelectIds = [
    ['filterDepartment', 'All Departments'],
    ['lateDepartment', 'All'],
    ['leaveDepartment', 'All'],
    ['rptAttDepartment', 'All'],
    ['rptLateDepartment', 'All']
  ];
  deptSelectIds.forEach(([id, label]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<option value="">${label}</option>${deptOptionRows}`;
  });

  const filterPairs = [
    ['filterDepartment', 'filterEmployee', 'All Employees'],
    ['lateDepartment', 'lateEmployee', 'All'],
    ['leaveDepartment', 'leaveEmployee', 'All'],
    ['rptAttDepartment', 'rptAttEmployee', 'All'],
    ['rptLateDepartment', 'rptLateEmployee', 'All']
  ];
  filterPairs.forEach(([deptId, empId, allLabel]) => {
    bindDepartmentEmployeeFilter(deptId, empId, allLabel);
  });

  const selectOpts = employeeOptionsHtml({ allLabel: 'Select Employee', selectMode: true });
  const leaveFormEl = document.getElementById('leaveFormEmployee');
  if (leaveFormEl) leaveFormEl.innerHTML = selectOpts;
}

function employeeOptionsHtml({ departmentId = '', allLabel = 'All', selectMode = false } = {}) {
  let list = employeesCache || [];
  if (departmentId) {
    list = list.filter(e => String(e.department_id) === String(departmentId));
  }
  const opts = list.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  const label = selectMode ? 'Select Employee' : allLabel;
  return `<option value="">${label}</option>${opts}`;
}

function bindDepartmentEmployeeFilter(departmentId, employeeId, allLabel = 'All') {
  const deptEl = document.getElementById(departmentId);
  const empEl = document.getElementById(employeeId);
  if (!deptEl || !empEl) return;

  const refresh = () => {
    const current = empEl.value;
    empEl.innerHTML = employeeOptionsHtml({
      departmentId: deptEl.value,
      allLabel
    });
    if ([...empEl.options].some(o => o.value === current)) empEl.value = current;
  };

  if (deptEl.dataset.filterBound !== '1') {
    deptEl.dataset.filterBound = '1';
    deptEl.addEventListener('change', refresh);
  }
  refresh();
}

async function loadPlanUsageBadge() {
  const badge = document.getElementById('planUsageBadge');
  if (!badge || !currentUser?.is_admin) return;
  try {
    const { plan } = await apiRequest('/api/organization/plan');
    const max = plan.max_employees;
    const count = plan.employee_count ?? 0;
    if (max != null) {
      badge.textContent = `${plan.plan_name} plan: ${count} / ${max} employees`;
      badge.style.display = '';
    } else {
      badge.textContent = `${plan.plan_name} plan: ${count} employees`;
      badge.style.display = '';
    }
  } catch (err) {
    badge.style.display = 'none';
  }
}

async function loadEmployeeDirectory() {
  const tbody = document.getElementById('directoryTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';
  if (currentUser?.is_admin) loadPlanUsageBadge();
  try {
    const { employees } = await apiRequest('/api/employees');
    employeesCache = employees || [];
    populateFeatureDropdowns();
    populateEmployeeDropdowns(employeesCache);

    if (!employees.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No employees</td></tr>';
      return;
    }
    tbody.innerHTML = employees.map(e => `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td>${escapeHtml(e.department_name || '—')}</td>
        <td>${formatDisplayDate(e.joining_date)}</td>
        <td>${formatDisplayDate(e.birthday)}</td>
        <td>${e.track_visit_time ? 'Yes' : 'No'}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" onclick="showEmployeeTimeline('${escapeJs(String(e.id))}')">Timeline</button>
          ${currentUser.is_admin ? `
            <button class="btn btn-sm btn-primary" onclick="editEmployeeById('${escapeJs(String(e.id))}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteEmployee('${escapeJs(String(e.id))}', '${escapeJs(e.name)}')">Delete</button>
          ` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function showEmployeeTimeline(id) {
  try {
    const data = await apiRequest(`/api/employees/${encodeURIComponent(id)}/timeline`);
    document.getElementById('timelineEmployeeName').textContent = `${data.employee.name} — Timeline`;
    const leaves = [
      ...data.leave_records.map(l => `<li><strong>${formatDisplayDate(l.start_date)}</strong> to ${formatDisplayDate(l.end_date)} — ${l.leave_type} (${l.days_count}d) ${escapeHtml(l.reason || '')}</li>`),
      ...data.attendance_leaves.map(a => `<li><strong>${formatDisplayDate(a.date)}</strong> — ${a.on_leave ? 'Full leave' : `Half: ${a.half_day}`}</li>`)
    ];
    document.getElementById('timelineContent').innerHTML = `
      <p><strong>Joining:</strong> ${formatDisplayDate(data.employee.joining_date)}
         · <strong>Birthday:</strong> ${formatDisplayDate(data.employee.birthday)}</p>
      <h4>Leave History</h4>
      <ul class="timeline-list">${leaves.length ? leaves.join('') : '<li class="text-muted">No leave history</li>'}</ul>
    `;
    document.getElementById('employeeTimelinePanel').style.display = 'block';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initMastersTabs() {
  document.querySelectorAll('[data-masters-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-masters-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (typeof activateMastersPanel === 'function') activateMastersPanel();
    });
  });
}

async function loadOrgSettings() {
  try {
    const { settings } = await apiRequest('/api/organization/settings');
    if (!settings) return;
    fillCountrySelect(document.getElementById('orgCountry'), settings.country || 'IN');
    bindCountryBillingHint(
      document.getElementById('orgCountry'),
      document.getElementById('orgBillingHint')
    );
    document.getElementById('orgWorkStart').value = settings.default_work_start_time ? String(settings.default_work_start_time).slice(0, 5) : '09:00';
    document.getElementById('orgLateMild').value = settings.late_threshold_mild;
    document.getElementById('orgLateSevere').value = settings.late_threshold_severe;
    document.getElementById('orgAnnualLeave').value = settings.default_annual_leave_days;
  } catch (err) {
    console.error(err);
  }
}

function initOrgSettingsForm() {
  document.getElementById('orgSettingsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiRequest('/api/organization/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          country: document.getElementById('orgCountry').value,
          default_work_start_time: document.getElementById('orgWorkStart').value,
          late_threshold_mild: Number(document.getElementById('orgLateMild').value),
          late_threshold_severe: Number(document.getElementById('orgLateSevere').value),
          default_annual_leave_days: Number(document.getElementById('orgAnnualLeave').value)
        })
      });
      showToast('Settings saved.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function initLeaveForm() {
  document.getElementById('leaveForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const startDate = getDateFieldIso(document.getElementById('leaveFormStart'));
    const endDate = getDateFieldIso(document.getElementById('leaveFormEnd'));
    if (!startDate || !endDate) {
      showToast('Enter valid start and end dates.', 'error');
      return;
    }
    try {
      await apiRequest('/api/leaves', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: Number(document.getElementById('leaveFormEmployee').value),
          start_date: startDate,
          end_date: endDate,
          leave_type: 'full',
          reason: document.getElementById('leaveFormReason').value.trim()
        })
      });
      showToast('Leave recorded.', 'success');
      document.getElementById('addLeaveForm').style.display = 'none';
      loadLeaveRecords();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function loadLeaveRecords() {
  const year = document.getElementById('leaveYear')?.value;
  const month = document.getElementById('leaveMonth')?.value;
  const employee_id = document.getElementById('leaveEmployee')?.value;
  const department_id = document.getElementById('leaveDepartment')?.value;
  const params = new URLSearchParams({ year });
  if (month) params.set('month', month);
  if (employee_id) params.set('employee_id', employee_id);
  if (department_id) params.set('department_id', department_id);

  const tbody = document.getElementById('leaveTableBody');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">Loading...</td></tr>';
  try {
    const data = await apiRequest(`/api/leaves?${params}`);
    leaveCache = data.leaves || [];
    if (!leaveCache.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No records</td></tr>';
      return;
    }
    tbody.innerHTML = leaveCache.map(l => `
      <tr>
        <td>${escapeHtml(l.employee_name)}</td>
        <td>${formatDisplayDate(l.start_date)}</td>
        <td>${formatDisplayDate(l.end_date)}</td>
        <td>${l.leave_type}</td>
        <td>${l.days_count}</td>
        <td>${escapeHtml(l.reason || '—')}</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteLeave('${escapeJs(String(l.id))}')">Delete</button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteLeave(id) {
  if (!confirm('Delete leave record?')) return;
  try {
    await apiRequest(`/api/leaves/${id}`, { method: 'DELETE' });
    showToast('Deleted.', 'success');
    loadLeaveRecords();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initLateTab() {
  populateFeatureDropdowns();
}

function initLateReport() {
  document.getElementById('btnLoadLate')?.addEventListener('click', async () => {
    const year = document.getElementById('lateYear').value;
    const month = document.getElementById('lateMonth').value;
    const employee_id = document.getElementById('lateEmployee').value;
    const department_id = document.getElementById('lateDepartment')?.value;
    const params = new URLSearchParams({ year });
    if (month) params.set('month', month);
    if (employee_id) params.set('employee_id', employee_id);
    if (department_id) params.set('department_id', department_id);
    const tbody = document.getElementById('lateTableBody');
    try {
      const { summary } = await apiRequest(`/api/reports/late?${params}`);
      if (!summary.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center">No late records</td></tr>';
        return;
      }
      tbody.innerHTML = summary.map(r => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${r.late_5_count}</td>
          <td>${r.late_15_count}</td>
          <td>${r.late_over_15_count}</td>
          <td>${r.total_late}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(err.message)}</td></tr>`;
    }
  });
}

function initReportTabs() {
  document.querySelectorAll('[data-report]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-report]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['attendance', 'leave', 'employees', 'late'].forEach(name => {
        document.getElementById(`report-${name}`).style.display =
          tab.dataset.report === name ? 'block' : 'none';
      });
    });
  });
}

function initReports() {
  initReportTabs();

  document.getElementById('btnRptAttendance')?.addEventListener('click', async () => {
    const from = getDateFieldIso(document.getElementById('rptAttFrom'));
    if (!from) return showToast('Select a from date', 'error');
    const params = new URLSearchParams({ date_from: from });
    const to = getDateFieldIso(document.getElementById('rptAttTo'));
    const emp = document.getElementById('rptAttEmployee').value;
    const dept = document.getElementById('rptAttDepartment')?.value;
    if (to) params.set('date_to', to);
    if (emp) params.set('employee_id', emp);
    if (dept) params.set('department_id', dept);
    try {
      const { report } = await apiRequest(`/api/reports/attendance?${params}`);
      renderReportTable('rptAttendanceOut', report, [
        'date', 'name', 'department_name', 'in_time', 'out_time', 'late_category', 'total_time', 'leave'
      ], 'attendance');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnRptLeave')?.addEventListener('click', async () => {
    const year = document.getElementById('rptLeaveYear').value;
    try {
      const { report } = await apiRequest(`/api/reports/leave?year=${year}`);
      const rows = report.employees.map(e => ({
        name: e.name,
        department: e.department_name,
        quota: e.quota,
        taken: e.taken,
        remaining: e.remaining
      }));
      const el = document.getElementById('rptLeaveOut');
      renderReportTable('rptLeaveOut', rows, ['name', 'department', 'quota', 'taken', 'remaining'], 'leave');
      if (report.monthly?.length && el) {
        const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthlyHtml = `<h4 style="margin:1.5rem 0 0.5rem;">Monthly leave days (${year})</h4>
          <div class="table-container"><table class="table"><thead><tr><th>Month</th><th>Days</th></tr></thead><tbody>
          ${report.monthly.map(m => `<tr><td>${monthNames[m.month] || m.month}</td><td>${m.days}</td></tr>`).join('')}
          </tbody></table></div>`;
        el.insertAdjacentHTML('beforeend', monthlyHtml);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnRptEmployees')?.addEventListener('click', async () => {
    try {
      const { report } = await apiRequest('/api/reports/employees');
      renderReportTable('rptEmployeesOut', report, [
        'name', 'department_name', 'mobile', 'email_id', 'joining_date', 'birthday', 'track_visit_time'
      ], 'employees');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnRptLate')?.addEventListener('click', async () => {
    const year = document.getElementById('rptLateYear').value;
    const month = document.getElementById('rptLateMonth').value;
    const emp = document.getElementById('rptLateEmployee')?.value;
    const dept = document.getElementById('rptLateDepartment')?.value;
    const params = new URLSearchParams({ year });
    if (month) params.set('month', month);
    if (emp) params.set('employee_id', emp);
    if (dept) params.set('department_id', dept);
    try {
      const { summary } = await apiRequest(`/api/reports/late?${params}`);
      renderReportTable('rptLateOut', summary, [
        'name', 'late_5_count', 'late_15_count', 'late_over_15_count', 'total_late'
      ], 'late');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

let lastReportExport = null;

function renderReportTable(containerId, rows, cols, title) {
  const el = document.getElementById(containerId);
  if (!rows?.length) {
    el.innerHTML = '<p class="text-muted">No data</p>';
    return;
  }
  lastReportExport = { rows, cols, title };
  const headers = cols.map(c => c.replace(/_/g, ' '));
  let html = `<div class="report-toolbar">
    <button type="button" class="btn btn-sm btn-secondary" id="btnExportReportCsv">Export CSV</button>
  </div><div class="table-container"><table class="table"><thead><tr>
    ${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}
  </tr></thead><tbody>`;
  rows.forEach(r => {
    html += '<tr>' + cols.map(c => {
      let v = r[c];
      if (c === 'leave') v = v ? 'On leave' : 'Present';
      if (c === 'track_visit_time') v = v ? 'Yes' : 'No';
      if (c === 'total_time' && typeof formatTotalTime === 'function') {
        v = formatTotalTime(v, r.in_time, r.out_time, r.break_time);
      }
      if (c === 'in_time' || c === 'out_time') v = v ? String(v).slice(0, 5) : v;
      if (DATE_FIELD_COLUMNS.has(c)) v = formatDateValueForDisplay(v);
      return `<td>${escapeHtml(v ?? '—')}</td>`;
    }).join('') + '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
  el.querySelector('#btnExportReportCsv')?.addEventListener('click', () => exportReportData(lastReportExport, 'csv'));
}

function exportReportData({ rows, cols, title }, format) {
  if (!rows?.length || format !== 'csv') return;
  const header = cols;
  const dataRows = rows.map(r => cols.map(c => {
    let v = r[c];
    if (c === 'leave') return v ? 'On leave' : 'Present';
    if (DATE_FIELD_COLUMNS.has(c)) return formatDateValueForDisplay(v) ?? '';
    return v ?? '';
  }));
  const stamp = formatDisplayDate(todayIsoDate(), '').replace(/-/g, '');
  const csv = [header, ...dataRows].map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadFile(csv, `stanzahr-${title}-${stamp}.csv`, 'text/csv');
  showToast('Exported.', 'success');
}
