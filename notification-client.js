// Shared database-backed notification polling for User and Admin pages.
(function initializeNotificationClient() {
    const role = document.body?.classList.contains('admin-body') ? 'admin' : 'user';
    const seenKey = `bmg_seen_notifications_${role}`;
    const muteKey = 'bmg_notifications';
    const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));
    let audioContext = null;
    let initialPollCompleted = false;

    function unlockSound() {
        if (!audioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            audioContext = new AudioContext();
        }
        if (audioContext.state === 'suspended') audioContext.resume();
    }

    function playSound() {
        if (localStorage.getItem(muteKey) === 'false' || !audioContext) return;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 740;
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.18);
    }

    function showToast(notification) {
        const toast = document.createElement('div');
        toast.className = 'notification-toast';
        toast.innerHTML = '<strong></strong><span></span>';
        toast.querySelector('strong').textContent = notification.title;
        toast.querySelector('span').textContent = notification.message;
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 5000);
    }

    function addMuteControl() {
        if (document.getElementById('notificationSoundToggle')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'notificationSoundToggle';
        button.className = 'notification-sound-toggle';
        button.title = 'Toggle notification sound';
        const updateLabel = () => {
            const muted = localStorage.getItem(muteKey) === 'false';
            button.textContent = muted ? 'Sound off' : 'Sound on';
            button.setAttribute('aria-pressed', String(!muted));
        };
        button.addEventListener('click', () => {
            unlockSound();
            localStorage.setItem(muteKey, localStorage.getItem(muteKey) === 'false' ? 'true' : 'false');
            updateLabel();
        });
        document.body.appendChild(button);
        updateLabel();
    }

    async function poll() {
        try {
            const { notifications = [] } = await BmgApi.request('/notifications');
            const fresh = notifications.filter((notification) => !seen.has(notification.id)).reverse();
            if (!initialPollCompleted) {
                initialPollCompleted = true;
                fresh.forEach((notification) => seen.add(notification.id));
                if (fresh.length) localStorage.setItem(seenKey, JSON.stringify(Array.from(seen).slice(-100)));
                return;
            }
            fresh.forEach((notification) => {
                seen.add(notification.id);
                showToast(notification);
                playSound();
            });
            if (fresh.length) {
                localStorage.setItem(seenKey, JSON.stringify(Array.from(seen).slice(-100)));
                document.dispatchEvent(new CustomEvent('bmg:notifications', { detail: { notifications: fresh } }));
            }
        } catch (_) {
            // The next poll retries automatically after temporary API failures.
        }
    }

    document.addEventListener('pointerdown', unlockSound, { once: true });
    document.addEventListener('keydown', unlockSound, { once: true });
    addMuteControl();
    poll();
    window.setInterval(poll, 8000);
})();
