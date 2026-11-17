(function () {
  const KEY = 'theme';
  const THEMES = ['light', 'dark', 'dracula', 'fugly'];
  const root = document.documentElement;
  const stored = localStorage.getItem(KEY);
  const initial = THEMES.includes(stored)
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
    const nextTheme = () => THEMES[(THEMES.indexOf(root.getAttribute('data-theme')) + 1) % THEMES.length];
    const render = () => {
      const next = nextTheme();
      toggle.textContent = `${next[0].toUpperCase()}${next.slice(1)} theme`;
      toggle.setAttribute('aria-label', `Switch to ${next} theme`);
    };
    toggle.addEventListener('click', () => {
      const next = nextTheme();
      root.setAttribute('data-theme', next);
      localStorage.setItem(KEY, next);
      render();
    });
    render();
    logout.before(toggle);
  });
}());
