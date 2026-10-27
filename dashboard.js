// User dashboard: Home/Task/Product/Team/Me views wired to the real backend API.
document.addEventListener('DOMContentLoaded', async () => {
    if (!BmgApi.getToken('user')) { window.location.href = 'login.html'; return; }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function removeBrandName(value) {
        return String(value ?? '').replace(/\bcoffee\s+planet\b/gi, 'our company').replace(/[ \t]{2,}/g, ' ').trim();
    }
    function productActionColor(value) {
        const match = /^#([0-9a-f]{6})$/i.exec(String(value || ''));
        if (!match) return '#6b432b';
        const [red, green, blue] = match[1].match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const chroma = max - min;
        const saturation = max === 0 ? 0 : chroma / max;
        let hue = 0;
        if (chroma) {
            if (max === red) hue = 60 * (((green - blue) / chroma) % 6);
            else if (max === green) hue = 60 * ((blue - red) / chroma + 2);
            else hue = 60 * ((red - green) / chroma + 4);
            if (hue < 0) hue += 360;
        }
        return saturation >= 0.3 && (hue < 18 || hue >= 342) ? '#6b432b' : `#${match[1].toLowerCase()}`;
    }

    function openView(name) {
        const view = document.getElementById(`view-${name}`);
        if (!view) {
            console.error(`Dashboard view not found: ${name}`);
            return;
        }
        document.querySelectorAll('.dash-view').forEach((v) => { v.hidden = true; });
        view.hidden = false;
        document.body.classList.toggle('home-active', name === 'home');
        document.body.classList.toggle('coffee-account-active', name !== 'home');
        if (presenceStarted) sendPresence(name);
        document.querySelectorAll('.bottom-nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.openView === name));
        const loaders = { task: loadInviteRewards, product: loadProducts, team: loadTeam, me: loadMe, history: loadHistory, deposit: loadDeposit, withdraw: loadWithdrawal, support: loadSupport };
        loaders[name]?.();
    }
    document.querySelectorAll('[data-open-view]').forEach((btn) => btn.addEventListener('click', () => openView(btn.dataset.openView)));

    let currentUser = null;
    let presenceStarted = false;
    let presenceErrorReported = false;
    let currentPresencePage = 'home';
    function sendPresence(page = currentPresencePage) {
        currentPresencePage = page;
        if (!presenceStarted || document.visibilityState === 'hidden') return;
        BmgApi.request('/presence/heartbeat', { method: 'POST', body: { page: currentPresencePage } })
            .catch((error) => {
                if (presenceErrorReported) return;
                presenceErrorReported = true;
                console.error('Could not update live user presence:', error);
            });
    }
    function startPresenceTracking() {
        presenceStarted = true;
        sendPresence();
        window.setInterval(() => sendPresence(), 10000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') sendPresence();
        });
    }

    const formatMoney = (amount) => `${Number(amount || 0).toLocaleString()} ${currentUser?.currency || 'RWF'}`;
    const formatMoneyPrefix = (amount) => `${currentUser?.currency || 'RWF'} ${Number(amount || 0).toLocaleString()}`;
    const createReferralRegistrationLink = (referralCode) => {
        const query = new URLSearchParams({ ref: referralCode });
        if (currentUser?.countryCode) query.set('country', currentUser.countryCode);
        return `${window.location.origin}/register.html?${query.toString()}`;
    };
    async function loadUser() {
        const { user } = await BmgApi.request('/auth/me');
        currentUser = user;
        document.querySelectorAll('[data-currency-label]').forEach((label) => { label.textContent = user.currency || 'RWF'; });
        document.getElementById('meAvatar').textContent = String(user.fullName || 'U').trim().charAt(0).toUpperCase() || 'U';
        document.getElementById('meHeadingName').textContent = user.fullName;
        document.getElementById('balanceAmount').textContent = Number(user.balance).toLocaleString();
        const meBalance = document.getElementById('meBalanceAmount');
        if (meBalance) meBalance.textContent = Number(user.balance || 0).toLocaleString();
        applyAppearance(user.appearance || 'system');
    }

    function applyAppearance(mode) {
        const isDark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('theme-dark', isDark);
        document.documentElement.dataset.appearance = mode;
    }
    const appearanceMedia = window.matchMedia('(prefers-color-scheme: dark)');
    appearanceMedia.addEventListener?.('change', () => {
        if (currentUser?.appearance === 'system') applyAppearance('system');
    });

    async function loadHome() {
        try {
            const { value } = await BmgApi.request('/settings/coffeePlanet', { auth: false });
            renderCoffeePlanet(value);
        } catch (error) {
            console.error('Could not load home page settings:', error);
            renderCoffeePlanet(null);
        }
    }

    let coffeeSlideTimer = null;
    function renderCoffeePlanet(settings) {
        const configuredImages = Array.isArray(settings?.images) ? settings.images.filter((image) => image?.src) : [];
        const images = configuredImages.length ? configuredImages : [
            { src: 'assets/coffee-slides/coffee-brewing.jpg', caption: 'Freshly Brewed Coffee' },
            { src: 'assets/coffee-slides/coffee-beans.jpg', caption: 'Premium Coffee Beans' },
            { src: 'assets/coffee-slides/coffee-cafe.jpg', caption: 'Coffee Moments' },
            { src: 'assets/coffee-slides/coffee-selection.jpg', caption: 'A World of Coffee' },
            { src: 'assets/coffee-slides/iced-coffee.jpg', caption: 'A Refreshing Coffee Break' },
        ];
        const hero = document.getElementById('coffeeHero');
        const image = document.getElementById('coffeeHeroImage');
        const caption = document.getElementById('coffeeHeroCaption');
        const indicators = document.getElementById('coffeeHeroIndicators');
        const defaultAboutText = 'We connect our members with carefully selected products and offer clear account tools to manage their activity.\n\nMembers can track their plans, invite friends, and review available tasks and account transactions from one place.';
        document.getElementById('coffeeAboutTitle').textContent = removeBrandName(settings?.aboutTitle) || 'About Us';
        const aboutText = settings ? String(settings.aboutText || '') : defaultAboutText;
        const paragraphs = removeBrandName(aboutText).split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
        document.getElementById('coffeeAboutText').replaceChildren(...paragraphs.map((text) => {
            const paragraph = document.createElement('p');
            paragraph.textContent = text;
            return paragraph;
        }));
        if (coffeeSlideTimer) window.clearInterval(coffeeSlideTimer);
        indicators.replaceChildren();
        hero.classList.remove('coffee-hero-empty');
        image.hidden = false;
        let activeIndex = 0;
        const showSlide = (index) => {
            activeIndex = index;
            const slide = images[index];
            image.classList.remove('is-visible');
            const revealImage = () => window.requestAnimationFrame(() => image.classList.add('is-visible'));
            const imageUrl = new URL(slide.src, BMG_API_BASE || window.location.href).href;
            image.onload = revealImage;
            image.onerror = () => {
                image.classList.remove('is-visible');
                caption.textContent = 'Coffee photos are temporarily unavailable.';
            };
            image.src = imageUrl;
            image.alt = removeBrandName(slide.caption) || 'Featured photo';
            caption.textContent = removeBrandName(slide.caption) || 'Premium Coffee Experience';
            if (image.complete && image.naturalWidth) revealImage();
            indicators.querySelectorAll('button').forEach((button, buttonIndex) => {
                button.classList.toggle('is-active', buttonIndex === index);
                button.setAttribute('aria-current', buttonIndex === index ? 'true' : 'false');
            });
        };
        images.forEach((slide, index) => {
            const indicator = document.createElement('button');
            indicator.type = 'button';
            indicator.setAttribute('aria-label', `Show ${removeBrandName(slide.caption) || `featured photo ${index + 1}`}`);
            indicator.addEventListener('click', () => showSlide(index));
            indicators.appendChild(indicator);
        });
        showSlide(0);
        images.slice(1).forEach((slide) => {
            const preload = new window.Image();
            preload.src = slide.src;
        });
        if (images.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            coffeeSlideTimer = window.setInterval(() => showSlide((activeIndex + 1) % images.length), 5000);
        }
    }

    async function loadInviteRewards() {
        const list = document.getElementById('inviteRewardsList');
        const status = document.getElementById('inviteRewardsStatus');
        try {
            const [{ inviteRewards }, team] = await Promise.all([
                BmgApi.request('/team/invite-rewards'),
                BmgApi.request('/team/my-team'),
            ]);
            const invitedCount = Number(inviteRewards?.[0]?.invitedCount ?? inviteRewards?.[0]?.invited_count ?? team.memberCount ?? 0);
            const rewards = (inviteRewards || []).map((reward) => ({
                ...reward,
                requiredInvites: Number(reward.requiredInvites ?? reward.required_invites ?? 0),
                invitedCount: Number(reward.invitedCount ?? reward.invited_count ?? team.memberCount ?? 0),
                reward: Number(reward.reward || 0),
                claimed: Boolean(reward.claimed),
            })).filter((reward) => reward.requiredInvites > 0);
            const claimedTotal = rewards.reduce((total, reward) => total + (reward.claimed ? Number(reward.reward) : 0), 0);
            document.getElementById('inviteRewardCount').textContent = Number(invitedCount).toLocaleString();
            document.getElementById('inviteRewardsClaimed').textContent = claimedTotal.toLocaleString();
            document.getElementById('taskReferralLink').value = team.referralCode
                ? createReferralRegistrationLink(team.referralCode)
                : '';
            list.innerHTML = rewards.length ? rewards.map((reward) => {
                const progress = Math.min(100, Math.round(Number(reward.invitedCount) / Number(reward.requiredInvites) * 100));
                const eligible = Number(reward.invitedCount) >= Number(reward.requiredInvites);
                return `<article class="invite-reward-card">
                    <div class="invite-reward-copy"><strong>Invite ${Number(reward.requiredInvites)} people</strong><span>Reward: ${formatMoney(reward.reward)}</span></div>
                    <div class="invite-reward-progress"><div class="invite-reward-progress-track"><span style="width:${progress}%"></span></div><small>${Number(reward.invitedCount)} / ${Number(reward.requiredInvites)} registered</small></div>
                    <button type="button" class="btn btn-primary btn-small invite-claim-button" data-reward-id="${escapeHtml(reward.id)}" ${reward.claimed || !eligible ? 'disabled' : ''}>${reward.claimed ? 'Claimed' : 'Claim'}</button>
                </article>`;
            }).join('') : '<p>No invite rewards are available right now.</p>';
            status.textContent = '';
            status.className = 'form-status';
            list.querySelectorAll('.invite-claim-button:not(:disabled)').forEach((button) => button.addEventListener('click', async () => {
                button.disabled = true;
                status.textContent = '';
                try {
                    const result = await BmgApi.request(`/team/invite-rewards/${encodeURIComponent(button.dataset.rewardId)}/claim`, { method: 'POST' });
                    status.textContent = `Reward claimed: ${formatMoney(result.reward)}.`;
                    status.className = 'form-status success';
                    await Promise.all([loadInviteRewards(), loadUser()]);
                } catch (error) {
                    status.textContent = error.message;
                    status.className = 'form-status error';
                    await loadInviteRewards();
                }
            }));
        } catch (error) {
            list.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
            status.textContent = `Invite rewards could not be loaded: ${error.message}`;
            status.className = 'form-status error';
        }
    }
    document.getElementById('copyTaskReferralLink').addEventListener('click', async () => {
        const status = document.getElementById('inviteRewardsStatus');
        try {
            const link = document.getElementById('taskReferralLink').value;
            if (!link) throw new Error('Referral link is not available yet.');
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
            await navigator.clipboard.writeText(link);
            status.textContent = 'Referral link copied.';
            status.className = 'form-status success';
        } catch (error) {
            status.textContent = error.message;
            status.className = 'form-status error';
        }
    });

    async function loadProducts() {
        const grid = document.getElementById('productGrid');
        const plansGrid = document.getElementById('myPlansGrid');
        try {
            const [{ products }, mine] = await Promise.all([BmgApi.request('/products'), BmgApi.request('/products/mine')]);
            const purchasedProductIds = new Set(mine.purchasedProductIds || []);
            const purchasedProducts = mine.products || [];
            document.getElementById('addProductButton').hidden = purchasedProducts.length === 0;
            plansGrid.innerHTML = purchasedProducts.length ? purchasedProducts.map((product) => {
                const progress = Math.min(100, Math.max(0, Number(product.progress || 0)));
                const endDate = product.endDate ? new Date(product.endDate).toLocaleDateString() : '-';
                return `<article class="my-plan-card">
                    <div class="my-plan-heading"><div><small>MY INVESTMENT</small><h2>${escapeHtml(product.name)}</h2></div><strong>${product.completed ? 'Completed' : 'Active'}</strong></div>
                    <div class="my-plan-metrics">
                        <p>Amount <b>${formatMoney(product.price)}</b></p>
                        <p>Daily income <b>${formatMoney(product.dailyIncome)}</b></p>
                        <p>Days remaining <b>${Number(product.daysRemaining || 0)}</b></p>
                        <p>End date <b>${escapeHtml(endDate)}</b></p>
                    </div>
                    <div class="active-product-progress" aria-label="${progress}% complete"><span style="width:${progress}%"></span></div>
                </article>`;
            }).join('') : '<p class="view-empty-state">You have no plans yet. Choose a product to get started.</p>';
            const sortedProducts = [...products].sort((first, second) => Number(first.price || 0) - Number(second.price || 0));
            grid.innerHTML = sortedProducts.length ? sortedProducts.map((p) => {
                const price = Number(p.price || 0);
                const term = Number(p.investmentDurationDays || p.termDays || p.duration_days || 0);
                const dailyIncome = Number(p.dailyIncomeAmount || p.dailyIncome || Math.round(price * Number(p.dailyIncomePercent || 0) / 100));
                const totalIncome = Number(p.totalIncome || dailyIncome * term);
                const remainingSlots = Math.max(0, Number(p.stock || 0));
                const totalSlots = Math.max(remainingSlots, Number(p.totalSlots || p.total_slots || 0));
                const image = p.imageProxyUrl || p.imageUrl || p.image_url || '';
                const initials = String(p.name || 'Product').split(/\s+/).map((part) => part[0]).join('').slice(0, 3).toUpperCase();
                const productStatus = p.status === 'sold_out' || remainingSlots <= 0 ? 'SOLD OUT' : p.status === 'open_soon' ? 'OPEN SOON' : 'BUY NOW';
                const canPurchase = p.status === 'active' && remainingSlots > 0 && !purchasedProductIds.has(p.id);
                const buttonColor = productActionColor(p.buttonColor);
                const statusLabel = p.status === 'sold_out' || remainingSlots <= 0 ? 'Sold out' : p.status === 'open_soon' ? 'Coming soon' : 'Available';
                return `
                    <article class="product-card" style="--product-accent:${escapeHtml(p.headerColor || '#7a533a')};--product-action:${escapeHtml(buttonColor)};--product-surface:${escapeHtml(p.cardColor || '#51301f')}" data-id="${escapeHtml(p.id)}">
                        <div class="product-card-visual">
                            ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(p.name)}" onerror="this.hidden=true; this.nextElementSibling.hidden=false;"><span class="product-image-fallback" hidden>${escapeHtml(initials)}</span>` : `<span class="product-image-fallback">${escapeHtml(initials)}</span>`}
                            <span class="product-status-badge product-status-${escapeHtml(p.status || 'active')}">${escapeHtml(statusLabel)}</span>
                            ${p.category ? `<span class="product-category-badge">${escapeHtml(p.category)}</span>` : ''}
                        </div>
                        <div class="product-card-content">
                            <div class="product-card-title-row">
                                <div><p class="product-card-eyebrow">INVESTMENT PLAN</p><h2>${escapeHtml(p.name)}</h2></div>
                                <div class="product-price"><small>Starting at</small><strong>${formatMoneyPrefix(price)}</strong></div>
                            </div>
                            ${p.description ? `<p class="product-card-description">${escapeHtml(p.description)}</p>` : ''}
                            <div class="product-card-details">
                                <div><span>Daily return</span><strong>${formatMoneyPrefix(dailyIncome)}</strong></div>
                                <div><span>Total return</span><strong>${formatMoneyPrefix(totalIncome)}</strong></div>
                                <div><span>Plan length</span><strong>${term.toLocaleString()} days</strong></div>
                                <div><span>Slots left</span><strong>${remainingSlots.toLocaleString()}${totalSlots ? ` / ${totalSlots.toLocaleString()}` : ''}</strong></div>
                            </div>
                        </div>
                        <button type="button" class="product-buy-button product-status-${escapeHtml(p.status || 'active')}" data-action="purchase" ${canPurchase ? '' : 'disabled'}>${purchasedProductIds.has(p.id) ? 'Already in my plans' : productStatus}<span aria-hidden="true">${canPurchase ? '→' : ''}</span></button>
                    </article>
                `;
            }).join('') : '<p>No products available yet.</p>';
        } catch (err) {
            grid.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
            plansGrid.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
        }
    }
    function setProductTab(tab) {
        const showPlans = tab === 'mine';
        document.getElementById('allProductsView').hidden = showPlans;
        document.getElementById('myPlansView').hidden = !showPlans;
        document.querySelectorAll('[data-product-tab]').forEach((button) => {
            const selected = button.dataset.productTab === tab;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
    }
    document.querySelectorAll('[data-product-tab]').forEach((button) => button.addEventListener('click', () => setProductTab(button.dataset.productTab)));
    document.getElementById('productGrid').addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-action="purchase"]');
        if (!btn) return;
        const id = btn.closest('.product-card').dataset.id;
        try {
            const result = await BmgApi.request(`/products/${id}/purchase`, { method: 'POST' });
            btn.textContent = 'ALREADY PURCHASED';
            btn.disabled = true;
            loadUser();
        } catch (err) {
            alert(err.message);
        }
    });
    document.getElementById('addProductButton').addEventListener('click', () => {
        setProductTab('all');
        document.getElementById('productGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    let teamCommissionLevels = [];
    let teamReferralCountsByLevel = {};
    let selectedTeamLevel = 1;
    function renderSelectedTeamLevel() {
        const activeLevel = teamCommissionLevels.find((item) => Number(item.level) === selectedTeamLevel);
        if (!activeLevel) return;
        const count = Number(teamReferralCountsByLevel[selectedTeamLevel] || 0);
        document.getElementById('teamSelectedLevelTitle').textContent = `Level ${selectedTeamLevel} earnings`;
        document.getElementById('teamSelectedCommission').textContent = `${Number(activeLevel.percent || 0)}%`;
        document.getElementById('teamLevelMemberCount').textContent = count.toLocaleString();
        document.getElementById('teamLevelEmptyMessage').textContent = count
            ? `${count.toLocaleString()} member${count === 1 ? '' : 's'} in this referral level.`
            : 'No members at this level yet. Share your referral link to start earning.';
        document.querySelectorAll('[data-team-level]').forEach((button) => {
            const active = Number(button.dataset.teamLevel) === selectedTeamLevel;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
    }
    async function loadTeam() {
        const [teamResult, commissionsResult] = await Promise.allSettled([
            BmgApi.request('/team/my-team'),
            BmgApi.request('/team/commissions'),
        ]);
        if (teamResult.status === 'fulfilled') {
            const data = teamResult.value;
            const dataStatus = document.getElementById('teamDataStatus');
            dataStatus.textContent = '';
            dataStatus.className = 'form-status';
            document.getElementById('teamMemberCount').textContent = Number(data.memberCount || 0).toLocaleString();
            document.getElementById('teamTotalEarnings').childNodes[0].textContent = `${Number(data.totalCommissionEarnings || 0).toLocaleString()} `;
            teamReferralCountsByLevel = data.referralCountsByLevel || {};
            const referralCode = data.referralCode || currentUser?.referralCode || '';
            document.getElementById('referralCodeValue').textContent = referralCode || '-';
            document.getElementById('referralLinkValue').value = referralCode ? createReferralRegistrationLink(referralCode) : '';
        } else {
            const errorMessage = escapeHtml(teamResult.reason?.message || 'Unable to load team data.');
            document.getElementById('teamMemberCount').textContent = '-';
            document.getElementById('teamTotalEarnings').textContent = '-';
            teamReferralCountsByLevel = {};
            document.getElementById('referralCodeValue').textContent = currentUser?.referralCode || '-';
            document.getElementById('referralLinkValue').value = '';
            const dataStatus = document.getElementById('teamDataStatus');
            dataStatus.textContent = `Team data could not be loaded: ${teamResult.reason?.message || 'Please try again.'}`;
            dataStatus.className = 'form-status error';
        }

        if (commissionsResult.status === 'fulfilled') {
            teamCommissionLevels = (commissionsResult.value.commissions || []).slice(0, 3);
            if (teamCommissionLevels.length) {
                document.getElementById('teamCommissionDetail').hidden = false;
                if (!teamCommissionLevels.some((commission) => Number(commission.level) === selectedTeamLevel)) {
                    selectedTeamLevel = Number(teamCommissionLevels[0].level);
                }
                document.getElementById('teamCommissionTabs').innerHTML = teamCommissionLevels.map((commission) => {
                    const level = Number(commission.level);
                    return `<button type="button" class="team-commission-tab" role="tab" aria-selected="${level === selectedTeamLevel}" data-team-level="${level}">Level ${level} <span>(${Number(commission.percent || 0)}%)</span></button>`;
                }).join('');
                document.getElementById('teamCommissionTabs').querySelectorAll('[data-team-level]').forEach((button) => {
                    button.addEventListener('click', () => {
                        selectedTeamLevel = Number(button.dataset.teamLevel);
                        renderSelectedTeamLevel();
                    });
                });
                renderSelectedTeamLevel();
            } else {
                document.getElementById('teamCommissionTabs').innerHTML = '<p>No commission levels are configured.</p>';
                document.getElementById('teamCommissionDetail').hidden = true;
            }
        } else {
            document.getElementById('teamCommissionTabs').innerHTML = `<p class="view-error-state">${escapeHtml(commissionsResult.reason?.message || 'Unable to load commission levels.')}</p>`;
            document.getElementById('teamCommissionDetail').hidden = true;
        }
    }
    async function copyInviteValue(value) {
        const status = document.getElementById('teamInviteStatus');
        const text = String(value || '').trim();
        if (!text || text === '-') {
            status.textContent = 'Referral information is not available yet.';
            status.className = 'form-status error';
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            status.textContent = 'Copied to clipboard.';
            status.className = 'form-status success';
        } catch (error) {
            status.textContent = `Could not copy: ${error.message}`;
            status.className = 'form-status error';
        }
    }
    document.getElementById('copyReferralBtn').addEventListener('click', () => copyInviteValue(document.getElementById('referralCodeValue').textContent));
    document.getElementById('copyReferralLinkBtn').addEventListener('click', () => copyInviteValue(document.getElementById('referralLinkValue').value));
    document.querySelectorAll('[data-share-referral]').forEach((button) => button.addEventListener('click', () => {
        const link = document.getElementById('referralLinkValue').value;
        if (!link) return;
        const message = `Join using my invite link: ${link}`;
        const targets = {
            whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
            telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join using my invite link')}`,
            facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`,
        };
        window.open(targets[button.dataset.shareReferral], '_blank', 'noopener,noreferrer');
    }));

    async function loadMe() {
        if (!currentUser) {
            console.error('Cannot load the account view because the current user is unavailable.');
            return;
        }
        document.getElementById('meProfilePhone').textContent = currentUser.phoneNumber || '-';
        document.getElementById('meProfileStatus').textContent = currentUser.status || '-';
        const createdAt = currentUser.createdAt ? new Date(`${String(currentUser.createdAt).replace(' ', 'T')}Z`) : null;
        document.getElementById('meProfileCreated').textContent = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleDateString() : '-';
        document.getElementById('meBalanceAmount').textContent = Number(currentUser.balance || 0).toLocaleString();
        document.getElementById('appearanceSelect').value = currentUser.appearance || 'system';
        document.getElementById('notificationsToggle').checked = localStorage.getItem('bmg_notifications') !== 'false';
        document.getElementById('payoutAccountHolder').value = currentUser.fullName || '';
        await loadPayoutAccount();
    }

    async function loadPayoutAccount() {
        const status = document.getElementById('payoutAccountStatus');
        try {
            const [{ account }, withdrawSettings] = await Promise.all([
                BmgApi.request('/withdrawals/account'),
                BmgApi.request('/settings/withdraw'),
            ]);
            const methodSelect = document.getElementById('payoutMethod');
            const configuredMethods = ['mtn', 'airtel', 'bank'].filter((method) =>
                withdrawSettings.value?.[method] && withdrawSettings.value[method].enabled !== false);
            const methodOptions = configuredMethods.length
                ? configuredMethods.map((method) => new Option(method === 'mtn' ? 'MTN Mobile Money' : method === 'airtel' ? 'Airtel Money' : 'Bank account', method))
                : [new Option('No withdrawal account types are available. Contact support.', '')];
            methodSelect.replaceChildren(...methodOptions);
            methodSelect.disabled = configuredMethods.length === 0;
            document.getElementById('savePayoutAccountBtn').disabled = configuredMethods.length === 0;
            if (account?.method && configuredMethods.includes(account.method)) methodSelect.value = account.method;
            document.getElementById('payoutAccountHolder').value = account?.accountHolderName || currentUser?.fullName || '';
            document.getElementById('payoutMobileNumber').value = account?.mobileMoneyNumber || '';
            document.getElementById('payoutBankName').value = account?.bankName || '';
            document.getElementById('payoutBankNumber').value = account?.bankAccountNumber || '';
            updatePayoutFormFields();
            status.textContent = account ? 'Saved withdrawal account loaded.' : 'No payout account is bound yet.';
            status.className = account ? 'form-status success' : 'form-status';
        } catch (error) {
            const methodSelect = document.getElementById('payoutMethod');
            methodSelect.replaceChildren(new Option('Withdrawal account types could not be loaded.', ''));
            methodSelect.disabled = true;
            document.getElementById('savePayoutAccountBtn').disabled = true;
            status.textContent = `Withdrawal account could not be loaded: ${error.message}`;
            status.className = 'form-status error';
        }
    }

    function updatePayoutFormFields() {
        const isBank = document.getElementById('payoutMethod').value === 'bank';
        document.querySelector('.payout-mobile-field').hidden = isBank;
        document.querySelector('.payout-bank-name-field').hidden = !isBank;
        document.querySelector('.payout-bank-number-field').hidden = !isBank;
    }

    document.getElementById('payoutMethod').addEventListener('change', updatePayoutFormFields);
    document.getElementById('savePayoutAccountBtn').addEventListener('click', async () => {
        const status = document.getElementById('payoutAccountStatus');
        const button = document.getElementById('savePayoutAccountBtn');
        button.disabled = true;
        try {
            const method = document.getElementById('payoutMethod').value;
            const account = {
                method,
                accountHolderName: document.getElementById('payoutAccountHolder').value.trim(),
                mobileMoneyNumber: document.getElementById('payoutMobileNumber').value.replace(/\s+/g, ''),
                bankName: document.getElementById('payoutBankName').value.trim(),
                bankAccountNumber: document.getElementById('payoutBankNumber').value.trim(),
            };
            const response = await BmgApi.request('/withdrawals/account', { method: 'PUT', body: account });
            boundWithdrawalAccount = response.account;
            status.textContent = 'Withdrawal account saved.';
            status.className = 'form-status success';
            await loadWithdrawal();
        } catch (error) {
            status.textContent = error.message;
            status.className = 'form-status error';
        } finally {
            button.disabled = false;
        }
    });

    async function loadSupport() {
        const channels = document.getElementById('supportChannels');
        try {
            const { value } = await BmgApi.request('/settings/support', { auth: false });
            const support = value || {};
            document.getElementById('supportMessage').textContent = removeBrandName(String(support.message || 'Need help? Reach out to support.').replace(/\bMIP\b/gi, 'our support team'));
            document.getElementById('supportAvailability').textContent = 'Online';
            const enabled = support.channelsEnabled || {};
            const telegramValue = support.telegramUsername || support.telegramLink || '';
            const telegramHref = support.telegramLink || (telegramValue ? `https://t.me/${String(telegramValue).replace(/^@/, '')}` : '');
            channels.innerHTML = enabled.telegram && telegramValue
                ? `<a class="support-channel-card" href="${escapeHtml(telegramHref)}" target="_blank" rel="noopener"><span class="support-channel-icon">&#10147;</span><span class="support-channel-copy"><strong>Telegram</strong><small>${escapeHtml(telegramValue)}</small></span><span class="support-channel-arrow">&#8250;</span></a>`
                : '<div class="support-channel-card support-channel-disabled"><span class="support-channel-icon">&#10147;</span><span class="support-channel-copy"><strong>Telegram</strong><small>Not configured yet</small></span></div>';
        } catch (error) { channels.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
    }

    async function loadHistory(category = 'all') {
        const list = document.getElementById('historyList');
        try {
            const { items } = await BmgApi.request(`/users/history?category=${category}&limit=50`);
            list.innerHTML = items.length ? items.map((item) => `
                <div class="history-item">
                    <div><strong>${escapeHtml(item.type)}</strong><p>${escapeHtml(item.description)}</p></div>
                    <div><div class="history-amount ${item.direction === 'debit' ? 'debit' : 'credit'}">${item.direction === 'debit' ? '-' : '+'} ${Number(item.amount || 0).toLocaleString()} ${escapeHtml(item.unit || currentUser?.currency || 'RWF')}</div><small>${escapeHtml(item.status || '')}</small></div>
                </div>
            `).join('') : '<p>No history yet.</p>';
        } catch (err) {
            list.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
        }

        document.addEventListener('bmg:notifications', (event) => {
            const financialChange = event.detail?.notifications?.some((notification) =>
                ['deposit', 'withdrawal'].includes(notification.relatedType));
            if (!financialChange) return;
            loadUser().catch((error) => console.error('Could not refresh account after a financial update:', error));
            const activeView = document.querySelector('.dash-view:not([hidden])')?.id.replace('view-', '');
            if (activeView === 'history') {
                const selectedCategory = document.querySelector('[data-history-category].active')?.dataset.historyCategory || 'all';
                loadHistory(selectedCategory);
            } else if (activeView === 'deposit') {
                loadDeposit();
            } else if (activeView === 'withdraw') {
                loadWithdrawal();
            }
        });
    }
    document.querySelectorAll('[data-history-category]').forEach((button) => button.addEventListener('click', () => {
        document.querySelectorAll('[data-history-category]').forEach((item) => item.classList.toggle('active', item === button));
        loadHistory(button.dataset.historyCategory);
    }));
    document.getElementById('notificationsToggle').addEventListener('change', (event) => localStorage.setItem('bmg_notifications', event.target.checked ? 'true' : 'false'));

    let depositSettings = null;
    let withdrawSettings = null;
    let boundWithdrawalAccount = null;
    let withdrawableBalance = 0;
    let withdrawalWindowOpen = true;
    function renderMethodCards(containerId, selectId, settings, type) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const supportedMethods = type === 'withdraw' ? ['mtn', 'airtel', 'bank'] : ['mtn', 'airtel'];
        const methods = settings?.enabled === false ? [] : supportedMethods.filter((method) => settings?.[method] && settings[method].enabled !== false);
        const select = document.getElementById(selectId);
        if (!methods.includes(select.value)) select.value = methods[0] || '';
        select.innerHTML = methods.map((method) => `<option value="${method}">${method === 'mtn' ? 'MTN MoMo' : method === 'airtel' ? 'Airtel Money' : 'Bank Account'}</option>`).join('');
        container.innerHTML = methods.map((method) => {
            const config = settings[method] || {};
            const min = Number(config.min ?? settings.minimumAmount ?? settings.minAmount ?? 0).toLocaleString();
            const max = Number(config.max ?? settings.maximumAmount ?? settings.maxAmount ?? 0).toLocaleString();
            const label = method === 'bank' ? 'Bank Account' : type === 'withdraw' ? (method === 'mtn' ? 'MTN MoMo' : 'Airtel Money') : (method === 'mtn' ? 'MTN Mobile Money' : 'Airtel Money');
            const icon = method === 'mtn' ? '💛' : method === 'airtel' ? '❤️' : '🏦';
            return `<button type="button" class="payment-method-card ${method === select.value ? 'selected' : ''}" data-method="${method}" data-select="${selectId}"><span class="method-letter">${icon}</span><span><strong>${label}</strong><small>${formatMoney(min)} - ${formatMoney(max)}</small></span></button>`;
        }).join('') || '<p class="view-empty-state">No payment methods are currently available.</p>';
        container.querySelectorAll('[data-method]').forEach((button) => button.addEventListener('click', () => {
            document.getElementById(button.dataset.select).value = button.dataset.method;
            container.querySelectorAll('[data-method]').forEach((item) => item.classList.toggle('selected', item === button));
            if (type === 'deposit') {
                renderDepositDetails();
                renderDepositAmountOptions();
            } else updateWithdrawalLimits();
        }));
    }
    function getDepositLimits(method) {
        const config = depositSettings?.[method] || {};
        return {
            min: Number(config.min ?? depositSettings?.minimumAmount ?? 1),
            max: Number(config.max ?? depositSettings?.maximumAmount ?? Number.MAX_SAFE_INTEGER),
        };
    }
    function renderDepositAmountOptions() {
        const method = document.getElementById('depositMethod').value;
        const config = depositSettings?.[method] || {};
        const limits = getDepositLimits(method);
        const configured = Array.isArray(config.availableAmounts) ? config.availableAmounts : depositSettings?.availableAmounts;
        const candidates = Array.isArray(configured) && configured.length ? configured.map(Number) : [limits.min, 6000, 12000, 25000, 60000, 100000];
        const amounts = [...new Set(candidates.filter((amount) => Number.isInteger(amount) && amount >= limits.min && amount <= limits.max))].slice(0, 6);
        const options = document.getElementById('depositAmountOptions');
        options.innerHTML = amounts.map((amount) => `<button type="button" class="deposit-amount-option${Number(document.getElementById('depositAmount').value) === amount ? ' selected' : ''}" data-amount="${amount}">${formatMoney(amount)}</button>`).join('');
        if (!amounts.length) options.innerHTML = '<small>Enter an amount within the configured deposit limits.</small>';
        options.querySelectorAll('[data-amount]').forEach((button) => button.addEventListener('click', () => {
            document.getElementById('depositAmount').value = button.dataset.amount;
            options.querySelectorAll('[data-amount]').forEach((option) => option.classList.toggle('selected', option === button));
            renderDepositDetails();
        }));
    }
    function renderDepositDetails() {
        const method = document.getElementById('depositMethod').value;
        const config = depositSettings?.[method] || {};
        const amount = Number(document.getElementById('depositAmount').value || 0);
        const amountInput = document.getElementById('depositAmount');
        const proof = document.getElementById('depositPaymentProof');
        const limits = getDepositLimits(method);
        amountInput.min = String(limits.min);
        amountInput.max = String(limits.max);
        proof.required = !!depositSettings?.proofRequired;
        document.getElementById('depositDetailsTitle').textContent = `${method === 'mtn' ? 'MTN' : 'Airtel'} MoMo merchant details`;
        document.getElementById('depositMerchantName').textContent = config.merchantName || '-';
        document.getElementById('depositMerchantPhone').textContent = config.merchantPhone || '-';
        const merchantCode = String(config.merchantCode || '').replace(/[^0-9]/g, '');
        let instructions = config.instructions || depositSettings?.instructions || '';
        if (!instructions || /\*182\*/i.test(instructions)) {
            instructions = method === 'mtn' && merchantCode
                ? `Dial *182*8*1*${merchantCode}*${amount || 'AMOUNT'}# or pay to the merchant number above.`
                : `Pay to the merchant number above from your ${method === 'mtn' ? 'MTN' : 'Airtel Money'} menu, then submit your transaction reference.`;
        }
        document.getElementById('depositInstructions').textContent = instructions;
        document.getElementById('depositPayButton').textContent = `☎ PAY ${formatMoneyPrefix(amount)} NOW`;
        document.getElementById('depositPayButton').disabled = depositSettings?.enabled === false || config.enabled === false || !config.merchantPhone || amount < limits.min || amount > limits.max;
        document.getElementById('depositSubmitBtn').disabled = depositSettings?.enabled === false || config.enabled === false || amount < limits.min || amount > limits.max;
    }
    async function loadDeposit() {
        try {
            const response = await BmgApi.request('/settings/deposit');
            depositSettings = response.value || {};
            renderMethodCards('depositMethodCards', 'depositMethod', depositSettings, 'deposit');
            renderDepositAmountOptions();
            renderDepositDetails();
            if (!document.getElementById('depositSenderPhone').value) document.getElementById('depositSenderPhone').value = currentUser?.phoneNumber || '';
            if (depositSettings.enabled === false) {
                document.getElementById('depositStatus').textContent = 'Deposits are temporarily unavailable.';
                document.getElementById('depositStatus').className = 'form-status error';
            }
        } catch (error) {
            document.getElementById('depositStatus').textContent = `Deposit settings could not be loaded: ${error.message}`;
            document.getElementById('depositStatus').className = 'form-status error';
        }
    }
    function updateWithdrawalLimits() {
        const method = boundWithdrawalAccount?.method;
        const methodSettings = withdrawSettings?.[method] || {};
        const minimum = Number(methodSettings.min ?? withdrawSettings?.minAmount ?? 1);
        const maximum = Math.min(Number(methodSettings.max ?? withdrawSettings?.maxAmount ?? Number.MAX_SAFE_INTEGER), withdrawableBalance);
        const amount = document.getElementById('withdrawAmount');
        amount.min = String(minimum);
        amount.max = String(maximum);
        document.getElementById('withdrawMinimumMessage').textContent = `Minimum withdrawal: ${formatMoney(minimum)}`;
        const ruleMinimum = document.getElementById('withdrawRulesMinimum');
        if (ruleMinimum) ruleMinimum.textContent = `Minimum withdrawal: ${formatMoney(minimum)}.`;
        updateWithdrawalCalculation();
    }
    function isWithdrawalWindowOpen(availability) {
        if (!availability?.enabled) return true;
        const timeZone = availability.timeZone || 'Africa/Kigali';
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        const currentDay = values.weekday;
        const currentMinute = Number(values.hour) * 60 + Number(values.minute);
        const openMinute = Number(availability.openHour ?? 0) * 60;
        const closeMinute = Number(availability.closeHour ?? 24) * 60;
        const days = Array.isArray(availability.days) ? availability.days : [];
        if (openMinute <= closeMinute) return days.includes(currentDay) && currentMinute >= openMinute && currentMinute < closeMinute;

        const week = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayIndex = week.indexOf(currentDay);
        const previousDay = week[(dayIndex + 6) % 7];
        return (days.includes(currentDay) && currentMinute >= openMinute) ||
            (days.includes(previousDay) && currentMinute < closeMinute);
    }
    async function loadWithdrawal() {
        try {
            const [response, accountResponse, eligibleResponse] = await Promise.all([
                BmgApi.request('/settings/withdraw'),
                BmgApi.request('/withdrawals/account'),
                BmgApi.request('/withdrawals/eligible'),
            ]);
            withdrawSettings = response.value || {};
            boundWithdrawalAccount = accountResponse.account;
            withdrawableBalance = Number(eligibleResponse.withdrawable || 0);
            document.getElementById('withdrawBalance').textContent = formatMoneyPrefix(withdrawableBalance);
            document.getElementById('withdrawBonusMessage').textContent = 'Only eligible earnings and rewards can be withdrawn.';
            const accountType = { mtn: 'MTN Mobile Money', airtel: 'Airtel Money', bank: 'Bank account' };
            document.getElementById('withdrawAccountType').textContent = boundWithdrawalAccount ? accountType[boundWithdrawalAccount.method] || 'Saved account' : 'No account bound';
            document.getElementById('withdrawAccountDetails').textContent = boundWithdrawalAccount
                ? boundWithdrawalAccount.method === 'bank'
                    ? `${boundWithdrawalAccount.accountHolderName} · ${boundWithdrawalAccount.bankName} · ${boundWithdrawalAccount.bankAccountNumber}`
                    : `${boundWithdrawalAccount.accountHolderName} · ${boundWithdrawalAccount.mobileMoneyNumber}`
                : 'Add a withdrawal account in Me before requesting a payout.';
            document.getElementById('withdrawFeeRate').textContent = `${Number(withdrawSettings.feePercent || 0)}%`;
            const availability = withdrawSettings.availability || {};
            const days = availability.days?.length ? availability.days.join(', ') : 'configured days';
            withdrawalWindowOpen = isWithdrawalWindowOpen(availability);
            document.getElementById('withdrawAvailability').textContent = availability.enabled
                ? `${withdrawalWindowOpen ? 'Cash-out open' : 'Cash-out closed'} · ${days} · ${availability.openHour ?? 0}:00-${availability.closeHour ?? 24}:00 ${availability.timezoneLabel || 'Kigali time'}`
                : 'Cash-out is available at any time.';
            document.getElementById('withdrawRules').innerHTML = `<strong>📌 Withdrawal Rules &amp; Hours</strong><ol><li id="withdrawRulesMinimum">Minimum withdrawal: ${escapeHtml(formatMoney(0))}.</li><li>Cash-out hours: ${availability.enabled ? `${escapeHtml(days)} · ${availability.openHour ?? 0}:00-${availability.closeHour ?? 24}:00 ${escapeHtml(availability.timezoneLabel || currentUser?.country?.timeZone || 'Local time')}` : 'Available at any time'}.</li><li>Withdrawal fee: ${Number(withdrawSettings.feePercent || 0)}%.</li><li>${escapeHtml(removeBrandName(withdrawSettings.processingMessage || 'Payout requests are reviewed before payment.'))}</li></ol><small>— Secure payouts —</small>`;
            updateWithdrawalLimits();
        } catch (error) {
            document.getElementById('withdrawStatus').textContent = `Withdrawal settings could not be loaded: ${error.message}`;
            document.getElementById('withdrawStatus').className = 'form-status error';
        }
    }
    function updateWithdrawalCalculation() {
        const amountInput = document.getElementById('withdrawAmount');
        const amount = Number(amountInput.value || 0);
        const fee = Math.round(amount * Number(withdrawSettings?.feePercent || 0) / 100);
        document.getElementById('withdrawFeeAmount').textContent = formatMoneyPrefix(fee);
        document.getElementById('withdrawReceivedAmount').textContent = formatMoneyPrefix(Math.max(0, amount - fee));
        const minimum = Number(amountInput.min || 1);
        const maximum = Number(amountInput.max || Number.MAX_SAFE_INTEGER);
        document.getElementById('withdrawSubmitBtn').disabled = !withdrawalWindowOpen || !boundWithdrawalAccount || amount < minimum || amount > maximum || amount > withdrawableBalance;
    }
    document.getElementById('depositAmount').addEventListener('input', () => {
        renderDepositDetails();
        renderDepositAmountOptions();
    });
    document.getElementById('withdrawAmount').addEventListener('input', updateWithdrawalCalculation);
    document.querySelectorAll('#view-deposit [data-copy-target]').forEach((button) => button.addEventListener('click', async () => {
        const value = document.getElementById(button.dataset.copyTarget).textContent.trim();
        const status = document.getElementById('depositStatus');
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
            await navigator.clipboard.writeText(value);
            status.textContent = 'Copied to clipboard.';
            status.className = 'form-status success';
        } catch (error) {
            console.error('Could not copy deposit details:', error);
            status.textContent = 'Could not copy this detail. Please select and copy it manually.';
            status.className = 'form-status error';
        }
    }));
    document.getElementById('depositPayButton').addEventListener('click', async () => {
        const method = document.getElementById('depositMethod').value;
        const config = depositSettings?.[method] || {};
        const amount = Math.round(Number(document.getElementById('depositAmount').value || 0));
        const merchantPhone = String(config.merchantPhone || '').replace(/[^0-9]/g, '');
        const status = document.getElementById('depositStatus');
        const amountInput = document.getElementById('depositAmount');
        if (!amount || amount < Number(amountInput.min || 1) || (amountInput.max && amount > Number(amountInput.max))) {
            status.textContent = 'Enter an amount within the configured deposit limits.';
            status.className = 'form-status error';
            return;
        }
        if (!merchantPhone) {
            status.textContent = `The ${method === 'mtn' ? 'MTN' : 'Airtel'} receiving number has not been configured.`;
            status.className = 'form-status error';
            return;
        }
        const merchantCode = String(config.merchantCode || '').replace(/[^0-9]/g, '');
        if (method === 'mtn' && merchantCode) {
            const ussd = `*182*8*1*${merchantCode}*${amount}#`;
            window.location.href = `tel:${ussd.replace('#', '%23')}`;
            status.textContent = 'Complete the MTN payment, then enter the transaction reference and submit for verification.';
        } else {
            try {
                if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
                await navigator.clipboard.writeText(merchantPhone);
                status.textContent = `Merchant number copied. Complete the transfer, then enter the transaction reference and submit for verification.`;
            } catch (error) {
                console.error('Could not copy merchant number:', error);
                status.textContent = 'Use the merchant number shown above to complete the transfer, then enter the transaction reference and submit for verification.';
            }
        }
        status.className = 'form-status';
    });

    document.getElementById('appearanceSelect').addEventListener('change', async (event) => {
        const status = document.getElementById('preferencesStatus');
        try {
            await BmgApi.request('/auth/appearance', { method: 'PUT', body: { appearance: event.target.value } });
            applyAppearance(event.target.value);
            status.textContent = 'Preferences saved.';
            status.className = 'form-status success';
        } catch (err) {
            status.textContent = err.message;
            status.className = 'form-status error';
        }
    });

    document.getElementById('changePasswordBtn').addEventListener('click', async () => {
        const status = document.getElementById('passwordStatus');
        const currentPassword = document.getElementById('currentPassword').value;
        const newPasswordInput = document.getElementById('newPassword');
        const newPassword = newPasswordInput.value.replace(/\D/g, '').slice(0, 5);
        newPasswordInput.value = newPassword;
        if (!/^\d{5}$/.test(newPassword)) {
            status.textContent = 'New password must contain exactly 5 digits.';
            status.className = 'form-status error';
            return;
        }
        try {
            await BmgApi.request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
            status.textContent = 'Password updated.';
            status.className = 'form-status success';
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
        } catch (err) {
            status.textContent = err.message;
            status.className = 'form-status error';
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        BmgApi.clearSession('user');
        window.location.href = 'login.html';
    });

    document.getElementById('depositSubmitBtn').addEventListener('click', async () => {
        const status = document.getElementById('depositStatus');
        const submit = document.getElementById('depositSubmitBtn');
        const amount = Number(document.getElementById('depositAmount').value);
        const amountInput = document.getElementById('depositAmount');
        const paymentProof = document.getElementById('depositPaymentProof').value.trim();
        if (!Number.isInteger(amount) || amount < Number(amountInput.min) || amount > Number(amountInput.max)) {
            status.textContent = 'Enter a whole-number amount within the configured deposit limits.';
            status.className = 'form-status error';
            return;
        }
        if (document.getElementById('depositPaymentProof').required && !paymentProof) {
            status.textContent = 'Enter the transaction reference from your payment receipt.';
            status.className = 'form-status error';
            return;
        }
        if (!/^07\d{8}$/.test(document.getElementById('depositSenderPhone').value.replace(/\s+/g, ''))) {
            status.textContent = 'Enter a valid 10-digit payment phone number starting with 07.';
            status.className = 'form-status error';
            return;
        }
        submit.disabled = true;
        try {
            const result = await BmgApi.request('/deposits', {
                method: 'POST',
                body: {
                    method: document.getElementById('depositMethod').value,
                    amount,
                    senderName: currentUser?.fullName || '',
                    senderPhone: document.getElementById('depositSenderPhone').value.replace(/\s+/g, ''),
                    paymentProof,
                },
            });
            status.textContent = `Deposit ${result.status}. It will be credited after verification.`;
            status.className = 'form-status success';
        } catch (err) {
            status.textContent = err.message;
            status.className = 'form-status error';
            submit.disabled = false;
        }
    });

    document.getElementById('withdrawSubmitBtn').addEventListener('click', async () => {
        const status = document.getElementById('withdrawStatus');
        const submit = document.getElementById('withdrawSubmitBtn');
        submit.disabled = true;
        try {
            const result = await BmgApi.request('/withdrawals', {
                method: 'POST',
                body: {
                    amount: Number(document.getElementById('withdrawAmount').value),
                },
            });
            status.textContent = `Withdrawal ${result.status}.`;
            status.className = 'form-status success';
            await Promise.all([loadUser(), loadWithdrawal()]);
        } catch (err) {
            status.textContent = err.message;
            status.className = 'form-status error';
            updateWithdrawalCalculation();
        }
    });

    try {
        await loadUser();
        startPresenceTracking();
        loadHome();
    } catch (err) {
        window.location.href = 'login.html';
    }
});
