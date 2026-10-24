// Thin fetch wrapper shared by all pages. Talks to the BMG backend API and stores the
// session token client-side (a JWT is not a secret to protect from the user themselves,
// but every sensitive check still happens server-side on each request).
const BMG_API_BASE = window.location.port === '4000'
    ? '' // served by the backend itself
    : window.location.protocol === 'file:'
        ? 'http://localhost:4000'
        : `${window.location.protocol}//${window.location.hostname}:4000`;

const BmgApi = (() => {
    const API_BASE_CANDIDATES = window.location.port === '4000'
        ? ['']
        : window.location.protocol === 'file:'
            ? ['http://localhost:4000', 'http://localhost:4100']
            : [BMG_API_BASE, `${window.location.protocol}//${window.location.hostname}:4100`];
    const SESSION_KEYS = {
        user: { token: 'bmg_user_token', user: 'bmg_user_data' },
        admin: { token: 'bmg_admin_token', user: 'bmg_admin_data' },
    };

    const LEGACY_SESSION_KEYS = ['bmg_token', 'bmg_user', 'adminToken', 'authToken', 'token'];

    function getCurrentRole() {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.includes('/admin') || document.body?.classList?.contains('admin-body')) return 'admin';
        return 'user';
    }

    function getStorageKeys(role = getCurrentRole()) {
        return SESSION_KEYS[role] || SESSION_KEYS.user;
    }

    function getToken(role = getCurrentRole()) {
        const { token } = getStorageKeys(role);
        const currentToken = localStorage.getItem(token);
        if (currentToken) return currentToken;

        const legacyToken = localStorage.getItem('bmg_token');
        if (legacyToken) {
            const { token: targetKey, user: targetUserKey } = getStorageKeys(role);
            localStorage.setItem(targetKey, legacyToken);
            localStorage.setItem(targetUserKey, localStorage.getItem('bmg_user') || '{}');
            return legacyToken;
        }

        for (const key of LEGACY_SESSION_KEYS) {
            const fallbackToken = localStorage.getItem(key);
            if (!fallbackToken) continue;
            const { token: targetKey, user: targetUserKey } = getStorageKeys(role);
            localStorage.setItem(targetKey, fallbackToken);
            localStorage.setItem(targetUserKey, localStorage.getItem('bmg_user') || '{}');
            localStorage.removeItem(key);
            return fallbackToken;
        }

        return null;
    }

    function setSession(token, user) {
        const role = String(user?.role || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
        const keys = getStorageKeys(role);

        localStorage.setItem(keys.token, token);
        localStorage.setItem(keys.user, JSON.stringify(user));

        localStorage.setItem('bmg_token', token);
        localStorage.setItem('bmg_user', JSON.stringify(user));

        for (const key of LEGACY_SESSION_KEYS) {
            if (key === 'bmg_token' || key === 'bmg_user') continue;
            localStorage.removeItem(key);
        }
    }

    function clearSession(role = getCurrentRole()) {
        const keys = getStorageKeys(role);
        localStorage.removeItem(keys.token);
        localStorage.removeItem(keys.user);

        if (role === 'admin' && localStorage.getItem('bmg_admin_token') === null && localStorage.getItem('bmg_admin_data') === null) {
            localStorage.removeItem('bmg_token');
            localStorage.removeItem('bmg_user');
        }
        if (role === 'user' && localStorage.getItem('bmg_user_token') === null && localStorage.getItem('bmg_user_data') === null) {
            localStorage.removeItem('bmg_token');
            localStorage.removeItem('bmg_user');
        }
    }

    function getUser(role = getCurrentRole()) {
        try {
            const keys = getStorageKeys(role);
            return JSON.parse(localStorage.getItem(keys.user) || 'null');
        } catch (err) {
            return null;
        }
    }

    async function request(path, { method = 'GET', body, auth = true } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        const token = auth ? getToken() : null;
        if (auth && token) headers.Authorization = `Bearer ${token}`;

        let response;
        let lastError;
        for (const base of API_BASE_CANDIDATES) {
            try {
                response = await fetch(`${base}/api${path}`, {
                    method,
                    headers,
                    cache: 'no-store',
                    body: body ? JSON.stringify(body) : undefined,
                });
                break;
            } catch (err) {
                lastError = err;
            }
        }
        if (!response) {
            const error = new Error('The BMG backend is unreachable on ports 4000 and 4100. In VS Code, run “Start BMG backend” and try again.');
            error.cause = lastError;
            error.status = 0;
            throw error;
        }

        const isJson = response.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await response.json().catch(() => ({})) : null;

        if (!response.ok) {
            const error = new Error((data && data.error) || `Request failed (${response.status})`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    return { request, getToken, setSession, clearSession, getUser };
})();
