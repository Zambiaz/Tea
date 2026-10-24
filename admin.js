// BMG Admin Panel logic. Every write goes through the backend API (see api.js) and every
// sensitive action is re-checked and audited server-side; this file only renders results.
function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = String(value ?? '');
    return element.innerHTML;
}

function removeVisibleBrand(value) {
    return String(value ?? '').replace(/\bcoffee\s+planet\b/gi, 'our company').trim();
}

function askConfirmation({ title, message, requireReason = false }) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const messageEl = document.getElementById('confirmModalMessage');
    const reasonField = document.getElementById('confirmReasonField');
    const reasonInput = document.getElementById('confirmModalReason');
    const errorEl = document.getElementById('confirmModalError');
    const confirmButton = document.getElementById('confirmModalConfirm');
    const cancelButton = document.getElementById('confirmModalCancel');
    if (!modal || !titleEl || !messageEl || !confirmButton || !cancelButton) return Promise.resolve(null);

    titleEl.textContent = title;
    messageEl.textContent = message;
    reasonField.hidden = !requireReason;
    reasonInput.value = '';
    errorEl.textContent = '';
    modal.hidden = false;

    return new Promise((resolve) => {
        const close = (result) => {
            modal.hidden = true;
            confirmButton.onclick = null;
            cancelButton.onclick = null;
            resolve(result);
        };
        cancelButton.onclick = () => close(null);
        confirmButton.onclick = () => {
            const reason = reasonInput.value.trim();
            if (requireReason && !reason) {
                errorEl.textContent = 'A reason is required.';
                return;
            }
            close(requireReason ? { reason } : true);
        };
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const loginGate = document.getElementById('adminLoginGate');
    const adminShell = document.getElementById('adminShell');
    const loginForm = document.getElementById('adminLoginForm');
    const loginStatus = document.getElementById('adminLoginStatus');
    const loginCountry = document.getElementById('adminLoginCountry');
    const loginQuery = new URLSearchParams(window.location.search);
    const linkedCountryCode = (loginQuery.get('country') || loginQuery.get('countryCode') || '').trim().toUpperCase();

    if (loginCountry) {
        BmgApi.request('/countries', { auth: false }).then(({ countries }) => {
            const enabledCountries = countries.filter((country) => country.enabled);
            loginCountry.replaceChildren(new Option('Choose country', ''));
            enabledCountries.forEach((country) => {
                loginCountry.add(new Option(`${country.name} (${country.dialCode})`, country.code));
            });
            if (enabledCountries.some((country) => country.code === linkedCountryCode)) {
                loginCountry.value = linkedCountryCode;
            }
        }).catch((error) => {
            loginCountry.replaceChildren(new Option('Countries could not be loaded', ''));
            loginStatus.textContent = error.message || 'Could not load countries.';
            loginStatus.className = 'form-status error';
        });
    }

    function showShell() {
        loginGate.hidden = true;
        adminShell.hidden = false;
        initAdminPanel();
    }

    function showLoginGate() {
        loginGate.hidden = false;
        adminShell.hidden = true;
    }

    async function tryResumeSession() {
        if (!BmgApi.getToken()) return showLoginGate();
        try {
            const { user } = await BmgApi.request('/auth/me');
            if (user.role !== 'admin') throw new Error('Not an admin account');
            showShell();
        } catch (err) {
            BmgApi.clearSession();
            showLoginGate();
        }
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const identifier = document.getElementById('adminLoginPhone').value.trim();
            const password = document.getElementById('adminLoginPassword').value;
            const isEmail = identifier.includes('@');
            if (!isEmail && !loginCountry.value) {
                loginStatus.textContent = 'Choose the country registered to this phone number.';
                loginStatus.className = 'form-status error';
                return;
            }
            try {
                const { token, user } = await BmgApi.request('/auth/login', {
                    auth: false,
                    method: 'POST',
                    body: {
                        phoneNumber: identifier,
                        password,
                        ...(isEmail ? {} : { countryCode: loginCountry.value }),
                    },
                });
                if (user.role !== 'admin') {
                    loginStatus.textContent = 'This account does not have admin access. Ask an administrator to grant it first.';
                    loginStatus.className = 'form-status error';
                    return;
                }
                BmgApi.setSession(token, user);
                showShell();
            } catch (err) {
                loginStatus.textContent = err.status === 401
                    ? 'Invalid phone number/email or password.'
                    : (err.message || 'Something went wrong. Please try again.');
                loginStatus.className = 'form-status error';
            }
        });
    }

    tryResumeSession();

    // --- Everything below only runs once an admin session is confirmed ---
    let initialized = false;
    function initAdminPanel() {
        if (initialized) return;
        initialized = true;

        const navItems = document.querySelectorAll('.admin-nav-item');
        const sections = document.querySelectorAll('.admin-section');
        let liveUsersRefresh = null;
        let overviewRefresh = null;

        const adminPromoterEvents = new EventSource(`${BMG_API_BASE}/api/promoters/events?token=${encodeURIComponent(BmgApi.getToken())}`);
        adminPromoterEvents.addEventListener('PROMOTER_DELETED', () => loadPromoters());
        adminPromoterEvents.addEventListener('PROMOTER_COMMENT_CREATED', () => loadPromoters());
        adminPromoterEvents.addEventListener('PROMOTER_COMMENT_UPDATED', () => loadPromoters());
        adminPromoterEvents.addEventListener('PROMOTER_COMMENT_DELETED', () => loadPromoters());

        navItems.forEach((item) => {
            item.addEventListener('click', () => {
                const target = item.dataset.adminTab;
                sections.forEach((section) => section.classList.toggle('is-active', section.dataset.adminSection === target));
                navItems.forEach((nav) => nav.classList.toggle('is-active', nav === item));
                if (target === 'promoters') loadPromoters();
                if (target === 'audit-log') loadAuditLog();
                if (target === 'overview') {
                    loadOverview();
                    if (overviewRefresh) window.clearInterval(overviewRefresh);
                    overviewRefresh = window.setInterval(loadOverview, 30000);
                } else if (overviewRefresh) {
                    window.clearInterval(overviewRefresh);
                    overviewRefresh = null;
                }
                if (target === 'active-users') loadActiveUsers();
                if (target === 'users') loadUsersDirectory();
                if (target === 'live-users') {
                    loadLiveUsers();
                    if (liveUsersRefresh) window.clearInterval(liveUsersRefresh);
                    liveUsersRefresh = window.setInterval(loadLiveUsers, 10000);
                } else if (liveUsersRefresh) {
                    window.clearInterval(liveUsersRefresh);
                    liveUsersRefresh = null;
                }
                if (target === 'chakin-settings') loadChakinCheckins();
                if (target === 'giftcode-settings') loadGiftCodes();
                if (target === 'country-settings') loadCountrySettings();
            });
        });

        document.querySelectorAll('[data-admin-open]').forEach((button) => {
            button.addEventListener('click', () => {
                const target = button.dataset.adminOpen;
                const targetNav = document.querySelector(`[data-admin-tab="${target}"]`);
                if (targetNav) targetNav.click();
            });
        });

        const logoutBtn = document.getElementById('adminLogoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                if (overviewRefresh) window.clearInterval(overviewRefresh);
                if (liveUsersRefresh) window.clearInterval(liveUsersRefresh);
                adminPromoterEvents.close();
                BmgApi.clearSession();
                showLoginGate();
            });
        }

        // ---------- Overview ----------
        async function loadOverview() {
            try {
                const [overview, products, depositSettings] = await Promise.all([
                    BmgApi.request('/overview'),
                    BmgApi.request('/products/all'),
                    BmgApi.request('/settings/deposit'),
                ]);

                document.getElementById('overviewActiveProducts').textContent = products.products.filter((p) => p.status === 'active').length;
                document.getElementById('statProducts').textContent = overview.totalProducts;
                document.getElementById('overviewTotalUsers').textContent = Number(overview.totalUsers || 0).toLocaleString();
                document.getElementById('overviewActivePurchasers').textContent = Number(overview.activePurchasers || 0).toLocaleString();
                document.getElementById('overviewLiveUsers').textContent = Number(overview.liveUsers || 0).toLocaleString();
                document.getElementById('overviewPromoters').textContent = Number(overview.totalPromoters || 0).toLocaleString();
                document.getElementById('overviewTotalProducts').textContent = Number(overview.totalProducts || 0).toLocaleString();
                document.getElementById('overviewPendingDeposits').textContent = Number(overview.pendingDeposits || 0).toLocaleString();
                document.getElementById('overviewPendingWithdrawals').textContent = Number(overview.pendingWithdrawals || 0).toLocaleString();
                document.getElementById('overviewCurrencySummary').innerHTML = (overview.moneyByCurrency || []).map((item) => `
                    <tr>
                        <td>${escapeHtml(item.currency)}</td>
                        <td>${Number(item.deposits || 0).toLocaleString()} ${escapeHtml(item.currency)}</td>
                        <td>${Number(item.withdrawals || 0).toLocaleString()} ${escapeHtml(item.currency)}</td>
                        <td>${Number(item.remainingFunds || 0).toLocaleString()} ${escapeHtml(item.currency)}</td>
                        <td>${Number(item.userBalances || 0).toLocaleString()} ${escapeHtml(item.currency)}</td>
                    </tr>
                `).join('') || '<tr><td colspan="5">No financial activity yet.</td></tr>';
                document.getElementById('overviewGiftTotal').textContent = overview.giftCodes.total;
                document.getElementById('overviewGiftActive').textContent = overview.giftCodes.active;
                document.getElementById('overviewGiftInactive').textContent = overview.giftCodes.inactive;
                document.getElementById('overviewMtnStatus').textContent = depositSettings.value?.mtn?.enabled ? 'Enabled' : 'Disabled';
                document.getElementById('overviewAirtelStatus').textContent = depositSettings.value?.airtel?.enabled ? 'Enabled' : 'Disabled';
            } catch (err) {
                console.error('[BMG admin overview] Failed to load:', err);
            }
        }
        loadOverview();
        overviewRefresh = window.setInterval(loadOverview, 30000);

        let usersDirectoryPage = 1;
        const usersDirectoryPageSize = 50;

        function usersDirectoryQuery() {
            const query = new URLSearchParams();
            const values = {
                search: document.getElementById('usersDirectorySearch').value.trim(),
                status: document.getElementById('usersDirectoryStatus').value,
                role: document.getElementById('usersDirectoryRole').value,
                type: document.getElementById('usersDirectoryType').value,
                country: document.getElementById('usersDirectoryCountry').value,
                activity: document.getElementById('usersDirectoryActivity').value,
                page: String(usersDirectoryPage),
                limit: String(usersDirectoryPageSize),
            };
            Object.entries(values).forEach(([key, value]) => {
                if (value) query.set(key, value);
            });
            return query;
        }

        async function loadUsersDirectory() {
            const tableBody = document.getElementById('usersDirectoryTableBody');
            const status = document.getElementById('usersDirectoryStatusMessage');
            const query = usersDirectoryQuery();
            status.textContent = 'Loading accounts...';
            status.className = 'form-status';
            try {
                const result = await BmgApi.request(`/users/directory?${query.toString()}`);
                const users = result.users || [];
                tableBody.innerHTML = users.length ? users.map((user) => `
                    <tr>
                        <td><strong>${escapeHtml(user.fullName)}</strong><br><small>${escapeHtml(user.phoneNumber)} · ${escapeHtml(user.country)} · ${escapeHtml(user.referralCode || 'No referral code')}</small></td>
                        <td>${escapeHtml(user.role)}<br><small>${escapeHtml(user.type)}</small></td>
                        <td><span class="user-status-pill user-status-${escapeHtml(user.status.toLowerCase())}">${escapeHtml(user.status)}</span></td>
                        <td>${Number(user.balance || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.deposits || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.withdrawals || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.productPurchases || 0).toLocaleString()}</td>
                        <td>${Number(user.referrals || 0).toLocaleString()}</td>
                        <td><span class="admin-live-indicator ${user.isLive ? '' : 'admin-offline-indicator'}">${escapeHtml(user.activityStatus)}</span><br><small>${escapeHtml(user.lastActiveAt || user.createdAt || 'Never')}</small></td>
                        <td>${escapeHtml(user.currentPage || '—')}</td>
                        <td><div class="users-directory-actions">
                            <button type="button" class="btn btn-secondary btn-sm" data-user-action="view" data-user-id="${escapeHtml(user.id)}">View</button>
                            ${user.role === 'user' ? `
                                <button type="button" class="btn btn-secondary btn-sm" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Edit</button>
                                <button type="button" class="btn btn-secondary btn-sm" data-user-action="reset" data-user-id="${escapeHtml(user.id)}" data-user-name="${escapeHtml(user.fullName)}">Reset password</button>
                                <button type="button" class="btn btn-secondary btn-sm" data-user-action="status" data-user-id="${escapeHtml(user.id)}" data-user-status="${escapeHtml(user.status)}">${user.status === 'Active' ? 'Suspend' : 'Activate'}</button>
                                <button type="button" class="btn btn-danger btn-sm" data-user-action="delete" data-user-id="${escapeHtml(user.id)}" data-user-name="${escapeHtml(user.fullName)}">Delete</button>
                            ` : ''}
                        </div></td>
                    </tr>
                `).join('') : '<tr><td colspan="11">No accounts match these filters.</td></tr>';
                document.getElementById('usersTotalBadge').textContent = `${Number(result.total || 0).toLocaleString()} accounts`;
                const first = result.total ? ((result.page - 1) * result.limit) + 1 : 0;
                const last = Math.min(result.page * result.limit, result.total);
                document.getElementById('usersPaginationSummary').textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${Number(result.total || 0).toLocaleString()} · Page ${result.page} of ${Math.max(result.totalPages, 1)}`;
                document.getElementById('usersPreviousPage').disabled = result.page <= 1;
                document.getElementById('usersNextPage').disabled = result.page >= result.totalPages;
                status.textContent = `${Number(result.total || 0).toLocaleString()} account${result.total === 1 ? '' : 's'} found.`;
            } catch (error) {
                tableBody.innerHTML = '<tr><td colspan="11">Could not load accounts.</td></tr>';
                document.getElementById('usersTotalBadge').textContent = 'Accounts unavailable';
                status.textContent = error.message || 'Could not load accounts.';
                status.className = 'form-status error';
            }
        }

        async function showUserDetails(userId) {
            const modal = document.getElementById('userDetailModal');
            const content = document.getElementById('userDetailContent');
            content.innerHTML = '<p>Loading user details...</p>';
            modal.hidden = false;
            try {
                const { user, financial, products = [], team, tasks } = await BmgApi.request(`/users/${encodeURIComponent(userId)}`);
                document.getElementById('userDetailTitle').textContent = user.fullName;
                const currency = user.currency || user.country?.currency || '';
                content.innerHTML = `
                    <div class="user-detail-summary">
                        <div><span>Phone</span><strong>${escapeHtml(user.phoneNumber)}</strong></div>
                        <div><span>Country</span><strong>${escapeHtml(user.country?.flag || '')} ${escapeHtml(user.country?.name || 'Unknown')}</strong></div>
                        <div><span>Role / status</span><strong>${escapeHtml(user.role)} · ${escapeHtml(user.status)}</strong></div>
                        <div><span>Balance</span><strong>${Number(user.balance || 0).toLocaleString()} ${escapeHtml(currency)}</strong></div>
                        <div><span>Referral code</span><strong>${escapeHtml(user.referralCode || '—')}</strong></div>
                        <div><span>Joined</span><strong>${escapeHtml(user.createdAt || '—')}</strong></div>
                        <div><span>Deposits</span><strong>${financial.deposits.length.toLocaleString()}</strong></div>
                        <div><span>Withdrawals</span><strong>${financial.withdrawals.length.toLocaleString()}</strong></div>
                        <div><span>Products</span><strong>${products.length.toLocaleString()}</strong></div>
                        <div><span>Referrals</span><strong>${team.referrals.length.toLocaleString()}</strong></div>
                        <div><span>Tasks</span><strong>${tasks.length.toLocaleString()}</strong></div>
                    </div>
                    <div class="user-detail-history">
                        <h3>Product purchases</h3>
                        <div class="admin-data-table-wrap"><table class="admin-data-table">
                            <thead><tr><th>Product</th><th>Price</th><th>Status</th><th>Date</th></tr></thead>
                            <tbody>${products.slice(0, 10).map((item) => `<tr><td>${escapeHtml(item.name || 'Product')}</td><td>${Number(item.price || 0).toLocaleString()} ${escapeHtml(currency)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.created_at)}</td></tr>`).join('') || '<tr><td colspan="4">No product purchases yet.</td></tr>'}</tbody>
                        </table></div>
                    </div>
                    <div class="user-detail-history">
                        <h3>Recent financial activity</h3>
                        <div class="admin-data-table-wrap"><table class="admin-data-table">
                            <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
                            <tbody>${[...financial.deposits.map((item) => ({ ...item, kind: 'Deposit' })), ...financial.withdrawals.map((item) => ({ ...item, kind: 'Withdrawal' }))]
                                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                                .slice(0, 10)
                                .map((item) => `<tr><td>${item.kind} · ${escapeHtml(item.method)}</td><td>${Number(item.amount || 0).toLocaleString()} ${escapeHtml(currency)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.created_at)}</td></tr>`)
                                .join('') || '<tr><td colspan="4">No financial activity yet.</td></tr>'}</tbody>
                        </table></div>
                    </div>
                `;
            } catch (error) {
                content.innerHTML = `<p class="form-status error">${escapeHtml(error.message || 'Could not load user details.')}</p>`;
            }
        }

        function openUserEdit(user) {
            document.getElementById('userEditId').value = user.id;
            document.getElementById('userEditName').value = user.fullName;
            document.getElementById('userEditPhone').value = user.phoneNumber;
            document.getElementById('userEditCountryNote').textContent = `Country is kept as ${user.country} (${user.currency}) so the account's existing currency and transaction history remain unchanged.`;
            document.getElementById('userEditStatus').textContent = '';
            document.getElementById('userEditStatus').className = 'form-status';
            document.getElementById('userEditModal').hidden = false;
        }

        document.getElementById('usersDirectoryForm').addEventListener('submit', (event) => {
            event.preventDefault();
            usersDirectoryPage = 1;
            loadUsersDirectory();
        });
        document.getElementById('clearUsersDirectory').addEventListener('click', () => {
            document.getElementById('usersDirectoryForm').reset();
            usersDirectoryPage = 1;
            loadUsersDirectory();
        });
        document.getElementById('usersPreviousPage').addEventListener('click', () => {
            if (usersDirectoryPage > 1) {
                usersDirectoryPage -= 1;
                loadUsersDirectory();
            }
        });
        document.getElementById('usersNextPage').addEventListener('click', () => {
            usersDirectoryPage += 1;
            loadUsersDirectory();
        });
        document.getElementById('usersDirectoryTableBody').addEventListener('click', async (event) => {
            const button = event.target.closest('[data-user-action]');
            if (!button) return;
            const userId = button.dataset.userId;
            const action = button.dataset.userAction;
            button.disabled = true;
            try {
                if (action === 'view') {
                    await showUserDetails(userId);
                } else if (action === 'edit') {
                    const { user } = await BmgApi.request(`/users/${encodeURIComponent(userId)}`);
                    openUserEdit(user);
                } else if (action === 'reset') {
                    const confirmed = await askConfirmation({
                        title: 'Reset user password?',
                        message: `A temporary password will be created for ${button.dataset.userName}. It will be shown once after the reset.`,
                    });
                    if (!confirmed) return;
                    const { temporaryPassword } = await BmgApi.request(`/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST' });
                    const status = document.getElementById('usersDirectoryStatusMessage');
                    status.textContent = `Temporary password for ${button.dataset.userName}: ${temporaryPassword} — copy it now; it will not be shown again.`;
                    status.className = 'form-status success';
                } else if (action === 'status') {
                    const nextStatus = button.dataset.userStatus === 'Active' ? 'Suspended' : 'Active';
                    const confirmed = await askConfirmation({
                        title: nextStatus === 'Active' ? 'Activate account?' : 'Suspend account?',
                        message: `Change ${button.dataset.userName || 'this account'} to ${nextStatus}? The user's current sessions will be revoked.`,
                    });
                    if (!confirmed) return;
                    await BmgApi.request(`/users/${encodeURIComponent(userId)}/status`, { method: 'POST', body: { status: nextStatus, reason: 'Changed from Admin Users directory' } });
                    await loadUsersDirectory();
                } else if (action === 'delete') {
                    const confirmed = await askConfirmation({
                        title: 'Delete account and data?',
                        message: `Permanently delete ${button.dataset.userName} and its associated transactions, deposits, withdrawals, purchases, and rewards? This cannot be undone.`,
                    });
                    if (!confirmed) return;
                    await BmgApi.request(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
                    await loadUsersDirectory();
                }
            } catch (error) {
                const status = document.getElementById('usersDirectoryStatusMessage');
                status.textContent = error.message || 'Could not complete the user action.';
                status.className = 'form-status error';
            } finally {
                if (button.isConnected) button.disabled = false;
            }
        });
        document.getElementById('userEditForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = document.getElementById('userEditStatus');
            if (!event.currentTarget.reportValidity()) return;
            status.textContent = 'Saving changes...';
            try {
                await BmgApi.request(`/users/${encodeURIComponent(document.getElementById('userEditId').value)}`, {
                    method: 'PUT',
                    body: {
                        fullName: document.getElementById('userEditName').value.trim(),
                        phoneNumber: document.getElementById('userEditPhone').value.trim(),
                    },
                });
                status.textContent = 'User updated.';
                status.className = 'form-status success';
                await loadUsersDirectory();
                window.setTimeout(() => { document.getElementById('userEditModal').hidden = true; }, 500);
            } catch (error) {
                status.textContent = error.message || 'Could not update user.';
                status.className = 'form-status error';
            }
        });
        document.querySelectorAll('[data-close-user-detail]').forEach((button) => button.addEventListener('click', () => {
            document.getElementById('userDetailModal').hidden = true;
        }));
        document.querySelectorAll('[data-close-user-edit]').forEach((button) => button.addEventListener('click', () => {
            document.getElementById('userEditModal').hidden = true;
        }));

        async function loadActiveUsers() {
            const tableBody = document.getElementById('activeUsersTableBody');
            const status = document.getElementById('activeUsersStatusMessage');
            const query = new URLSearchParams();
            const search = document.getElementById('activeUsersSearch').value.trim();
            const accountStatus = document.getElementById('activeUsersStatus').value;
            const role = document.getElementById('activeUsersRole').value;
            const activity = document.getElementById('activeUsersActivity').value;
            if (search) query.set('search', search);
            if (accountStatus) query.set('status', accountStatus);
            if (role) query.set('role', role);
            if (activity && activity !== 'all') query.set('activity', activity);
            status.textContent = 'Loading active users...';
            status.className = 'form-status';
            try {
                const { users, total } = await BmgApi.request(`/users/active?${query.toString()}`);
                tableBody.innerHTML = users.length ? users.map((user) => `
                    <tr>
                        <td><strong>${escapeHtml(user.fullName)}</strong><br><small>${escapeHtml(user.phoneNumber)} · ${escapeHtml(user.country)}</small></td>
                        <td>${escapeHtml(user.status)} · ${escapeHtml(user.role)}</td>
                        <td>${Number(user.balance || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.deposits || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.withdrawals || 0).toLocaleString()} ${escapeHtml(user.currency)}</td>
                        <td>${Number(user.productPurchases || 0).toLocaleString()}</td>
                        <td>${escapeHtml(user.referrerName || '—')}</td>
                        <td>${escapeHtml(user.lastActiveAt || '—')}</td>
                        <td><span class="admin-live-indicator ${user.isLive ? '' : 'admin-offline-indicator'}">${escapeHtml(user.currentPage || user.activityStatus || 'Offline')}</span></td>
                    </tr>
                `).join('') : '<tr><td colspan="9">No active users match these filters.</td></tr>';
                status.textContent = `${Number(total || 0).toLocaleString()} active user${total === 1 ? '' : 's'} found.`;
            } catch (error) {
                tableBody.innerHTML = '<tr><td colspan="9">Could not load active users.</td></tr>';
                status.textContent = error.message || 'Could not load active users.';
                status.className = 'form-status error';
            }
        }

        document.getElementById('activeUsersSearchForm').addEventListener('submit', (event) => {
            event.preventDefault();
            loadActiveUsers();
        });

        async function loadLiveUsers() {
            const tableBody = document.getElementById('liveUsersTableBody');
            const status = document.getElementById('liveUsersStatusMessage');
            const query = new URLSearchParams();
            const search = document.getElementById('liveUsersSearch').value.trim();
            if (search) query.set('search', search);
            try {
                const { users, onlineCount } = await BmgApi.request(`/presence?${query.toString()}`);
                tableBody.innerHTML = users.length ? users.map((user) => `
                    <tr>
                        <td><strong>${escapeHtml(user.fullName)}</strong><br><small>${escapeHtml(user.phoneNumber)}</small></td>
                        <td>${escapeHtml(user.country)} · ${escapeHtml(user.currency)}</td>
                        <td><span class="admin-live-indicator">${escapeHtml(user.status)}</span></td>
                        <td>${escapeHtml(user.currentPage)}</td>
                        <td>${escapeHtml(user.lastSeenAt)}</td>
                    </tr>
                `).join('') : '<tr><td colspan="5">No authenticated users online right now.</td></tr>';
                status.textContent = `${Number(onlineCount || 0).toLocaleString()} user${onlineCount === 1 ? '' : 's'} online · refreshes every 10 seconds.`;
                status.className = 'form-status';
            } catch (error) {
                tableBody.innerHTML = '<tr><td colspan="5">Could not load live users.</td></tr>';
                status.textContent = error.message || 'Could not load live users.';
                status.className = 'form-status error';
            }
        }

        document.getElementById('liveUsersSearchForm').addEventListener('submit', (event) => {
            event.preventDefault();
            loadLiveUsers();
        });

        // ---------- Country-specific financial and product settings ----------
        const countrySettingsForm = document.getElementById('countrySettingsForm');
        let countryAdminData = null;
        let selectedCountryConfig = null;

        function countrySettingLabel(value) {
            return String(value)
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (letter) => letter.toUpperCase());
        }

        function countrySettingInput(path, key, value) {
            const label = countrySettingLabel(key);
            const safePath = escapeHtml(path);
            if (typeof value === 'boolean') {
                return `<label class="list-action country-setting-toggle"><span>${escapeHtml(label)}</span><input type="checkbox" data-country-path="${safePath}" data-value-type="boolean" ${value ? 'checked' : ''}></label>`;
            }
            if (typeof value === 'number') {
                const isPercent = /percent|rate/i.test(key);
                const max = isPercent ? ' max="100"' : (key === 'closeHour' ? ' max="24"' : '');
                const moneyField = /amount|reward|price|income|balance/i.test(key) ||
                    ((key === 'min' || key === 'max') && /^(deposit|withdraw)\./.test(path));
                return `<div class="form-field country-setting-input"><label>${escapeHtml(label)}${moneyField ? ` (${escapeHtml(selectedCountryConfig?.currency || '')})` : ''}</label><input type="number" min="0"${max} step="${isPercent ? '0.01' : '1'}" required data-country-path="${safePath}" data-value-type="number" value="${escapeHtml(value)}"></div>`;
            }
            const text = String(value ?? '');
            if (/message|instructions|verification|text/i.test(key)) {
                return `<div class="form-field country-setting-input"><label>${escapeHtml(label)}</label><textarea rows="2" data-country-path="${safePath}" data-value-type="string">${escapeHtml(text)}</textarea></div>`;
            }
            return `<div class="form-field country-setting-input"><label>${escapeHtml(label)}</label><input type="text" data-country-path="${safePath}" data-value-type="string" value="${escapeHtml(text)}"></div>`;
        }

        function renderCountrySettingFields(value, path) {
            if (Array.isArray(value)) {
                if (path.endsWith('.availableAmounts')) {
                    return `<div class="form-field country-setting-input"><label>Available amounts (${escapeHtml(selectedCountryConfig?.currency || '')}, comma separated)</label><input type="text" data-country-csv-path="${escapeHtml(path)}" value="${escapeHtml(value.join(', '))}" placeholder="10000, 25000, 50000"></div>`;
                }
                if (path.endsWith('.days')) {
                    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    return `<fieldset class="country-setting-array"><legend>Withdrawal days</legend><div class="country-day-options">${days.map((day) => `<label><input type="checkbox" data-country-days-path="${escapeHtml(path)}" value="${day}" ${value.includes(day) ? 'checked' : ''}> ${day}</label>`).join('')}</div></fieldset>`;
                }
                const listName = path.split('.').pop();
                const rows = value.map((item, index) => `
                    <div class="country-setting-array-row">
                        <div class="country-setting-array-fields">${Object.entries(item || {}).map(([key, child]) => renderCountrySettingFields(child, `${path}.${index}.${key}`)).join('')}</div>
                        <button type="button" class="btn btn-secondary btn-sm" data-country-array-remove="${escapeHtml(path)}" data-array-index="${index}">Remove</button>
                    </div>
                `).join('');
                return `<fieldset class="country-setting-array"><legend>${escapeHtml(countrySettingLabel(listName))}</legend>${rows || '<p class="empty-state-hint">No entries configured.</p>'}<button type="button" class="btn btn-secondary btn-sm" data-country-array-add="${escapeHtml(path)}">Add ${escapeHtml(countrySettingLabel(listName).replace(/s$/, ''))}</button></fieldset>`;
            }
            if (value && typeof value === 'object') {
                const entries = Object.entries(value).map(([key, child]) => renderCountrySettingFields(child, `${path}.${key}`)).join('');
                return `<fieldset class="country-setting-group"><legend>${escapeHtml(countrySettingLabel(path.split('.').pop()))}</legend><div class="country-setting-grid">${entries}</div></fieldset>`;
            }
            return countrySettingInput(path, path.split('.').pop(), value);
        }

        function getCountryPath(target, path) {
            return path.split('.').reduce((value, part) => value?.[part], target);
        }

        function setCountryPath(target, path, value) {
            const parts = path.split('.');
            const key = parts.pop();
            const parent = parts.reduce((current, part) => current[part], target);
            parent[key] = value;
        }

        function collectCountrySettings() {
            const settings = JSON.parse(JSON.stringify(selectedCountryConfig.settings || {}));
            countrySettingsForm.querySelectorAll('[data-country-path]').forEach((input) => {
                const value = input.dataset.valueType === 'boolean'
                    ? input.checked
                    : input.dataset.valueType === 'number'
                        ? Number(input.value)
                        : input.value;
                setCountryPath(settings, input.dataset.countryPath, value);
            });
            countrySettingsForm.querySelectorAll('[data-country-csv-path]').forEach((input) => {
                const values = input.value.split(',').map((entry) => entry.trim()).filter(Boolean).map(Number);
                setCountryPath(settings, input.dataset.countryCsvPath, values);
            });
            const dayPaths = new Set([...countrySettingsForm.querySelectorAll('[data-country-days-path]')].map((input) => input.dataset.countryDaysPath));
            dayPaths.forEach((path) => {
                const selectedDays = [...countrySettingsForm.querySelectorAll('[data-country-days-path]')]
                    .filter((input) => input.dataset.countryDaysPath === path && input.checked)
                    .map((input) => input.value);
                setCountryPath(settings, path, selectedDays);
            });
            return settings;
        }

        function createCountryArrayEntry(path) {
            if (path.endsWith('.commissions')) {
                const current = getCountryPath(collectCountrySettings(), path);
                return { level: current.length + 1, percent: 0 };
            }
            if (path.endsWith('.inviteRewards')) {
                return { id: `country-reward-${Date.now()}`, requiredInvites: 1, reward: 0, enabled: true };
            }
            return {};
        }

        function renderCountryProducts(country) {
            const tbody = document.getElementById('countryProductSettingsBody');
            const products = countryAdminData.products || [];
            const override = country.products || {};
            document.getElementById('countryProductsEmpty').hidden = products.length > 0;
            tbody.innerHTML = products.map((product) => {
                const values = { ...product, ...(override[product.id] || {}) };
                const input = (field, value, type = 'number') => `<input type="${type}" ${type === 'number' ? `min="0" ${field === 'daily_income_percent' ? 'max="100" step="0.01"' : 'step="1"'} required` : ''} aria-label="${escapeHtml(product.name)} ${escapeHtml(countrySettingLabel(field))}" data-product-id="${escapeHtml(product.id)}" data-country-product-field="${field}" value="${escapeHtml(value ?? '')}">`;
                return `<tr>
                    <th scope="row"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category || '')}</small></th>
                    <td>${input('price', values.price)}</td>
                    <td>${input('stock', values.stock)}</td>
                    <td>${input('total_slots', values.total_slots || 1000)}</td>
                    <td>${input('investment_duration_days', values.investment_duration_days || 0)}</td>
                    <td>${input('daily_income_amount', values.daily_income_amount || 0)}</td>
                    <td>${input('daily_income_percent', values.daily_income_percent || 0)}</td>
                    <td>${input('total_income', values.total_income || 0)}</td>
                    <td><select aria-label="${escapeHtml(product.name)} status" data-product-id="${escapeHtml(product.id)}" data-country-product-field="status">
                        <option value="active" ${values.status === 'active' ? 'selected' : ''}>Available</option>
                        <option value="sold_out" ${values.status === 'sold_out' ? 'selected' : ''}>Sold out</option>
                        <option value="open_soon" ${values.status === 'open_soon' ? 'selected' : ''}>Open soon</option>
                        <option value="inactive" ${values.status === 'inactive' ? 'selected' : ''}>Hidden</option>
                    </select></td>
                    <td><input type="checkbox" aria-label="${escapeHtml(product.name)} enabled" data-product-id="${escapeHtml(product.id)}" data-country-product-field="enabled" ${values.enabled ? 'checked' : ''}></td>
                </tr>`;
            }).join('');
        }

        function collectCountryProducts() {
            const products = {};
            document.querySelectorAll('[data-country-product-field]').forEach((input) => {
                const id = input.dataset.productId;
                const field = input.dataset.countryProductField;
                const value = field === 'enabled'
                    ? input.checked
                    : field === 'status'
                        ? input.value
                        : Number(input.value);
                products[id] = { ...products[id], [field]: value };
            });
            return products;
        }

        async function loadCountrySettings() {
            const status = document.getElementById('countrySettingsStatus');
            const countrySelect = document.getElementById('countrySettingsCountry');
            try {
                countryAdminData = await BmgApi.request('/countries/admin');
                if (!countrySelect.options.length) {
                    countrySelect.replaceChildren(...countryAdminData.countries.map((country) =>
                        new Option(`${country.flag} ${country.code} ${country.name} (${country.currency})`, country.code)));
                    countrySelect.addEventListener('change', renderCountrySettings);
                }
                renderCountrySettings();
                status.textContent = '';
                status.className = 'form-status';
            } catch (error) {
                status.textContent = error.message || 'Could not load country settings.';
                status.className = 'form-status error';
            }
        }

        function renderCountrySettings() {
            if (!countryAdminData) return;
            selectedCountryConfig = countryAdminData.countries.find((item) => item.code === document.getElementById('countrySettingsCountry').value);
            if (!selectedCountryConfig) return;
            document.getElementById('countrySettingsEnabled').checked = selectedCountryConfig.enabled;
            document.getElementById('countrySettingsCurrency').textContent = selectedCountryConfig.currency;
            document.getElementById('countryAddProductName').textContent = selectedCountryConfig.name;
            document.querySelectorAll('[data-country-currency]').forEach((element) => {
                element.textContent = selectedCountryConfig.currency;
            });
            document.getElementById('countryFinancialSettings').innerHTML = Object.entries(selectedCountryConfig.settings || {})
                .map(([key, value]) => renderCountrySettingFields(value, key))
                .join('');
            renderCountryProducts(selectedCountryConfig);
            renderCountrySettingsArrayButtons();
        }

        function renderCountrySettingsArrayButtons() {
            countrySettingsForm.querySelectorAll('[data-country-array-remove]').forEach((button) => button.addEventListener('click', () => {
                const settings = collectCountrySettings();
                getCountryPath(settings, button.dataset.countryArrayRemove).splice(Number(button.dataset.arrayIndex), 1);
                selectedCountryConfig.settings = settings;
                renderCountrySettings();
            }));
            countrySettingsForm.querySelectorAll('[data-country-array-add]').forEach((button) => {
                if (!button.dataset.bound) {
                    button.dataset.bound = 'true';
                    button.addEventListener('click', () => {
                        const settings = collectCountrySettings();
                        const path = button.dataset.countryArrayAdd;
                        getCountryPath(settings, path).push(createCountryArrayEntry(path));
                        selectedCountryConfig.settings = settings;
                        renderCountrySettings();
                    });
                }
            });
        }

        if (countrySettingsForm) {
            countrySettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('countrySettingsStatus');
                const countryCode = document.getElementById('countrySettingsCountry').value;
                if (!countrySettingsForm.reportValidity()) return;
                try {
                    const settings = collectCountrySettings();
                    const products = collectCountryProducts();
                    const { country } = await BmgApi.request(`/countries/${encodeURIComponent(countryCode)}`, {
                        method: 'PUT',
                        body: {
                            enabled: document.getElementById('countrySettingsEnabled').checked,
                            settings,
                            products,
                        },
                    });
                    countryAdminData.countries = countryAdminData.countries.map((item) => item.code === country.code ? country : item);
                    renderCountrySettings();
                    status.textContent = `${country.name} (${country.currency}) settings saved.`;
                    status.className = 'form-status success';
                } catch (error) {
                    status.textContent = error.message || 'Could not save country settings.';
                    status.className = 'form-status error';
                }
            });
        }

        const countryAddProductForm = document.getElementById('countryAddProductForm');
        if (countryAddProductForm) {
            countryAddProductForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('countryAddProductStatus');
                if (!selectedCountryConfig) {
                    status.textContent = 'Select a country before adding a product.';
                    status.className = 'form-status error';
                    return;
                }
                if (!countryAddProductForm.reportValidity()) return;
                const body = {
                    countryCode: selectedCountryConfig.code,
                    name: document.getElementById('countryNewProductName').value.trim(),
                    category: document.getElementById('countryNewProductCategory').value.trim(),
                    description: document.getElementById('countryNewProductDescription').value.trim(),
                    price: Number(document.getElementById('countryNewProductPrice').value),
                    stock: Number(document.getElementById('countryNewProductStock').value),
                    totalSlots: Number(document.getElementById('countryNewProductTotalSlots').value),
                    investmentDurationDays: Number(document.getElementById('countryNewProductDuration').value),
                    dailyIncomeAmount: Number(document.getElementById('countryNewProductDailyIncome').value),
                    dailyIncomePercent: Number(document.getElementById('countryNewProductDailyPercent').value),
                    totalIncome: Number(document.getElementById('countryNewProductTotalIncome').value),
                    status: document.getElementById('countryNewProductStatus').value,
                    imageUrl: document.getElementById('countryNewProductImage').value.trim() || null,
                };
                try {
                    await BmgApi.request('/products', { method: 'POST', body });
                    status.textContent = `Product added for ${selectedCountryConfig.name}. It is hidden in other countries until enabled there.`;
                    status.className = 'form-status success';
                    countryAddProductForm.reset();
                    document.getElementById('countryNewProductStock').value = '0';
                    document.getElementById('countryNewProductTotalSlots').value = '1000';
                    document.getElementById('countryNewProductDuration').value = '0';
                    document.getElementById('countryNewProductDailyIncome').value = '0';
                    document.getElementById('countryNewProductDailyPercent').value = '0';
                    document.getElementById('countryNewProductTotalIncome').value = '0';
                    await loadCountrySettings();
                } catch (error) {
                    status.textContent = error.message || 'Could not add the product to this country.';
                    status.className = 'form-status error';
                }
            });
        }

        const userAccessSearchForm = document.getElementById('userAccessSearchForm');
        if (userAccessSearchForm) {
            const userAccessList = document.getElementById('userAccessList');
            const userAccessStatus = document.getElementById('userAccessStatus');
            const userAccessSearch = document.getElementById('userAccessSearch');

            async function searchUsers() {
                userAccessStatus.textContent = 'Loading users...';
                userAccessStatus.className = 'form-status';
                try {
                    const query = new URLSearchParams();
                    if (userAccessSearch.value.trim()) query.set('search', userAccessSearch.value.trim());
                    const { users } = await BmgApi.request(`/users?${query.toString()}`);
                    userAccessList.innerHTML = users.length ? users.map((user) => `
                        <li class="admin-list-item">
                            <div class="admin-list-item-info">
                                <p class="admin-list-item-title">${escapeHtml(user.fullName)}</p>
                                <p class="admin-list-item-meta">${escapeHtml(user.phoneNumber)} · ${escapeHtml(user.country?.name || user.countryCode || 'Unknown country')} · ${escapeHtml(user.status)}</p>
                            </div>
                            <button type="button" class="btn btn-outline btn-small grant-admin-access" data-user-id="${escapeHtml(user.id)}" data-user-name="${escapeHtml(user.fullName)}">Grant Admin Access</button>
                        </li>
                    `).join('') : '<li class="admin-list-item">No matching regular users found.</li>';
                    userAccessStatus.textContent = `${users.length} user${users.length === 1 ? '' : 's'} found.`;
                    userAccessStatus.className = 'form-status';
                } catch (error) {
                    userAccessList.replaceChildren();
                    userAccessStatus.textContent = error.message || 'Could not load users.';
                    userAccessStatus.className = 'form-status error';
                }
            }

            userAccessSearchForm.addEventListener('submit', (event) => {
                event.preventDefault();
                searchUsers();
            });
            userAccessList.addEventListener('click', async (event) => {
                const button = event.target.closest('.grant-admin-access');
                if (!button) return;
                const confirmed = await askConfirmation({
                    title: 'Grant admin access?',
                    message: `This will give ${button.dataset.userName} full admin access to the dashboard and its management functions.`,
                });
                if (!confirmed) return;
                button.disabled = true;
                try {
                    await BmgApi.request(`/users/${encodeURIComponent(button.dataset.userId)}/role`, {
                        method: 'POST',
                        body: { role: 'admin' },
                    });
                    await searchUsers();
                    userAccessStatus.textContent = `Admin access granted to ${button.dataset.userName}.`;
                    userAccessStatus.className = 'form-status success';
                } catch (error) {
                    button.disabled = false;
                    userAccessStatus.textContent = error.message || 'Could not grant admin access.';
                    userAccessStatus.className = 'form-status error';
                }
            });
            searchUsers();
        }

        // ---------- Generic content managers (Products / Announcements) ----------
        function setupApiManager({ formId, listId, emptyStateId, statId, listPath, createPath, buildBody, renderItem, onDelete }) {
            const form = document.getElementById(formId);
            const list = document.getElementById(listId);
            const emptyState = document.getElementById(emptyStateId);
            const statEl = statId ? document.getElementById(statId) : null;

            async function render() {
                const data = await BmgApi.request(listPath);
                const items = Object.values(data)[0];
                list.innerHTML = '';
                items.forEach((item) => {
                    const li = document.createElement('li');
                    li.className = 'admin-list-item';
                    li.innerHTML = renderItem(item);
                    const removeBtn = li.querySelector('.remove-btn');
                    if (removeBtn) {
                        removeBtn.addEventListener('click', async () => {
                            await onDelete(item);
                            render();
                        });
                    }
                    list.appendChild(li);
                });
                emptyState.style.display = items.length ? 'none' : '';
                if (statEl) statEl.textContent = String(items.length);
            }

            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                try {
                    await BmgApi.request(createPath, { method: 'POST', body: await buildBody() });
                    form.reset();
                    render();
                } catch (err) {
                    alert(err.message || 'Could not save.');
                }
            });

            render();
        }

        // ---------- Products ----------
        const productForm = document.getElementById('productForm');
        const productList = document.getElementById('productList');
        const productEmptyState = document.getElementById('productEmptyState');
        const productFormStatus = document.getElementById('productFormStatus');

        function productBody() {
            return {
                name: document.getElementById('productName').value.trim(),
                description: document.getElementById('productDescription').value.trim(),
                category: document.getElementById('productCategory').value.trim(),
                price: Number(document.getElementById('productPrice').value),
                stock: Number(document.getElementById('productStock').value),
                totalSlots: Number(document.getElementById('productTotalSlots').value),
                investmentDurationDays: Number(document.getElementById('productInvestmentDuration').value),
                dailyIncomeAmount: Number(document.getElementById('productDailyIncomeAmount').value),
                totalIncome: Number(document.getElementById('productTotalIncome').value),
                status: document.getElementById('productStatus').value,
                imageUrl: document.getElementById('productImageUrl').value.trim() || null,
                cardColor: document.getElementById('productCardColor').value,
                headerColor: document.getElementById('productHeaderColor').value,
                buttonColor: document.getElementById('productButtonColor').value,
                productUrl: document.getElementById('productLink').value.trim() || null,
            };
        }

        function resetProductForm() {
            productForm.reset();
            document.getElementById('productId').value = '';
            document.getElementById('productStatus').value = 'active';
            document.getElementById('productSubmitBtn').textContent = 'Add Product';
            document.getElementById('productCancelEditBtn').hidden = true;
        }

        function renderProducts(products) {
            productList.innerHTML = products.map((item) => `
                <li class="admin-list-item product-admin-item">
                    ${item.imageProxyUrl ? `<img class="admin-list-image" src="${escapeHtml(item.imageProxyUrl)}" alt="" onerror="this.hidden=true; this.nextElementSibling.hidden=false;"><span class="product-image-fallback" hidden>No image</span>` : '<span class="product-image-fallback">No image</span>'}
                    <div class="admin-list-item-info"><p class="admin-list-item-title">${escapeHtml(item.name)} · RWF ${Number(item.price).toLocaleString()}</p><p class="admin-list-item-meta">${escapeHtml(item.category)} · Stock ${Number(item.stock).toLocaleString()} · ${escapeHtml(item.status)}</p></div>
                    <div class="admin-list-item-actions"><button type="button" class="edit-product-btn" data-id="${escapeHtml(item.id)}">Edit</button><button type="button" class="remove-btn" data-id="${escapeHtml(item.id)}">Delete</button></div>
                </li>
            `).join('');
            productEmptyState.style.display = products.length ? 'none' : '';
            const stat = document.getElementById('statProducts');
            if (stat) stat.textContent = String(products.length);
            productList.querySelectorAll('.edit-product-btn').forEach((button) => button.addEventListener('click', () => {
                const item = products.find((product) => product.id === button.dataset.id);
                if (!item) return;
                document.getElementById('productId').value = item.id;
                document.getElementById('productName').value = item.name;
                document.getElementById('productDescription').value = item.description || '';
                document.getElementById('productCategory').value = item.category || '';
                document.getElementById('productPrice').value = item.price;
                document.getElementById('productStock').value = item.stock;
                document.getElementById('productTotalSlots').value = item.totalSlots || 1000;
                document.getElementById('productInvestmentDuration').value = item.investmentDurationDays || 0;
                document.getElementById('productDailyIncomeAmount').value = item.dailyIncomeAmount ?? item.dailyIncomePercent ?? 0;
                document.getElementById('productTotalIncome').value = item.totalIncome || 0;
                document.getElementById('productStatus').value = item.status;
                document.getElementById('productImageUrl').value = item.image_url || '';
                document.getElementById('productCardColor').value = item.cardColor || '#363b45';
                document.getElementById('productHeaderColor').value = item.headerColor || '#73777d';
                document.getElementById('productButtonColor').value = String(item.buttonColor || '').toLowerCase() === '#8f1018' ? '#6b432b' : item.buttonColor || '#6b432b';
                document.getElementById('productLink').value = item.product_url || '';
                document.getElementById('productSubmitBtn').textContent = 'Update Product';
                document.getElementById('productCancelEditBtn').hidden = false;
                productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }));
            productList.querySelectorAll('.remove-btn').forEach((button) => button.addEventListener('click', async () => {
                if (!window.confirm('Delete this product?')) return;
                try { await BmgApi.request(`/products/${button.dataset.id}`, { method: 'DELETE' }); await loadProducts(); } catch (err) { productFormStatus.textContent = err.message || 'Could not delete product.'; productFormStatus.className = 'form-status error'; }
            }));
        }

        async function loadProducts() {
            try { renderProducts((await BmgApi.request('/products/all')).products); } catch (err) { productFormStatus.textContent = err.message || 'Could not load products.'; productFormStatus.className = 'form-status error'; }
        }

        productForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            productFormStatus.textContent = '';
            try {
                const id = document.getElementById('productId').value;
                await BmgApi.request(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body: productBody() });
                productFormStatus.textContent = id ? 'Product updated.' : 'Product added.';
                productFormStatus.className = 'form-status success';
                resetProductForm();
                await loadProducts();
            } catch (err) { productFormStatus.textContent = err.message || 'Could not save product.'; productFormStatus.className = 'form-status error'; }
        });
        document.getElementById('productCancelEditBtn').addEventListener('click', resetProductForm);
        loadProducts();

        setupApiManager({
            formId: 'announcementForm', listId: 'announcementList', emptyStateId: 'announcementEmptyState', statId: 'statAnnouncements',
            listPath: '/announcements/all', createPath: '/announcements',
            buildBody: () => ({
                title: document.getElementById('announcementTitle').value.trim(),
                message: document.getElementById('announcementMessage').value.trim(),
                publishAt: document.getElementById('announcementPublishAt').value || null,
                expiresAt: document.getElementById('announcementExpiresAt').value || null,
            }),
            renderItem: (item) => `
                <div class="admin-list-item-info"><p class="admin-list-item-title">${item.title}</p><p class="admin-list-item-meta">${item.message}</p><p class="admin-list-item-meta">Published: ${formatDate(item.publishedAt || item.createdAt)}</p></div>
                <div class="admin-list-item-actions"><button type="button" class="remove-btn">Remove</button></div>
            `,
            onDelete: (item) => BmgApi.request(`/announcements/${item.id}`, { method: 'DELETE' }),
        });

        // ---------- Deposit settings ----------
        const depositSettingsForm = document.getElementById('depositSettingsForm');
        if (depositSettingsForm) {
            (async () => {
                const { value } = await BmgApi.request('/settings/deposit');
                if (!value) return;
                document.getElementById('depositEnabled').checked = !!value.enabled;
                document.getElementById('depositMtnEnabled').checked = !!value.mtn?.enabled;
                document.getElementById('depositMtnMerchantName').value = value.mtn?.merchantName || '';
                document.getElementById('depositMtnMerchantPhone').value = value.mtn?.merchantPhone || '';
                document.getElementById('depositMtnMerchantCode').value = value.mtn?.merchantCode || '';
                document.getElementById('depositMtnMin').value = value.mtn?.min ?? 6000;
                document.getElementById('depositMtnMax').value = value.mtn?.max ?? 5000000;
                document.getElementById('depositMtnInstructions').value = value.mtn?.instructions || value.instructions || '';
                document.getElementById('depositMtnVerification').value = value.mtn?.verification || '';
                document.getElementById('depositAirtelEnabled').checked = !!value.airtel?.enabled;
                document.getElementById('depositAirtelMerchantName').value = value.airtel?.merchantName || '';
                document.getElementById('depositAirtelMerchantPhone').value = value.airtel?.merchantPhone || '';
                document.getElementById('depositAirtelMerchantCode').value = value.airtel?.merchantCode || '';
                document.getElementById('depositAirtelMin').value = value.airtel?.min ?? 3000;
                document.getElementById('depositAirtelMax').value = value.airtel?.max ?? 5000000;
                document.getElementById('depositAirtelInstructions').value = value.airtel?.instructions || value.instructions || '';
                document.getElementById('depositAirtelVerification').value = value.airtel?.verification || '';
                document.getElementById('depositInstructions').value = value.instructions || '';
                document.getElementById('depositProofRequired').checked = !!value.proofRequired;
            })();

            depositSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('depositSettingsStatus');
                try {
                    await BmgApi.request('/settings/deposit', {
                        method: 'PUT',
                        body: {
                            enabled: document.getElementById('depositEnabled').checked,
                            mtn: {
                                enabled: document.getElementById('depositMtnEnabled').checked,
                                merchantName: document.getElementById('depositMtnMerchantName').value.trim(),
                                merchantPhone: document.getElementById('depositMtnMerchantPhone').value.trim(),
                                merchantCode: document.getElementById('depositMtnMerchantCode').value.trim(),
                                min: Number(document.getElementById('depositMtnMin').value),
                                max: Number(document.getElementById('depositMtnMax').value),
                                instructions: document.getElementById('depositMtnInstructions').value.trim(),
                                verification: document.getElementById('depositMtnVerification').value.trim(),
                            },
                            airtel: {
                                enabled: document.getElementById('depositAirtelEnabled').checked,
                                merchantName: document.getElementById('depositAirtelMerchantName').value.trim(),
                                merchantPhone: document.getElementById('depositAirtelMerchantPhone').value.trim(),
                                merchantCode: document.getElementById('depositAirtelMerchantCode').value.trim(),
                                min: Number(document.getElementById('depositAirtelMin').value),
                                max: Number(document.getElementById('depositAirtelMax').value),
                                instructions: document.getElementById('depositAirtelInstructions').value.trim(),
                                verification: document.getElementById('depositAirtelVerification').value.trim(),
                            },
                            instructions: document.getElementById('depositInstructions').value.trim(),
                            proofRequired: document.getElementById('depositProofRequired').checked,
                        },
                    });
                    status.textContent = 'Deposit settings saved. The user Deposit page will use these values.';
                    status.className = 'form-status success';
                } catch (err) {
                    status.textContent = err.message || 'Could not save settings.';
                    status.className = 'form-status error';
                }
            });
        }

        // ---------- Withdraw settings ----------
        const withdrawSettingsForm = document.getElementById('withdrawSettingsForm');
        if (withdrawSettingsForm) {
            (async () => {
                const { value } = await BmgApi.request('/settings/withdraw');
                if (!value) return;
                document.getElementById('withdrawEnabled').checked = !!value.enabled;
                document.getElementById('withdrawMtnEnabled').checked = !!value.mtn?.enabled;
                document.getElementById('withdrawMtnMin').value = value.mtn?.min ?? 2000;
                document.getElementById('withdrawMtnMax').value = value.mtn?.max ?? 500000;
                document.getElementById('withdrawAirtelEnabled').checked = !!value.airtel?.enabled;
                document.getElementById('withdrawAirtelMin').value = value.airtel?.min ?? 2000;
                document.getElementById('withdrawAirtelMax').value = value.airtel?.max ?? 500000;
                document.getElementById('withdrawFeePercent').value = value.feePercent ?? 5;
                document.getElementById('withdrawProcessingMessage').value = value.processingMessage || '';
                document.getElementById('withdrawAccountHolderRequired').checked = !!value.accountHolderNameRequired;
                document.getElementById('withdrawAvailabilityEnabled').checked = !!value.availability?.enabled;
                document.getElementById('withdrawOpenHour').value = value.availability?.openHour ?? 0;
                document.getElementById('withdrawCloseHour').value = value.availability?.closeHour ?? 24;
                document.getElementById('withdrawTimezoneLabel').value = value.availability?.timezoneLabel || 'Kigali time';
                if (Array.isArray(value.availability?.days)) {
                    document.querySelectorAll('#withdrawDaysList input[type="checkbox"]').forEach((box) => {
                        box.checked = value.availability.days.includes(box.value);
                    });
                }
            })();

            withdrawSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('withdrawSettingsStatus');
                try {
                    await BmgApi.request('/settings/withdraw', {
                        method: 'PUT',
                        body: {
                            enabled: document.getElementById('withdrawEnabled').checked,
                            mtn: {
                                enabled: document.getElementById('withdrawMtnEnabled').checked,
                                min: Number(document.getElementById('withdrawMtnMin').value),
                                max: Number(document.getElementById('withdrawMtnMax').value),
                            },
                            airtel: {
                                enabled: document.getElementById('withdrawAirtelEnabled').checked,
                                min: Number(document.getElementById('withdrawAirtelMin').value),
                                max: Number(document.getElementById('withdrawAirtelMax').value),
                            },
                            feePercent: Number(document.getElementById('withdrawFeePercent').value),
                            processingMessage: document.getElementById('withdrawProcessingMessage').value.trim(),
                            accountHolderNameRequired: document.getElementById('withdrawAccountHolderRequired').checked,
                            availability: {
                                enabled: document.getElementById('withdrawAvailabilityEnabled').checked,
                                days: Array.from(document.querySelectorAll('#withdrawDaysList input[type="checkbox"]:checked')).map((b) => b.value),
                                openHour: Number(document.getElementById('withdrawOpenHour').value),
                                closeHour: Number(document.getElementById('withdrawCloseHour').value),
                                timezoneLabel: document.getElementById('withdrawTimezoneLabel').value.trim(),
                            },
                            bonusMessage: { enabled: false, amount: 0, text: '' },
                        },
                    });
                    status.textContent = 'Withdraw settings saved. The user Withdraw page will use these values.';
                    status.className = 'form-status success';
                } catch (err) {
                    status.textContent = err.message || 'Could not save settings.';
                    status.className = 'form-status error';
                }
            });
        }

        // ---------- Support settings ----------
        const supportSettingsForm = document.getElementById('supportSettingsForm');
        if (supportSettingsForm) {
            (async () => {
                const { value } = await BmgApi.request('/settings/support');
                if (!value) return;
                document.getElementById('supportMessageInput').value = String(value.message || '').replace(/\bMIP\b/gi, 'our support team').replace(/\bcoffee\s+planet\b/gi, 'our support team');
                document.getElementById('supportEmailEnabled').checked = !!value.channelsEnabled?.email;
                document.getElementById('supportEmailInput').value = value.email || '';
                document.getElementById('supportPhoneEnabled').checked = !!value.channelsEnabled?.phone;
                document.getElementById('supportPhoneInput').value = value.phone || '';
                document.getElementById('supportWhatsappEnabled').checked = !!value.channelsEnabled?.whatsapp;
                document.getElementById('supportWhatsappInput').value = value.whatsapp || '';
                document.getElementById('supportTelegramEnabled').checked = !!value.channelsEnabled?.telegram;
                document.getElementById('supportTelegramLinkInput').value = value.telegramLink || '';
                document.getElementById('supportTelegramUsernameInput').value = value.telegramUsername || '';
                document.getElementById('supportAvailabilityInput').value = value.availability || '';
            })();

            supportSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('supportSettingsStatus');
                try {
                    await BmgApi.request('/settings/support', {
                        method: 'PUT',
                        body: {
                            message: document.getElementById('supportMessageInput').value.trim(),
                            email: document.getElementById('supportEmailInput').value.trim(),
                            phone: document.getElementById('supportPhoneInput').value.trim(),
                            whatsapp: document.getElementById('supportWhatsappInput').value.trim(),
                            telegramLink: document.getElementById('supportTelegramLinkInput').value.trim(),
                            telegramUsername: document.getElementById('supportTelegramUsernameInput').value.trim(),
                            availability: document.getElementById('supportAvailabilityInput').value.trim(),
                            channelsEnabled: {
                                email: document.getElementById('supportEmailEnabled').checked,
                                phone: document.getElementById('supportPhoneEnabled').checked,
                                whatsapp: document.getElementById('supportWhatsappEnabled').checked,
                                telegram: document.getElementById('supportTelegramEnabled').checked,
                            },
                        },
                    });
                    status.textContent = 'Support settings saved. The user Support page will use these values.';
                    status.className = 'form-status success';
                } catch (err) {
                    status.textContent = err.message || 'Could not save settings.';
                    status.className = 'form-status error';
                }
            });
        }

        // ---------- Home page settings ----------
        const coffeePlanetSettingsForm = document.getElementById('coffeePlanetSettingsForm');
        if (coffeePlanetSettingsForm) {
            const imageRows = document.getElementById('coffeePlanetImages');
            const addImageButton = document.getElementById('addCoffeePlanetImageBtn');
            const updateAddImageButton = () => {
                addImageButton.disabled = imageRows.children.length >= 5;
                addImageButton.textContent = addImageButton.disabled ? 'Maximum 5 photos' : '+ Add photo';
            };
            const addCoffeeImageRow = (image = {}) => {
                if (imageRows.children.length >= 5) return;
                const row = document.createElement('div');
                row.className = 'coffee-planet-image-row';
                row.innerHTML = `
                    <div class="form-field"><label>Photo URL or uploaded image</label><input type="text" class="coffee-planet-image-src" maxlength="560000" placeholder="https://..."></div>
                    <div class="form-field"><label>Photo caption</label><input type="text" class="coffee-planet-image-caption" maxlength="120" placeholder="Premium Coffee Experience"></div>
                    <div class="form-field"><label>Upload photo (max 250 KB)</label><input type="file" class="coffee-planet-image-file" accept="image/jpeg,image/png,image/webp,image/gif"></div>
                    <img class="coffee-planet-image-preview" alt="Photo preview" hidden>
                    <button type="button" class="btn btn-secondary btn-sm" data-remove-coffee-image>Remove photo</button>`;
                const srcInput = row.querySelector('.coffee-planet-image-src');
                const preview = row.querySelector('.coffee-planet-image-preview');
                const fileInput = row.querySelector('.coffee-planet-image-file');
                srcInput.value = image.src || '';
                row.querySelector('.coffee-planet-image-caption').value = removeVisibleBrand(image.caption);
                if (image.src) {
                    preview.src = image.src;
                    preview.hidden = false;
                }
                fileInput.addEventListener('change', () => {
                    const file = fileInput.files?.[0];
                    if (!file) return;
                    if (file.size > 250 * 1024) {
                        fileInput.value = '';
                        document.getElementById('coffeePlanetSettingsStatus').textContent = 'Each uploaded photo must be 250 KB or smaller so all five photos fit safely in one save.';
                        document.getElementById('coffeePlanetSettingsStatus').className = 'form-status error';
                        return;
                    }
                    const reader = new FileReader();
                    reader.addEventListener('load', () => {
                        srcInput.value = String(reader.result);
                        preview.src = String(reader.result);
                        preview.hidden = false;
                    });
                    reader.addEventListener('error', () => {
                        document.getElementById('coffeePlanetSettingsStatus').textContent = 'The selected photo could not be read.';
                        document.getElementById('coffeePlanetSettingsStatus').className = 'form-status error';
                    });
                    reader.readAsDataURL(file);
                });
                srcInput.addEventListener('change', () => {
                    if (!srcInput.value.trim()) {
                        preview.hidden = true;
                        preview.removeAttribute('src');
                        return;
                    }
                    preview.src = srcInput.value.trim();
                    preview.hidden = false;
                });
                row.querySelector('[data-remove-coffee-image]').addEventListener('click', () => {
                    row.remove();
                    updateAddImageButton();
                });
                imageRows.appendChild(row);
                updateAddImageButton();
            };

            addImageButton.addEventListener('click', () => addCoffeeImageRow());
            (async () => {
                try {
                    const { value } = await BmgApi.request('/settings/coffeePlanet');
                    const settings = value || {};
                    document.getElementById('coffeePlanetTitleInput').value = removeVisibleBrand(settings.title || 'Home');
                    document.getElementById('coffeePlanetSubtitleInput').value = settings.subtitle || 'Select a service to get started';
                    document.getElementById('coffeePlanetAboutTitleInput').value = removeVisibleBrand(settings.aboutTitle || 'About Us');
                    document.getElementById('coffeePlanetAboutTextInput').value = removeVisibleBrand(settings.aboutText ?? document.getElementById('coffeePlanetAboutTextInput').value);
                    const defaultImages = [
                        { src: '/assets/coffee-slides/coffee-brewing.jpg', caption: 'Freshly Brewed Coffee' },
                        { src: '/assets/coffee-slides/coffee-beans.jpg', caption: 'Premium Coffee Beans' },
                        { src: '/assets/coffee-slides/coffee-cafe.jpg', caption: 'Coffee Moments' },
                        { src: '/assets/coffee-slides/coffee-selection.jpg', caption: 'A World of Coffee' },
                        { src: '/assets/coffee-slides/iced-coffee.jpg', caption: 'A Refreshing Coffee Break' },
                    ];
                    (settings.images?.length ? settings.images : defaultImages).forEach((image) => addCoffeeImageRow(image));
                } catch (error) {
                    const status = document.getElementById('coffeePlanetSettingsStatus');
                    status.textContent = error.message || 'Could not load home page settings.';
                    status.className = 'form-status error';
                }
            })();

            coffeePlanetSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('coffeePlanetSettingsStatus');
                try {
                    const images = Array.from(imageRows.querySelectorAll('.coffee-planet-image-row')).map((row) => ({
                        src: row.querySelector('.coffee-planet-image-src').value.trim(),
                        caption: row.querySelector('.coffee-planet-image-caption').value.trim(),
                    })).filter((image) => image.src);
                    const { value } = await BmgApi.request('/settings/coffeePlanet', {
                        method: 'PUT',
                        body: {
                            title: document.getElementById('coffeePlanetTitleInput').value.trim(),
                            subtitle: document.getElementById('coffeePlanetSubtitleInput').value.trim(),
                            aboutTitle: document.getElementById('coffeePlanetAboutTitleInput').value.trim(),
                            aboutText: document.getElementById('coffeePlanetAboutTextInput').value.trim(),
                            images,
                        },
                    });
                    status.textContent = 'Home page saved.';
                    status.className = 'form-status success';
                    imageRows.replaceChildren();
                    (value.images || []).forEach((image) => addCoffeeImageRow(image));
                } catch (error) {
                    status.textContent = error.message || 'Could not save home page settings.';
                    status.className = 'form-status error';
                }
            });
        }

        // ---------- Bonus, investment and withdrawal rules ----------
        async function readRuleSettings() {
            const [{ value: bonus }, { value: investment }, { value: withdraw }] = await Promise.all([
                BmgApi.request('/settings/welcomeBonus'),
                BmgApi.request('/settings/investment'),
                BmgApi.request('/settings/withdraw'),
            ]);
            if (bonus) {
                document.getElementById('welcomeBonusEnabled').checked = !!bonus.enabled;
                document.getElementById('welcomeBonusType').value = bonus.type || 'fixed';
                document.getElementById('welcomeBonusAmount').value = bonus.amount ?? 0;
                document.getElementById('welcomeBonusMinimumDeposit').value = bonus.minimumDeposit ?? 0;
                document.getElementById('welcomeBonusDepositRequired').checked = !!bonus.depositRequired;
                document.getElementById('welcomeBonusProductRequired').checked = !!bonus.productPurchaseRequired;
                document.getElementById('welcomeBonusWithdrawable').checked = bonus.withdrawable !== false;
                document.getElementById('welcomeBonusExpiryDays').value = bonus.expiryDays ?? 0;
            }
            if (investment) {
                document.getElementById('investmentEnabled').checked = investment.enabled !== false;
                document.getElementById('investmentMinimumAmount').value = investment.minimumAmount ?? 0;
                document.getElementById('investmentMaximumAmount').value = investment.maximumAmount ?? 0;
                document.getElementById('investmentAvailableAmounts').value = (investment.availableAmounts || []).join(', ');
                document.getElementById('investmentDurationDays').value = investment.durationDays ?? 0;
                document.getElementById('investmentDailyRatePercent').value = investment.dailyRatePercent ?? 0;
            }
            if (withdraw) {
                document.getElementById('rulesWithdrawEnabled').checked = withdraw.enabled !== false;
                document.getElementById('rulesWithdrawFeePercent').value = withdraw.feePercent ?? 0;
                document.getElementById('rulesWithdrawMinimum').value = withdraw.minAmount ?? withdraw.mtn?.min ?? 0;
                document.getElementById('rulesWithdrawMaximum').value = withdraw.maxAmount ?? withdraw.mtn?.max ?? 0;
                document.getElementById('rulesWithdrawBalance').value = withdraw.minimumBalance ?? 0;
            }
        }
        readRuleSettings().catch(() => {});

        const saveRule = async (formId, statusId, key, value) => {
            const status = document.getElementById(statusId);
            try {
                await BmgApi.request(`/settings/${key}`, { method: 'PUT', body: value });
                status.textContent = 'Settings saved and active on the backend.';
                status.className = 'form-status success';
            } catch (err) {
                status.textContent = err.message || 'Could not save settings.';
                status.className = 'form-status error';
            }
        };
        document.getElementById('welcomeBonusSettingsForm').addEventListener('submit', (event) => {
            event.preventDefault();
            saveRule('welcomeBonusSettingsForm', 'welcomeBonusSettingsStatus', 'welcomeBonus', {
                enabled: document.getElementById('welcomeBonusEnabled').checked,
                type: document.getElementById('welcomeBonusType').value,
                amount: Number(document.getElementById('welcomeBonusAmount').value),
                minimumDeposit: Number(document.getElementById('welcomeBonusMinimumDeposit').value),
                depositRequired: document.getElementById('welcomeBonusDepositRequired').checked,
                productPurchaseRequired: document.getElementById('welcomeBonusProductRequired').checked,
                withdrawable: document.getElementById('welcomeBonusWithdrawable').checked,
                expiryDays: Number(document.getElementById('welcomeBonusExpiryDays').value),
            });
        });
        document.getElementById('investmentSettingsForm').addEventListener('submit', (event) => {
            event.preventDefault();
            saveRule('investmentSettingsForm', 'investmentSettingsStatus', 'investment', {
                enabled: document.getElementById('investmentEnabled').checked,
                minimumAmount: Number(document.getElementById('investmentMinimumAmount').value),
                maximumAmount: Number(document.getElementById('investmentMaximumAmount').value),
                availableAmounts: document.getElementById('investmentAvailableAmounts').value.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0),
                durationDays: Number(document.getElementById('investmentDurationDays').value),
                dailyRatePercent: Number(document.getElementById('investmentDailyRatePercent').value),
            });
        });
        document.getElementById('withdrawalRulesForm').addEventListener('submit', (event) => {
            event.preventDefault();
            saveRule('withdrawalRulesForm', 'withdrawalRulesStatus', 'withdraw', {
                enabled: document.getElementById('rulesWithdrawEnabled').checked,
                feePercent: Number(document.getElementById('rulesWithdrawFeePercent').value),
                minAmount: Number(document.getElementById('rulesWithdrawMinimum').value),
                maxAmount: Number(document.getElementById('rulesWithdrawMaximum').value),
                minimumBalance: Number(document.getElementById('rulesWithdrawBalance').value),
            });
        });

        // ---------- Chakin settings ----------
        const chakinSettingsForm = document.getElementById('chakinSettingsForm');
        if (chakinSettingsForm) {
            (async () => {
                const { value } = await BmgApi.request('/settings/chakin');
                if (!value) return;
                document.getElementById('chakinEnabled').checked = !!value.enabled;
                document.getElementById('chakinReward').value = value.reward ?? 0;
                document.getElementById('chakinCooldownHours').value = value.cooldownHours ?? 24;
                document.getElementById('chakinMaxCheckins').value = value.maxCheckins ?? 0;
                document.getElementById('chakinStartDate').value = value.startDate || '';
                document.getElementById('chakinEndDate').value = value.endDate || '';
                document.getElementById('chakinTimezone').value = value.timezone || 'Africa/Kigali';
            })();

            chakinSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('chakinSettingsStatus');
                try {
                    await BmgApi.request('/settings/chakin', {
                        method: 'PUT',
                        body: {
                            enabled: document.getElementById('chakinEnabled').checked,
                            reward: Number(document.getElementById('chakinReward').value),
                            cooldownHours: Number(document.getElementById('chakinCooldownHours').value),
                            maxCheckins: Number(document.getElementById('chakinMaxCheckins').value),
                            startDate: document.getElementById('chakinStartDate').value,
                            endDate: document.getElementById('chakinEndDate').value,
                            timezone: document.getElementById('chakinTimezone').value.trim() || 'Africa/Kigali',
                            timezoneLabel: document.getElementById('chakinTimezone').value.trim() || 'Africa/Kigali',
                        },
                    });
                    status.textContent = 'Chakin settings saved. The user Task page will use these values.';
                    status.className = 'form-status success';
                } catch (err) {
                    status.textContent = err.message || 'Could not save Chakin settings.';
                    status.className = 'form-status error';
                }
            });
        }

        async function loadChakinCheckins() {
            const { checkins, todayCount, totalCount } = await BmgApi.request('/tasks/chakin/checkins');
            document.getElementById('chakinTodayCount').textContent = String(todayCount);
            document.getElementById('chakinTotalCount').textContent = String(totalCount);

            const list = document.getElementById('chakinCheckinList');
            const emptyState = document.getElementById('chakinCheckinEmptyState');
            list.innerHTML = checkins.map((c) => `
                <li class="admin-list-item">
                    <div class="admin-list-item-info">
                        <p class="admin-list-item-title">${c.full_name} · ${c.phone_number}</p>
                        <p class="admin-list-item-meta">${c.check_in_date} · Reward: RWF ${Number(c.reward_amount).toLocaleString()} · ${c.status}</p>
                    </div>
                </li>
            `).join('');
            emptyState.style.display = checkins.length ? 'none' : '';
        }

        // ---------- Gift Code settings ----------
        const giftCodeSettingsForm = document.getElementById('giftCodeSettingsForm');
        const generateGiftCodeBtn = document.getElementById('generateGiftCodeBtn');
        const giftCurrencies = { RW: 'RWF', UG: 'UGX', ZM: 'ZMW', BI: 'BIF' };
        if (generateGiftCodeBtn) {
            generateGiftCodeBtn.addEventListener('click', async () => {
                const { code } = await BmgApi.request('/tasks/gift-codes/generate-code');
                document.getElementById('giftCodeInputAdmin').value = code;
            });
        }

        if (giftCodeSettingsForm) {
            const giftCodeCountry = document.getElementById('giftCodeCountry');
            const giftCodeRewardLabel = document.querySelector('label[for="giftCodeRewardAdmin"]');
            const updateGiftCurrency = () => {
                giftCodeRewardLabel.textContent = `Reward Amount (${giftCurrencies[giftCodeCountry.value] || 'country currency'})`;
            };
            giftCodeCountry.addEventListener('change', updateGiftCurrency);
            updateGiftCurrency();
            giftCodeSettingsForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('giftCodeSettingsStatus');
                try {
                    const expiresRaw = document.getElementById('giftCodeExpiresAdmin').value;
                    await BmgApi.request('/tasks/gift-codes', {
                        method: 'POST',
                        body: {
                            code: document.getElementById('giftCodeInputAdmin').value.trim() || undefined,
                            countryCode: document.getElementById('giftCodeCountry').value || null,
                            reward: Number(document.getElementById('giftCodeRewardAdmin').value),
                            maxUses: document.getElementById('giftCodeMaxUsesAdmin').value ? Number(document.getElementById('giftCodeMaxUsesAdmin').value) : null,
                            perUserLimit: Number(document.getElementById('giftCodePerUserAdmin').value) || 1,
                            expiresAt: expiresRaw ? new Date(expiresRaw).toISOString() : null,
                            enabled: document.getElementById('giftCodeEnabledAdmin').checked,
                        },
                    });
                    status.textContent = 'Gift code created.';
                    status.className = 'form-status success';
                    giftCodeSettingsForm.reset();
                    updateGiftCurrency();
                    document.getElementById('giftCodePerUserAdmin').value = 1;
                    document.getElementById('giftCodeEnabledAdmin').checked = true;
                    loadGiftCodes();
                } catch (err) {
                    status.textContent = err.message || 'Could not create gift code.';
                    status.className = 'form-status error';
                }
            });
        }

        async function loadGiftCodes() {
            const { giftCodes } = await BmgApi.request('/tasks/gift-codes/all');
            const list = document.getElementById('giftCodeList');
            const emptyState = document.getElementById('giftCodeEmptyState');
            list.innerHTML = giftCodes.map((g) => `
                <li class="admin-list-item">
                    <div class="admin-list-item-info">
                        <p class="admin-list-item-title">${g.code} · ${giftCurrencies[g.countryCode] || 'Shared'} ${Number(g.reward).toLocaleString()}</p>
                        <p class="admin-list-item-meta">${g.countryCode ? `Country: ${g.countryCode}` : 'Shared with all countries'} · Uses: ${g.max_uses ?? 'Unlimited'} · Per-user: ${g.per_user_limit} · Expires: ${g.expires_at ? new Date(g.expires_at).toLocaleString() : 'Never'} · <span class="status-pill ${g.enabled ? 'status-approved' : 'status-rejected'}">${g.enabled ? 'Enabled' : 'Disabled'}</span></p>
                    </div>
                    <div class="admin-list-item-actions">
                        <button type="button" class="approve-btn" data-id="${g.id}" data-enabled="${g.enabled}">${g.enabled ? 'Disable' : 'Enable'}</button>
                        <button type="button" class="remove-btn" data-id="${g.id}">Delete</button>
                    </div>
                </li>
            `).join('');
            emptyState.style.display = giftCodes.length ? 'none' : '';

            list.querySelectorAll('.approve-btn').forEach((btn) => btn.addEventListener('click', async () => {
                await BmgApi.request(`/tasks/gift-codes/${btn.dataset.id}`, { method: 'PUT', body: { enabled: !Number(btn.dataset.enabled) } });
                loadGiftCodes();
            }));
            list.querySelectorAll('.remove-btn').forEach((btn) => btn.addEventListener('click', async () => {
                await BmgApi.request(`/tasks/gift-codes/${btn.dataset.id}`, { method: 'DELETE' });
                loadGiftCodes();
            }));
        }

        async function loadPromoters() {
            const list = document.getElementById('promoterList');
            if (!list) return;
            try {
                const { promoters } = await BmgApi.request('/promoters');
                list.innerHTML = promoters.map((p) => `<li class="admin-list-item promoter-summary-item"><div class="admin-list-item-info"><p class="admin-list-item-title">${escapeHtml(p.name)}</p><p class="admin-list-item-meta">${Number(p.totalUsers || 0)} referrals · ${Number(p.activeUsers || 0)} active accounts · ${Number(p.purchasingUsers || 0)} completed purchasers · ${Number(p.productPurchases || 0)} purchases</p></div><div class="admin-list-item-actions"><span class="status-pill">${escapeHtml(p.status)}</span><button type="button" class="btn btn-secondary btn-sm" data-promoter-controls="${escapeHtml(p.id)}">Controls</button></div></li>`).join('');
                document.getElementById('promoterEmptyState').style.display = promoters.length ? 'none' : '';
                list.querySelectorAll('[data-promoter-controls]').forEach((button) => button.addEventListener('click', () => openPromoterControls(button.dataset.promoterControls)));
            } catch (err) { list.innerHTML = `<li class="admin-list-item-meta">${err.message}</li>`; }
        }

        async function openPromoterControls(promoterId) {
            const data = await BmgApi.request(`/promoters/${promoterId}/control`);
            const user = data.user;
            const actions = [
                ['Login', 'login_blocked', user.loginBlocked], ['Withdrawals', 'withdrawals_blocked', user.withdrawalsBlocked], ['Deposits', 'deposits_blocked', user.depositsBlocked], ['Products', 'product_purchase_blocked', user.productPurchaseBlocked],
            ];
            const values = await new Promise((resolve) => {
                const form = document.getElementById('formModalFields');
                document.getElementById('formModalTitle').textContent = `Controls: ${user.fullName}`;
                document.getElementById('formModalError').textContent = '';
                form.innerHTML = `${actions.map(([label, key, blocked]) => `<label class="list-action"><span>${label}: ${blocked ? 'Blocked' : 'Allowed'}</span><input type="checkbox" data-control-key="${key}" ${blocked ? 'checked' : ''}></label>`).join('')}<label class="list-action"><span>Account: ${user.status === 'Blocked' ? 'Blocked' : 'Active'}</span><input type="checkbox" id="promoterAccountBlocked" ${user.status === 'Blocked' ? 'checked' : ''}></label><div class="form-field"><label for="promoterControlComment">Promoter Comment</label><textarea id="promoterControlComment" rows="2">${user.comment || ''}</textarea></div><button type="button" class="btn btn-secondary btn-small" id="promoterSaveComment">Save Comment</button><button type="button" class="btn btn-secondary btn-small" id="promoterRemoveStatus">Remove Promoter Status (keep account)</button><button type="button" class="btn btn-danger btn-small" id="promoterDeleteAccount">Delete Promoter Permanently</button>`;
                const modal = document.getElementById('formModal'); modal.hidden = false;
                const close = (result = null) => { modal.hidden = true; resolve(result); };
                const showError = (error) => { document.getElementById('formModalError').textContent = error.message || 'Could not save promoter control.'; };
                document.getElementById('formModalCancel').onclick = () => close(null);
                document.getElementById('formModalSave').onclick = async () => {
                    try {
                        for (const checkbox of form.querySelectorAll('[data-control-key]')) await BmgApi.request(`/promoters/${promoterId}/control/restriction`, { method: 'POST', body: { key: checkbox.dataset.controlKey, blocked: checkbox.checked } });
                        close(true);
                    } catch (error) { showError(error); }
                };
                document.getElementById('promoterSaveComment').onclick = async () => {
                    try { const controlComment = document.getElementById('promoterControlComment').value.trim(); await BmgApi.request(`/promoters/users/${user.id}`, { method: 'PUT', body: { promoterId, comment: controlComment } }); close(true); } catch (error) { showError(error); }
                };
                document.getElementById('promoterAccountBlocked').onchange = async (event) => {
                    try { await BmgApi.request(`/promoters/${promoterId}/control/account`, { method: 'POST', body: { blocked: event.target.checked } }); } catch (error) { event.target.checked = !event.target.checked; showError(error); }
                };
                document.getElementById('promoterRemoveStatus').onclick = async () => {
                    const result = await askConfirmation({ title: 'Remove Promoter Status', message: 'Keep this account but remove it from Promoters?' });
                    if (!result) return;
                    try { await BmgApi.request(`/promoters/${promoterId}/control/remove-status`, { method: 'POST' }); close(true); } catch (error) { showError(error); }
                };
                document.getElementById('promoterDeleteAccount').onclick = async () => {
                    const confirmButton = document.getElementById('confirmModalConfirm');
                    const originalLabel = confirmButton.textContent;
                    confirmButton.textContent = 'Permanently Delete';
                    const result = await askConfirmation({ title: 'Delete this account permanently?', message: `USER NAME: ${user.fullName}\nUSER ID: ${user.id}\n\nPERMANENT ACTION: This deletes the real user account, login access, promoter relationship, and related records.\n\nUse “Remove Promoter Status” instead if you want to keep the account.`, requireReason: true });
                    confirmButton.textContent = originalLabel;
                    if (result) { try { await BmgApi.request(`/promoters/${promoterId}/control/delete-account`, { method: 'DELETE', body: { reason: result.reason } }); close(true); } catch (error) { document.getElementById('formModalError').textContent = error.message || 'Permanent deletion failed. The account was not removed.'; } }
                };
            });
            if (values) loadPromoters();
        }

        const promoterForm = document.getElementById('promoterForm');
        if (promoterForm) promoterForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = document.getElementById('promoterFormStatus');
            try { await BmgApi.request('/promoters', { method: 'POST', body: { name: document.getElementById('promoterNameInput').value.trim() } }); promoterForm.reset(); status.textContent = 'Promoter created.'; status.className = 'form-status success'; loadPromoters(); }
            catch (err) { status.textContent = err.message || 'Could not create promoter.'; status.className = 'form-status error'; }
        });

        // ---------- Audit log ----------
        async function loadAuditLog() {
            const list = document.getElementById('auditLogList');
            const emptyState = document.getElementById('auditLogEmptyState');
            try {
                const { logs = [] } = await BmgApi.request('/audit-logs');
                list.innerHTML = logs.map((log) => `
                    <li class="admin-list-item">
                        <div class="admin-list-item-info">
                            <p class="admin-list-item-title">${escapeHtml(log.action || 'Admin action')}</p>
                            <p class="admin-list-item-meta">Target: ${escapeHtml(log.target || '—')} · ${log.created_at ? new Date(String(log.created_at).replace(' ', 'T')).toLocaleString() : '—'}${log.reason ? ` · Reason: ${escapeHtml(log.reason)}` : ''}</p>
                        </div>
                    </li>
                `).join('');
                emptyState.textContent = logs.length ? '' : 'No audit log entries yet.';
                emptyState.style.display = logs.length ? 'none' : '';
            } catch (err) {
                list.innerHTML = '';
                emptyState.textContent = err.message || 'Audit log is temporarily unavailable.';
                emptyState.style.display = '';
            }
        }
    }
});
