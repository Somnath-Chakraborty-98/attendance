const ORG_KEY_STORAGE = 'stanzahr_org_key';
const ORG_NAME_STORAGE = 'stanzahr_org_name';
const ORG_READY_STORAGE = 'stanzahr_org_ready';

function getOrgKey() {
  return sessionStorage.getItem(ORG_KEY_STORAGE) || '';
}

function getOrgName() {
  return sessionStorage.getItem(ORG_NAME_STORAGE) || '';
}

function setOrg(orgKey, orgName) {
  sessionStorage.setItem(ORG_KEY_STORAGE, orgKey);
  sessionStorage.setItem(ORG_NAME_STORAGE, orgName || '');
  sessionStorage.setItem(ORG_READY_STORAGE, '1');
}

function clearOrg() {
  sessionStorage.removeItem(ORG_KEY_STORAGE);
  sessionStorage.removeItem(ORG_NAME_STORAGE);
  sessionStorage.removeItem(ORG_READY_STORAGE);
}

function isOrgReady() {
  return Boolean(getOrgKey() && sessionStorage.getItem(ORG_READY_STORAGE));
}

function requireOrgOrRedirect() {
  if (!isOrgReady()) {
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
