const form = document.querySelector('#loginForm');
const button = document.querySelector('#submitButton');
const status = document.querySelector('#status');
const loginDots = document.querySelector('#loginDots');
const configureButton = document.querySelector('#configureButton');
const actFields = document.querySelector('#actCredentials');
const continueLink = document.querySelector('#continueLink');
const savedActHint = document.querySelector('#savedActHint');
let emsMode = null;
const storageKeyFor = (username) => `act-credentials:v2:${emsMode}:${username}`;
function savedCredentialsFor(username) {
  return localStorage.getItem(storageKeyFor(username)) ||
    (emsMode === 'production' ? localStorage.getItem(`act-credentials:v1:${username}`) : null);
}

function updateConfigureButton() {
  let saved = false;
  try {
    const username = form.elements.username.value;
    saved = Boolean(emsMode && username && savedCredentialsFor(username));
  } catch (err) {
    status.textContent = 'Could not check saved Act! credentials: ' + err.message;
    status.classList.add('error');
  }
  const configuring = !actFields.hidden;
  configureButton.classList.toggle('login-configure-saved', saved && !configuring);
  configureButton.textContent = configuring
    ? (saved ? 'Use saved Act! login' : 'Cancel Act! setup')
    : (saved ? 'Change saved Act! login' : 'Configure Act! login');
  savedActHint.hidden = !saved || configuring;
}

function setConfigure(enabled) {
  actFields.hidden = !enabled;
  configureButton.setAttribute('aria-expanded', String(enabled));
  form.elements.actUsername.required = enabled;
  form.elements.actPassword.required = enabled;
  if (!enabled) {
    form.elements.actUsername.value = '';
    form.elements.actPassword.value = '';
  }
  updateConfigureButton();
}

configureButton.addEventListener('click', () => setConfigure(actFields.hidden));
form.elements.username.addEventListener('input', updateConfigureButton);
form.elements.username.addEventListener('change', updateConfigureButton);
updateConfigureButton();

async function checkSession() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (!['test', 'production'].includes(data.emsMode)) throw new Error('Invalid EMS server mode.');
    emsMode = data.emsMode;
    updateConfigureButton();
    if (data.authenticated) window.location.replace('/');
  } catch (err) {
    status.textContent = 'Could not check the EMS session: ' + err.message;
    status.classList.add('error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Preparing Act! credentials';
  let dots = 1;
  loginDots.textContent = '.';
  loginDots.hidden = false;
  const dotsTimer = setInterval(() => {
    dots = dots % 3 + 1;
    loginDots.textContent = '.'.repeat(dots);
  }, 500);
  status.classList.remove('error');
  const fields = new FormData(form);
  try {
    await sessionReady;
    if (!emsMode) await checkSession();
    if (!emsMode) throw new Error('Could not determine the EMS server mode. Reload the page and try again.');
    const username = fields.get('username');
    const password = fields.get('password');
    const storageKey = storageKeyFor(username);
    let act;
    let encrypted;
    if (!actFields.hidden) {
      act = { username: fields.get('actUsername'), password: fields.get('actPassword') };
      if (!act.username.trim() || !act.password) throw new Error('Enter the Act! username and password.');
      encrypted = await loginCredentials.encrypt(username, password, act);
    } else {
      const saved = savedCredentialsFor(username);
      if (!saved) {
        setConfigure(true);
        throw new Error('No Act! login is saved for this EMS username. Enter the Act! credentials below.');
      }
      try {
        act = await loginCredentials.decrypt(username, password, saved);
      } catch (err) {
        if (!globalThis.crypto?.subtle && !globalThis.Worker) throw err;
        throw new Error('Could not unlock the saved Act! login. Check your EMS password or configure Act! login again.');
      }
      if (!localStorage.getItem(storageKey)) encrypted = saved;
    }
    const progressId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    let active = true;
    let checking = false;
    status.textContent = 'Connecting to EMS and Act!';
    const progressTimer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const progress = await fetch('/api/login-progress', {
          headers: { 'X-Login-Progress': progressId },
          cache: 'no-store',
        });
        if (!progress.ok) throw new Error(`HTTP ${progress.status}`);
        const { phase } = await progress.json();
        if (!['waiting', 'ems', 'act', 'serial'].includes(phase)) throw new Error('Invalid login progress response');
        if (active && phase === 'ems') status.textContent = 'Signing in to EMS';
        if (active && phase === 'act') status.textContent = 'Signing in to Act!';
        if (active && phase === 'serial') status.textContent = 'Checking the next serial number';
      } catch (err) {
        if (active) {
          status.textContent = 'Signing in to EMS and Act! (progress unavailable)';
          console.warn('Login progress unavailable:', err.message);
        }
      } finally {
        checking = false;
      }
    }, 500);
    let response;
    try {
      response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          actUsername: act.username,
          actPassword: act.password,
          emsMode,
          progressId,
        }),
      });
    } finally {
      active = false;
      clearInterval(progressTimer);
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    form.elements.password.value = '';
    form.elements.actPassword.value = '';
    if (encrypted) {
      try {
        localStorage.setItem(storageKey, encrypted);
      } catch (err) {
        status.textContent = 'Logged in, but this browser could not save the encrypted Act! credentials. Configure them again next time.';
        status.classList.add('error');
        continueLink.hidden = false;
        return;
      }
    }
    window.location.replace('/');
  } catch (err) {
    form.elements.password.value = '';
    form.elements.actPassword.value = '';
    status.textContent = 'Log in failed: ' + err.message;
    status.classList.add('error');
    button.disabled = false;
  } finally {
    clearInterval(dotsTimer);
    loginDots.hidden = true;
  }
});

const sessionReady = checkSession();
