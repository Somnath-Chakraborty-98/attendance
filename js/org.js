const ORG_KEY_STORAGE = 'stanzahr_org_key';
const ORG_NAME_STORAGE = 'stanzahr_org_name';
const LOGIN_ALLOWED_STORAGE = 'stanzahr_login_allowed';

function getOrgKey() {
  return sessionStorage.getItem(ORG_KEY_STORAGE) || '';
}

function getOrgName() {
  return sessionStorage.getItem(ORG_NAME_STORAGE) || '';
}

function setOrg(orgKey, orgName) {
  sessionStorage.setItem(ORG_KEY_STORAGE, orgKey);
  sessionStorage.setItem(ORG_NAME_STORAGE, orgName || '');
}

function allowLogin() {
  sessionStorage.setItem(LOGIN_ALLOWED_STORAGE, '1');
}

function clearLoginAllowed() {
  sessionStorage.removeItem(LOGIN_ALLOWED_STORAGE);
}

function isLoginAllowed() {
  return sessionStorage.getItem(LOGIN_ALLOWED_STORAGE) === '1';
}

function clearOrg() {
  sessionStorage.removeItem(ORG_KEY_STORAGE);
  sessionStorage.removeItem(ORG_NAME_STORAGE);
  clearLoginAllowed();
}

function requireOrgOrRedirect() {
  if (!getOrgKey()) {
    window.location.replace(ROUTES.org);
    return false;
  }
  return true;
}

function orgJsonHeaders(extra = {}) {
  const headers = { ...extra };
  const orgKey = getOrgKey();
  if (orgKey) headers['X-Org-Key'] = orgKey;
  return headers;
}
