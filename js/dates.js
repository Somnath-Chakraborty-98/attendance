const DATE_DISPLAY_RE = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
const DATE_ISO_RE = /^(\d{4}-\d{2}-\d{2})/;

const DATE_FIELD_COLUMNS = new Set([
  'date', 'start_date', 'end_date', 'joining_date', 'birthday'
]);

function parseIsoDate(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'string') {
    const iso = val.match(DATE_ISO_RE);
    if (iso) return iso[1];
    return parseDisplayDate(val);
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return '';
}

function parseDisplayDate(str) {
  if (!str) return '';
  const trimmed = String(str).trim();
  const display = trimmed.match(DATE_DISPLAY_RE);
  if (display) {
    const day = Number(display[1]);
    const month = Number(display[2]);
    const year = Number(display[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const iso = trimmed.match(DATE_ISO_RE);
  return iso ? iso[1] : '';
}

function formatDisplayDate(val, empty = '—') {
  const iso = parseIsoDate(val);
  if (!iso) return empty === null ? '' : empty;
  const parts = iso.split('-');
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
    return empty === null ? '' : empty;
  }
  const [y, mo, d] = parts;
  return `${d}-${mo}-${y}`;
}

function todayIsoDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setDateField(el, val) {
  if (!el) return;
  el.value = parseIsoDate(val) || '';
}

function getDateFieldIso(el) {
  if (!el) return '';
  return parseIsoDate(el.value) || '';
}

function formatDateValueForDisplay(val) {
  if (val == null || val === '') return val;
  const iso = parseIsoDate(val);
  return iso ? formatDisplayDate(iso, '') : val;
}

function initDateFields() {
  const attDate = document.getElementById('attDate');
  if (!attDate || attDate.dataset.dateBound === '1') return;
  attDate.dataset.dateBound = '1';
  attDate.addEventListener('change', () => {
    if (typeof showTodayAttendance === 'function') showTodayAttendance();
  });
}
