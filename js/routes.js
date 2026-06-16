const ROUTES = {
  org: '/',
  login: '/login',
  createOrganization: '/create-organization',
  dashboard: '/app',
  users: '/app/u',
  verify: '/verify',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password'
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROUTES };
}
