function validatePassword(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('one number');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('one special character');
  return { valid: errors.length === 0, errors };
}

function passwordErrorMessage(password) {
  const { valid, errors } = validatePassword(password);
  if (valid) return null;
  return `Password must contain ${errors.join(', ')}.`;
}

function passwordHint() {
  return 'Min 8 characters with uppercase, lowercase, number, and special character.';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validatePassword, passwordErrorMessage, passwordHint };
}
