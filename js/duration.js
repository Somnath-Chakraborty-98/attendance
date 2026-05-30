function pgIntervalToMinutes(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'object' && val !== null) {
    const h = Number(val.hours || 0);
    const m = Number(val.minutes || 0);
    return h * 60 + m;
  }
  const s = String(val).trim();
  const dayMatch = s.match(/(\d+)\s+day[s]?/i);
  const timeMatch = s.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  let minutes = 0;
  if (dayMatch) minutes += Number(dayMatch[1]) * 24 * 60;
  if (timeMatch) {
    minutes += Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  }
  return minutes;
}

function durationInputToPgInterval(val) {
  if (!val) return null;
  const parts = String(val).split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10) || 0;
  const mins = parseInt(parts[1], 10) || 0;
  return `${hours}:${String(mins).padStart(2, '0')}:00`;
}

function durationToInputValue(val) {
  if (!val) return '';
  const mins = pgIntervalToMinutes(val);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(val) {
  if (!val) return '—';
  const mins = pgIntervalToMinutes(val);
  if (mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pgIntervalToMinutes,
    durationInputToPgInterval,
    durationToInputValue,
    formatDuration
  };
}
