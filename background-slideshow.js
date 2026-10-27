document.addEventListener('DOMContentLoaded', () => {
    const slides = Array.from(document.querySelectorAll('.photo-background-slide'));
    if (slides.length < 2) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let activeIndex = slides.findIndex((slide) => slide.classList.contains('is-active'));
    if (activeIndex < 0) activeIndex = 0;
    let timer;

    const rotateSlides = () => {
        window.clearInterval(timer);
        if (motionPreference.matches) return;

        timer = window.setInterval(() => {
            slides[activeIndex].classList.remove('is-active');
            activeIndex = (activeIndex + 1) % slides.length;
            slides[activeIndex].classList.add('is-active');
        }, 5000);
    };

    rotateSlides();
    motionPreference.addEventListener('change', rotateSlides);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
});
