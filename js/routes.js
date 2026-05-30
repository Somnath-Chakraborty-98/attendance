const ROUTES = {
  login: '/login',
  dashboard: '/dashboard',
  users: '/users',
  verify: '/verify',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password'
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROUTES };
}
