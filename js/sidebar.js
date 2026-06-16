function initSidebar() {
  const dashboard = document.querySelector('.dashboard');
  const toggle = document.getElementById('sidebarToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!dashboard || !toggle) return;

  const mq = window.matchMedia('(max-width: 768px)');
  const storageKey = 'stanzahr_sidebar_collapsed';

  function isMobile() {
    return mq.matches;
  }

  function setDesktopCollapsed(collapsed) {
    dashboard.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!isMobile()) {
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
    }
  }

  function closeMobile() {
    dashboard.classList.remove('sidebar-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function openMobile() {
    dashboard.classList.add('sidebar-open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', () => {
    if (isMobile()) {
      if (dashboard.classList.contains('sidebar-open')) closeMobile();
      else openMobile();
      return;
    }
    setDesktopCollapsed(!dashboard.classList.contains('sidebar-collapsed'));
  });

  backdrop?.addEventListener('click', closeMobile);

  document.querySelectorAll('.sidebar .nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (isMobile()) closeMobile();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobile()) closeMobile();
  });

  function applyLayoutMode() {
    dashboard.classList.remove('sidebar-open');
    if (isMobile()) {
      dashboard.classList.remove('sidebar-collapsed');
      toggle.setAttribute('aria-expanded', 'false');
    } else {
      setDesktopCollapsed(localStorage.getItem(storageKey) === '1');
    }
  }

  applyLayoutMode();
  mq.addEventListener('change', applyLayoutMode);
}
