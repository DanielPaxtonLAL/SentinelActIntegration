(function () {
  const KEY = 'theme';
  const root = document.documentElement;
  const stored = localStorage.getItem(KEY);
  const initial = stored === 'light' || stored === 'dark'
    ? stored
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.setAttribute('data-theme', initial);

  document.addEventListener('DOMContentLoaded', () => {
    const logout = [...document.querySelectorAll('.header-actions button')]
      .find((button) => button.textContent.trim() === 'Log out');
    if (!logout) return;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'theme-toggle';
    const render = () => {
      const dark = root.getAttribute('data-theme') === 'dark';
      toggle.textContent = dark ? 'Light theme' : 'Dark theme';
      toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    };
    toggle.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem(KEY, next);
      render();
    });
    render();
    logout.before(toggle);
  });
}());
