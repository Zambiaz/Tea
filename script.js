const COUNTRY_LOCATION_BOUNDARIES = {
    RW: [[30.419105, -1.134659], [30.816135, -1.698914], [30.758309, -2.28725], [30.469696, -2.413858], [29.938359, -2.348487], [29.632176, -2.917858], [29.024926, -2.839258], [29.117479, -2.292211], [29.254835, -2.21511], [29.291887, -1.620056], [29.579466, -1.341313], [29.821519, -1.443322]],
    UG: [[31.86617, -1.02736], [30.76986, -1.01455], [30.419105, -1.134659], [29.821519, -1.443322], [29.579466, -1.341313], [29.587838, -0.587406], [29.8195, -0.2053], [29.875779, 0.59738], [30.086154, 1.062313], [30.468508, 1.583805], [30.85267, 1.849396], [31.174149, 2.204465], [30.77332, 2.33989], [30.83385, 3.50917], [31.24556, 3.7819], [31.88145, 3.55827], [32.68642, 3.79232], [33.39, 3.79], [34.005, 4.249885], [34.47913, 3.5556], [34.59607, 3.05374], [35.03599, 1.90584], [34.6721, 1.17694], [34.18, 0.515], [33.893569, 0.109814], [33.903711, -0.95]],
    ZM: [[32.759375, -9.230599], [33.231388, -9.676722], [33.485688, -10.525559], [33.31531, -10.79655], [33.114289, -11.607198], [33.306422, -12.435778], [32.991764, -12.783871], [32.688165, -13.712858], [33.214025, -13.97186], [30.179481, -14.796099], [30.274256, -15.507787], [29.516834, -15.644678], [28.947463, -16.043051], [28.825869, -16.389749], [28.467906, -16.4684], [27.598243, -17.290831], [27.044427, -17.938026], [26.706773, -17.961229], [26.381935, -17.846042], [25.264226, -17.73654], [25.084443, -17.661816], [25.07695, -17.578823], [24.682349, -17.353411], [24.033862, -17.295843], [23.215048, -17.523116], [22.562478, -16.898451], [21.887843, -16.08031], [21.933886, -12.898437], [24.016137, -12.911046], [23.930922, -12.565848], [24.079905, -12.191297], [23.904154, -11.722282], [24.017894, -11.237298], [23.912215, -10.926826], [24.257155, -10.951993], [24.314516, -11.262826], [24.78317, -11.238694], [25.418118, -11.330936], [25.75231, -11.784965], [26.553088, -11.92444], [27.16442, -11.608748], [27.388799, -12.132747], [28.155109, -12.272481], [28.523562, -12.698604], [28.934286, -13.248958], [29.699614, -13.257227], [29.616001, -12.178895], [29.341548, -12.360744], [28.642417, -11.971569], [28.372253, -11.793647], [28.49607, -10.789884], [28.673682, -9.605925], [28.449871, -9.164918], [28.734867, -8.526559], [29.002912, -8.407032], [30.346086, -8.238257], [30.740015, -8.340007], [31.157751, -8.594579], [31.556348, -8.762049], [32.191865, -8.930359]],
    BI: [[29.339998, -4.499983], [29.276384, -3.293907], [29.024926, -2.839258], [29.632176, -2.917858], [29.938359, -2.348487], [30.469696, -2.413858], [30.527677, -2.807632], [30.743013, -3.034285], [30.752263, -3.35933], [30.50556, -3.568567], [30.116333, -4.090138], [29.753512, -4.452389]],
};

const FALLBACK_COUNTRIES = Object.freeze([
    { code: 'RW', name: 'Rwanda', currency: 'RWF', flag: '🇷🇼', flagImage: '/assets/flags/rw.svg', dialCode: '+250', enabled: true },
    { code: 'UG', name: 'Uganda', currency: 'UGX', flag: '🇺🇬', flagImage: '/assets/flags/ug.svg', dialCode: '+256', enabled: true },
    { code: 'ZM', name: 'Zambia', currency: 'ZMW', flag: '🇿🇲', flagImage: '/assets/flags/zm.svg', dialCode: '+260', enabled: true },
    { code: 'BI', name: 'Burundi', currency: 'BIF', flag: '🇧🇮', flagImage: '/assets/flags/bi.svg', dialCode: '+257', enabled: true },
    { code: 'CD', name: 'DR Congo', currency: 'CDF', flag: '🇨🇩', flagImage: '/assets/flags/cd.svg', dialCode: '+243', enabled: true },
    { code: 'KE', name: 'Kenya', currency: 'KES', flag: '🇰🇪', flagImage: '/assets/flags/ke.svg', dialCode: '+254', enabled: true },
    { code: 'SO', name: 'Somalia', currency: 'SOS', flag: '🇸🇴', flagImage: '/assets/flags/so.svg', dialCode: '+252', enabled: true },
    { code: 'SS', name: 'South Sudan', currency: 'SSP', flag: '🇸🇸', flagImage: '/assets/flags/ss.svg', dialCode: '+211', enabled: true },
    { code: 'TZ', name: 'Tanzania', currency: 'TZS', flag: '🇹🇿', flagImage: '/assets/flags/tz.svg', dialCode: '+255', enabled: true },
]);
const COUNTRY_PHONE_PLACEHOLDERS = Object.freeze({
    RW: '7XXXXXXXX',
    UG: '7XXXXXXXX',
    ZM: '9XXXXXXXX',
    BI: 'XXXXXXXX',
    CD: '9XXXXXXXX',
    KE: '7XXXXXXXX',
    SO: 'XXXXXXXXX',
    SS: '9XXXXXXXX',
    TZ: '7XXXXXXXX',
});

async function loadAvailableCountries() {
    try {
        const { countries } = await BmgApi.request('/countries', { auth: false, timeoutMs: 1500 });
        const enabledCountries = countries.filter((country) => country.enabled);
        if (!enabledCountries.length) throw new Error('No countries are currently enabled.');
        return { countries: enabledCountries, fallback: false };
    } catch (error) {
        return { countries: FALLBACK_COUNTRIES, fallback: true, error };
    }
}

function renderCountryOptions(select, countries, preferredCode) {
    const selectedCode = select.value || preferredCode;
    select.replaceChildren(new Option('Select', ''));
    countries.forEach((country) => {
        select.add(new Option(`${country.name} (${country.dialCode})`, country.code));
    });
    if (countries.some((country) => country.code === selectedCode)) {
        select.value = selectedCode;
    }
}

function countryAtCoordinates(latitude, longitude) {
    for (const [countryCode, boundary] of Object.entries(COUNTRY_LOCATION_BOUNDARIES)) {
        let inside = false;
        for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
            const [xi, yi] = boundary[i];
            const [xj, yj] = boundary[j];
            if ((yi > latitude) !== (yj > latitude)
                && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        if (inside) return countryCode;
    }
    return null;
}

function detectCountryFromLocation(countries) {
    if (!navigator.geolocation || !window.isSecureContext) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            ({ coords }) => {
                const detectedCode = countryAtCoordinates(coords.latitude, coords.longitude);
                resolve(countries.some((country) => country.code === detectedCode) ? detectedCode : null);
            },
            reject,
            { enableHighAccuracy: false, maximumAge: 300000, timeout: 12000 },
        );
    });
}

// Handles client-side validation for the registration form.
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('registerForm');
    if (!form) return;

    const fullName = document.getElementById('fullName');
    const phoneNumber = document.getElementById('phoneNumber');
    const password = document.getElementById('password');
    const countryCode = document.getElementById('countryCode');
    const countryFlag = document.getElementById('countryFlag');
    const confirmPassword = document.getElementById('confirmPassword');
    const referralCode = document.getElementById('referralCode');
    const referralAttribution = document.getElementById('referralAttribution');
    const formStatus = document.getElementById('formStatus');
    const togglePassword = document.getElementById('togglePassword');
    const phoneDialCode = document.getElementById('phoneDialCode');
    const query = new URLSearchParams(window.location.search);
    const referralFromLink = (query.get('ref') || query.get('referralCode') || '').trim();
    const linkedCountryCode = (query.get('country') || query.get('countryCode') || '').trim().toUpperCase();
    let availableCountries = [...FALLBACK_COUNTRIES];
    const phonePatterns = {
        RW: /^0?7\d{8}$/,
        UG: /^0?7\d{8}$/,
        ZM: /^0?9\d{8}$/,
        BI: /^[267]\d{7}$/,
        CD: /^0?[89]\d{8}$/,
        KE: /^0?[17]\d{8}$/,
        SO: /^0?[679]\d{8}$/,
        SS: /^0?[79]\d{8}$/,
        TZ: /^0?[6789]\d{8}$/,
    };

    const updatePhoneDialCode = () => {
        const selectedCountry = availableCountries.find((country) => country.code === countryCode.value);
        phoneDialCode.textContent = selectedCountry?.dialCode || '';
        const phoneLength = selectedCountry?.code === 'BI' ? 8 : selectedCountry ? 10 : 0;
        phoneNumber.removeAttribute('minlength');
        phoneNumber.removeAttribute('maxlength');
        phoneNumber.maxLength = phoneLength || 10;
        phoneNumber.minLength = selectedCountry?.code === 'BI' ? 8 : selectedCountry ? 9 : 0;
        phoneNumber.placeholder = selectedCountry
            ? COUNTRY_PHONE_PLACEHOLDERS[selectedCountry.code] || 'Enter local phone number'
            : 'Select a country first';
        countryFlag.hidden = !selectedCountry?.flagImage;
        if (selectedCountry?.flagImage) {
            countryFlag.src = selectedCountry.flagImage;
            countryFlag.alt = `${selectedCountry.name} flag`;
        } else {
            countryFlag.removeAttribute('src');
            countryFlag.alt = '';
        }
        phoneNumber.value = phoneNumber.value.replace(/\D/g, '').slice(0, phoneNumber.maxLength);
        validateForm();
    };
    const updateCountryLinks = () => {
        const suffix = countryCode.value ? `?country=${encodeURIComponent(countryCode.value)}` : '';
        document.querySelectorAll('.coffee-auth-tabs a, .auth-alt-action a').forEach((link) => {
            link.href = `${link.getAttribute('href').split('?')[0]}${suffix}`;
        });
    };
    renderCountryOptions(countryCode, availableCountries, linkedCountryCode);
    countryCode.addEventListener('change', updatePhoneDialCode);
    countryCode.addEventListener('change', updateCountryLinks);
    updatePhoneDialCode();
    updateCountryLinks();

    loadAvailableCountries().then(({ countries, fallback, error }) => {
        const selectedCode = countryCode.value;
        availableCountries = countries;
        renderCountryOptions(countryCode, availableCountries, selectedCode || linkedCountryCode);
        updatePhoneDialCode();
        updateCountryLinks();
        if (fallback) {
            formStatus.textContent = `Country options are available, but registration needs the service connection. ${error.message}`;
            formStatus.className = 'form-status error';
        } else if (!countryCode.value) {
            formStatus.textContent = '';
            detectCountryFromLocation(availableCountries).then((detectedCode) => {
                if (!countryCode.value && detectedCode) {
                    countryCode.value = detectedCode;
                    updatePhoneDialCode();
                    updateCountryLinks();
                    formStatus.textContent = 'Country selected from your browser location. You can change it from the country list.';
                    formStatus.className = 'form-status success';
                } else if (!countryCode.value) {
                    formStatus.textContent = 'Could not detect a supported country. Choose one from the country list.';
                }
            }).catch(() => {
                if (!countryCode.value) {
                    formStatus.textContent = 'Location permission was not granted. Choose your country from the list.';
                }
            });
        }
    });

    if (referralFromLink) {
        referralCode.value = referralFromLink;
        referralCode.readOnly = true;
        referralAttribution.textContent = `Referred with code: ${referralFromLink}`;
        referralAttribution.hidden = false;
    }

    if (togglePassword) {
        togglePassword.addEventListener('click', () => {
            const isHidden = password.type === 'password';
            password.type = isHidden ? 'text' : 'password';
            togglePassword.setAttribute('aria-pressed', String(isHidden));
            togglePassword.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        });
    }

    function setError(input, errorId, message) {
        const errorEl = document.getElementById(errorId);
        if (message) {
            input.classList.add('invalid');
            errorEl.textContent = message;
        } else {
            input.classList.remove('invalid');
            errorEl.textContent = '';
        }
    }

    function validateForm() {
        let isValid = true;

        if (!countryCode.value) {
            setError(countryCode, 'countryCodeError', 'Choose your country.');
            isValid = false;
        } else {
            setError(countryCode, 'countryCodeError', '');
        }

        if (!fullName.value.trim()) {
            setError(fullName, 'fullNameError', 'Full name is required.');
            isValid = false;
        } else {
            setError(fullName, 'fullNameError', '');
        }

        const phoneValue = phoneNumber.value.trim();
        const phonePattern = phonePatterns[countryCode.value];
        if (!phoneValue) {
            setError(phoneNumber, 'phoneNumberError', 'Phone number is required.');
            isValid = false;
        } else if (!phonePattern || !phonePattern.test(phoneValue)) {
            setError(phoneNumber, 'phoneNumberError', countryCode.value === 'BI'
                ? 'Enter your 8-digit Burundi phone number.'
                : `Enter a valid 9 or 10-digit local phone number for ${countryCode.value}.`);
            isValid = false;
        } else {
            setError(phoneNumber, 'phoneNumberError', '');
        }

        if (!password.value) {
            setError(password, 'passwordError', 'Password is required.');
            isValid = false;
        } else if (!/^\d{5}$/.test(password.value)) {
            setError(password, 'passwordError', 'Password must contain exactly 5 digits.');
            isValid = false;
        } else {
            setError(password, 'passwordError', '');
        }

        if (!confirmPassword.value) {
            setError(confirmPassword, 'confirmPasswordError', 'Confirm your password.');
            isValid = false;
        } else if (confirmPassword.value !== password.value) {
            setError(confirmPassword, 'confirmPasswordError', 'Passwords do not match.');
            isValid = false;
        } else {
            setError(confirmPassword, 'confirmPasswordError', '');
        }

        setError(referralCode, 'referralCodeError', '');

        return isValid;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (!validateForm()) {
            formStatus.textContent = 'Please fix the highlighted fields.';
            formStatus.className = 'form-status error';
            return;
        }

        try {
            await BmgApi.request('/auth/register', {
                auth: false,
                method: 'POST',
                body: {
                    fullName: fullName.value.trim(),
                    phoneNumber: phoneNumber.value.trim(),
                    password: password.value,
                    confirmPassword: confirmPassword.value,
                    countryCode: countryCode.value,
                    referralCode: referralCode.value.trim() || undefined,
                },
            });

            formStatus.textContent = 'Account created. Redirecting to Login...';
            formStatus.className = 'form-status success';
            const registeredCountryCode = countryCode.value;
            form.reset();

            setTimeout(() => {
                window.location.href = `login.html?country=${encodeURIComponent(registeredCountryCode)}`;
            }, 700);
        } catch (err) {
            formStatus.textContent = err.message || 'Registration failed. Please try again.';
            formStatus.className = 'form-status error';
        }
    });

    phoneNumber.addEventListener('input', () => {
        phoneNumber.value = phoneNumber.value.replace(/\D/g, '').slice(0, phoneNumber.maxLength);
        validateForm();
    });
    [fullName, password, confirmPassword, countryCode].forEach((input) => {
        input.addEventListener('input', () => validateForm());
    });
    [password, confirmPassword].forEach((input) => {
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 5);
            validateForm();
        });
    });
});

// Handles client-side validation for the login form.
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    if (!form) return;

    const countryCode = document.getElementById('loginCountryCode');
    const phoneFlag = document.getElementById('loginPhoneFlag');
    const phoneDialCode = document.getElementById('loginPhoneDialCode');
    const phoneNumber = document.getElementById('loginPhoneNumber');
    const password = document.getElementById('loginPassword');
    const formStatus = document.getElementById('loginFormStatus');
    const togglePassword = document.getElementById('loginTogglePassword');
    const query = new URLSearchParams(window.location.search);
    const linkedCountryCode = (query.get('country') || query.get('countryCode') || '').trim().toUpperCase();
    let availableCountries = [...FALLBACK_COUNTRIES];
    const phonePatterns = {
        RW: /^0?7\d{8}$/,
        UG: /^0?7\d{8}$/,
        ZM: /^0?9\d{8}$/,
        BI: /^[267]\d{7}$/,
        CD: /^0?[89]\d{8}$/,
        KE: /^0?[17]\d{8}$/,
        SO: /^0?[679]\d{8}$/,
        SS: /^0?[79]\d{8}$/,
        TZ: /^0?[6789]\d{8}$/,
    };

    const updateCountry = () => {
        const selectedCountry = availableCountries.find((country) => country.code === countryCode.value);
        const phoneLength = selectedCountry?.code === 'BI' ? 8 : selectedCountry ? 10 : 0;
        phoneDialCode.textContent = selectedCountry?.dialCode || '';
        phoneNumber.removeAttribute('minlength');
        phoneNumber.removeAttribute('maxlength');
        phoneNumber.maxLength = phoneLength || 10;
        phoneNumber.minLength = selectedCountry?.code === 'BI' ? 8 : selectedCountry ? 9 : 0;
        phoneNumber.placeholder = selectedCountry
            ? COUNTRY_PHONE_PLACEHOLDERS[selectedCountry.code] || 'Enter local phone number'
            : 'Select a country first';
        phoneNumber.value = phoneNumber.value.replace(/\D/g, '').slice(0, phoneNumber.maxLength);
        phoneFlag.hidden = !selectedCountry?.flagImage;
        if (selectedCountry?.flagImage) {
            phoneFlag.src = selectedCountry.flagImage;
            phoneFlag.alt = `${selectedCountry.name} flag`;
        } else {
            phoneFlag.removeAttribute('src');
            phoneFlag.alt = '';
        }
        validateForm();
    };
    const updateCountryLinks = () => {
        const suffix = countryCode.value ? `?country=${encodeURIComponent(countryCode.value)}` : '';
        document.querySelectorAll('.coffee-auth-tabs a, .auth-alt-action a').forEach((link) => {
            link.href = `${link.getAttribute('href').split('?')[0]}${suffix}`;
        });
    };
    renderCountryOptions(countryCode, availableCountries, linkedCountryCode);
    countryCode.addEventListener('change', updateCountry);
    countryCode.addEventListener('change', updateCountryLinks);
    phoneNumber.addEventListener('input', () => {
        phoneNumber.value = phoneNumber.value.replace(/\D/g, '').slice(0, phoneNumber.maxLength);
        validateForm();
    });
    updateCountry();
    updateCountryLinks();

    loadAvailableCountries().then(({ countries, fallback, error }) => {
        const selectedCode = countryCode.value;
        availableCountries = countries;
        renderCountryOptions(countryCode, availableCountries, selectedCode || linkedCountryCode);
        updateCountry();
        updateCountryLinks();
        if (fallback) {
            formStatus.textContent = `Country options are available, but login needs the service connection. ${error.message}`;
            formStatus.className = 'form-status error';
        } else if (!countryCode.value) {
            formStatus.textContent = '';
            detectCountryFromLocation(availableCountries).then((detectedCode) => {
                if (!countryCode.value && detectedCode) {
                    countryCode.value = detectedCode;
                    updateCountry();
                    updateCountryLinks();
                    formStatus.textContent = 'Country selected from your browser location. You can change it from the country list.';
                    formStatus.className = 'form-status success';
                } else if (!countryCode.value) {
                    formStatus.textContent = 'Could not detect a supported country. Choose one from the country list.';
                }
            }).catch(() => {
                if (!countryCode.value) {
                    formStatus.textContent = 'Location permission was not granted. Choose your country from the list.';
                }
            });
        }
    });

    if (togglePassword) {
        togglePassword.addEventListener('click', () => {
            const isHidden = password.type === 'password';
            password.type = isHidden ? 'text' : 'password';
            togglePassword.setAttribute('aria-pressed', String(isHidden));
            togglePassword.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        });
    }

    function setError(input, errorId, message) {
        const errorEl = document.getElementById(errorId);
        if (message) {
            input.classList.add('invalid');
            errorEl.textContent = message;
        } else {
            input.classList.remove('invalid');
            errorEl.textContent = '';
        }
    }

    function validateForm() {
        let isValid = true;

        const phoneValue = phoneNumber.value.trim();
        if (!phoneValue) {
            setError(phoneNumber, 'loginPhoneNumberError', 'Phone number is required.');
            isValid = false;
        } else if (!phonePatterns[countryCode.value]?.test(phoneValue)) {
            setError(phoneNumber, 'loginPhoneNumberError', countryCode.value === 'BI'
                ? 'Enter your 8-digit Burundi phone number.'
                : `Enter a valid 9 or 10-digit local phone number for ${countryCode.value}.`);
            isValid = false;
        } else {
            setError(phoneNumber, 'loginPhoneNumberError', '');
        }

        if (!password.value) {
            setError(password, 'loginPasswordError', 'Password is required.');
            isValid = false;
        } else {
            setError(password, 'loginPasswordError', '');
        }

        return isValid;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (!validateForm()) {
            formStatus.textContent = 'Please fix the highlighted fields.';
            formStatus.className = 'form-status error';
            return;
        }

        try {
            const { token, user } = await BmgApi.request('/auth/login', {
                auth: false,
                method: 'POST',
                body: { phoneNumber: phoneNumber.value.trim(), password: password.value, countryCode: countryCode.value },
            });

            if (user.role === 'admin') {
                BmgApi.setSession(token, user);
                formStatus.textContent = 'Admin access confirmed. Opening Admin Panel...';
                formStatus.className = 'form-status success';
                setTimeout(() => {
                    window.location.href = 'admin.html';
                }, 400);
                return;
            }

            BmgApi.setSession(token, user);
            formStatus.textContent = 'Login successful. Redirecting...';
            formStatus.className = 'form-status success';

            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 400);
        } catch (err) {
            formStatus.textContent = err.message || 'Login failed. Please try again.';
            formStatus.className = 'form-status error';
        }
    });

    phoneNumber.addEventListener('input', () => {
        phoneNumber.value = phoneNumber.value.replace(/\D/g, '').slice(0, phoneNumber.maxLength);
        validateForm();
    });
    [password, countryCode].forEach((input) => {
        input.addEventListener('input', () => validateForm());
    });
});
