// ===================================================
// K-SOUNDRENTALS — Clean Breadcrumbs Booking & Deposit Module
// ===================================================

import {
  WEB3FORMS_ACCESS_KEY,
  PAYMENT_METHODS,
  PACKAGES,
  findPackageByLabel,
  pesoIconSvg,
  formatCurrencyHtml,
  escapeHtml,
  sanitizeHttpUrl
} from './packages.js';
import { isBlocked, blockDateLocally, syncBlockedDatesFromServer } from './calendar.js';
import { saveBookingToDB, uploadPaymentProof } from './db.js';

let activePaymentChannel = 'gcash';
let currentStep = 1;
let maxStepUnlocked = 1;
let selectedProofFile = null;
let selectedProofDataUrl = '';
let holdTimerInterval = null;
let holdSecondsRemaining = 600;

function showError(inputEl, message) {
  if (!inputEl) return;
  clearError(inputEl);
  const error = document.createElement('p');
  error.className = 'error-msg';
  error.textContent = message;
  inputEl.parentNode.appendChild(error);
  inputEl.style.borderColor = '#ef4444';
}

function clearError(inputEl) {
  if (!inputEl) return;
  const existing = inputEl.parentNode.querySelector('.error-msg');
  if (existing) existing.remove();
  inputEl.style.borderColor = '';
}

function parseHour24(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour;
}

function formatHour12(hour24) {
  const normalized = ((hour24 % 24) + 24) % 24;
  const period = normalized >= 12 ? 'PM' : 'AM';
  const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${hour12}:00 ${period}`;
}

export function updateLiveSummary() {
  const pkgSelect = document.getElementById('package-select');
  const dateInput = document.getElementById('input-date');
  const timeSelect = document.getElementById('delivery-time');

  const selectedPkg = findPackageByLabel(pkgSelect?.value) || PACKAGES.pkg2_12;
  const dateVal = dateInput?.value || '';
  const timeVal = timeSelect?.value || '';

  const recapDateTimeEl = document.getElementById('recap-datetime');
  const recapPkgTitleEl = document.getElementById('recap-pkg-title');
  const recapPkgImgEl = document.getElementById('recap-pkg-img');
  const recapPriceEl = document.getElementById('recap-price');
  const recapBalanceEl = document.getElementById('recap-balance');

  if (recapDateTimeEl) {
    if (dateVal) {
      const [y, m, d] = dateVal.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d);
      const shortDate = dateObj.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
      recapDateTimeEl.textContent = timeVal ? `${shortDate} @ ${timeVal}` : shortDate;
    } else {
      recapDateTimeEl.textContent = 'Select date & time';
    }
  }

  if (selectedPkg) {
    if (recapPkgTitleEl) {
      recapPkgTitleEl.textContent = `${selectedPkg.tier} (${selectedPkg.durationHours} Hours)`;
    }
    if (recapPkgImgEl && selectedPkg.image) {
      recapPkgImgEl.src = selectedPkg.image;
      recapPkgImgEl.alt = selectedPkg.label;
    }
    if (recapPriceEl) {
      recapPriceEl.innerHTML = `${pesoIconSvg(18)}${selectedPkg.price.toLocaleString()}`;
    }
    if (recapBalanceEl) {
      const bal = Math.max(0, selectedPkg.price - selectedPkg.deposit);
      recapBalanceEl.innerHTML = `${pesoIconSvg(14)}${bal.toLocaleString()}`;
    }

    const dpTotalEl = document.getElementById('dp-recap-total');
    const dpBalanceEl = document.getElementById('dp-recap-balance');
    if (dpTotalEl) {
      dpTotalEl.innerHTML = `${pesoIconSvg(13)}${selectedPkg.price.toLocaleString()}`;
    }
    if (dpBalanceEl) {
      const bal = Math.max(0, selectedPkg.price - selectedPkg.deposit);
      dpBalanceEl.innerHTML = `${pesoIconSvg(13)}${bal.toLocaleString()}`;
    }
  }

  const addressInput = document.getElementById('input-address');
  const recapVenueEl = document.getElementById('recap-venue');
  if (recapVenueEl) {
    const addr = addressInput?.value?.trim() || '';
    recapVenueEl.textContent = addr || 'Lapu-Lapu City';
  }

  const nameInput = document.getElementById('input-name');
  const phoneInput = document.getElementById('input-phone');
  const fbInput = document.getElementById('input-fb');
  const recapCustomerEl = document.getElementById('recap-customer');
  if (recapCustomerEl) {
    const cName = nameInput?.value?.trim() || '';
    const cPhone = phoneInput?.value?.trim() || '';
    const cFb = fbInput?.value?.trim() || '';
    const parts = [cName, cPhone, cFb ? `FB: ${cFb}` : ''].filter(Boolean);
    recapCustomerEl.textContent = parts.length ? parts.join(' • ') : '—';
  }

  const gcashRefInput = document.getElementById('input-gcash-ref');
  const recapRefEl = document.getElementById('recap-gcash-ref');
  if (recapRefEl) {
    const refDigits = (gcashRefInput?.value || '').trim();
    recapRefEl.textContent = refDigits || '----';
  }

  const recapProofWrap = document.getElementById('recap-proof-thumb-wrap');
  const recapProofImg = document.getElementById('recap-proof-img');
  if (recapProofWrap && recapProofImg) {
    if (selectedProofDataUrl) {
      recapProofImg.src = selectedProofDataUrl;
      recapProofWrap.style.display = 'flex';
    } else {
      recapProofWrap.style.display = 'none';
    }
  }

  const step5DepositEl = document.getElementById('step5-deposit-due');
  if (step5DepositEl && selectedPkg) {
    step5DepositEl.innerHTML = `${pesoIconSvg(16)}${(selectedPkg.deposit || 500).toLocaleString()}`;
  }

  updatePaymentQRWidget(selectedPkg);
}

function updatePaymentQRWidget(selectedPkg) {
  const qrImg = document.getElementById('pay-qr-img');
  const channelLabel = document.getElementById('pay-channel-label');
  const acctNumberEl = document.getElementById('pay-acct-number');
  const acctNameEl = document.getElementById('pay-acct-name');
  const copyBtn = document.getElementById('pay-copy-btn');
  const amountDueEl = document.getElementById('pay-amount-due');

  const method = PAYMENT_METHODS[activePaymentChannel] || PAYMENT_METHODS.gcash;
  const pkg =
    selectedPkg ||
    findPackageByLabel(document.getElementById('package-select')?.value) ||
    PACKAGES.pkg2_12;

  const amountDue = pkg.deposit; // Strictly ₱500 reservation deposit

  if (qrImg) {
    qrImg.src = method.qrImage;
    qrImg.alt = `${method.name} QR Code`;
  }
  if (channelLabel) channelLabel.textContent = method.name;
  if (acctNumberEl) acctNumberEl.textContent = method.accountNumber;
  if (acctNameEl) acctNameEl.textContent = method.accountName;
  if (copyBtn) copyBtn.setAttribute('data-copy', method.rawNumber);
  if (amountDueEl) {
    amountDueEl.innerHTML = `${pesoIconSvg(16)}${amountDue.toLocaleString()}`;
  }
}

function initPaymentFlowControls() {
  const channelBtns = document.querySelectorAll('.pay-channel-btn[data-channel]');

  channelBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      activePaymentChannel = btn.dataset.channel;
      channelBtns.forEach((b) => {
        const isMatch = b.dataset.channel === activePaymentChannel;
        b.classList.toggle('active', isMatch);
        b.setAttribute('aria-pressed', String(isMatch));
      });
      updateLiveSummary();
    });
  });

  updatePaymentQRWidget();
}

function syncVisualWidgetsFromInputs() {
  const pkgSelect = document.getElementById('package-select');
  const timeSelect = document.getElementById('delivery-time');

  if (pkgSelect) {
    const selectedPkg = findPackageByLabel(pkgSelect.value);
    const tierCards = document.querySelectorAll('.pkg-choice-card[data-tier]');
    const durBtns = document.querySelectorAll('.dur-pill-btn[data-hours]');

    if (selectedPkg) {
      tierCards.forEach((card) => {
        const isMatch = card.dataset.tier === selectedPkg.tier;
        card.classList.toggle('active', isMatch);
        card.setAttribute('aria-pressed', String(isMatch));
      });

      durBtns.forEach((btn) => {
        const isMatch = Number(btn.dataset.hours) === selectedPkg.durationHours;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-pressed', String(isMatch));
      });

      updateTierCardPrices(selectedPkg.durationHours);
    }
  }

  if (timeSelect) {
    const chips = document.querySelectorAll('.time-chip[data-time]');
    chips.forEach((chip) => {
      const isMatch = chip.dataset.time === timeSelect.value;
      chip.classList.toggle('active', isMatch);
      chip.setAttribute('aria-pressed', String(isMatch));
    });
  }
}

function updateTierCardPrices(durationHours) {
  const tierCards = document.querySelectorAll('.pkg-choice-card[data-tier]');
  tierCards.forEach((card) => {
    const tierName = card.dataset.tier;
    const pkg = Object.values(PACKAGES).find(
      (p) => p.tier === tierName && p.durationHours === Number(durationHours)
    );
    const priceEl = card.querySelector('.choice-price');
    const hrsEl = card.querySelector('.choice-hrs');
    if (pkg && priceEl) {
      priceEl.innerHTML = `${pesoIconSvg(15)}${pkg.price.toLocaleString()}`;
    }
    if (pkg && hrsEl) {
      hrsEl.textContent = `/ ${pkg.durationHours} hrs`;
    }
  });
}

function initInteractiveFormPickers() {
  const pkgSelect = document.getElementById('package-select');
  const timeSelect = document.getElementById('delivery-time');

  const tierCards = document.querySelectorAll('.pkg-choice-card[data-tier]');
  const durBtns = document.querySelectorAll('.dur-pill-btn[data-hours]');
  const timeChips = document.querySelectorAll('.time-chip[data-time]');

  let activeDuration = 12;
  let activeTier = 'Full Karaoke';

  if (pkgSelect && pkgSelect.value) {
    const current = findPackageByLabel(pkgSelect.value);
    if (current) {
      activeDuration = current.durationHours;
      activeTier = current.tier;
    }
  }

  function applySelection() {
    const matched = Object.values(PACKAGES).find(
      (p) => p.tier === activeTier && p.durationHours === activeDuration
    );
    if (matched && pkgSelect) {
      pkgSelect.value = matched.label;
      pkgSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncVisualWidgetsFromInputs();
    updatePickupHelper();
    updateLiveSummary();
  }

  tierCards.forEach((card) => {
    card.addEventListener('click', () => {
      activeTier = card.dataset.tier;
      applySelection();
    });
  });

  durBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDuration = Number(btn.dataset.hours);
      updateTierCardPrices(activeDuration);
      applySelection();
    });
  });

  timeChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const selectedTime = chip.dataset.time;
      if (timeSelect) {
        timeSelect.value = selectedTime;
        timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncVisualWidgetsFromInputs();
      updatePickupHelper();
      updateLiveSummary();
    });
  });

  syncVisualWidgetsFromInputs();
  updateLiveSummary();
}

function updatePickupHelper() {
  const pkgSelect = document.getElementById('package-select');
  const timeSelect = document.getElementById('delivery-time');
  const helperEl = document.getElementById('pickup-helper');

  syncVisualWidgetsFromInputs();
  updateLiveSummary();

  if (!pkgSelect || !timeSelect || !helperEl) return;

  const pkg = findPackageByLabel(pkgSelect.value);
  const startHour = parseHour24(timeSelect.value);

  if (!pkg || startHour === null) {
    helperEl.style.display = 'none';
    return;
  }

  const endHour = startHour + pkg.durationHours;
  const nextDay = endHour >= 24;
  const formattedEnd = formatHour12(endHour);

  helperEl.style.display = 'flex';
  helperEl.innerHTML = `
    <span class="pickup-dot"></span>
    <span>Pickup: <strong>${formattedEnd}${nextDay ? ' (next day)' : ''}</strong></span>
  `;
}

function buildBookingSummaryText(data) {
  const gmapsLink = data.mapLink || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(data.address || 'Lapu-Lapu City'));
  return [
    '🎤 K-SOUNDRENTALS RESERVATION #' + (data.id || 'BOOKING'),
    '----------------------------------------',
    'Customer: ' + data.name,
    data.fbName ? 'Facebook: ' + data.fbName : null,
    'Mobile: ' + data.phone,
    'Schedule: ' + data.date + ' @ ' + data.deliveryTime,
    'Package: ' + data.packageChosen,
    'Venue: ' + data.address,
    'Google Maps: ' + gmapsLink,
    'Deposit Required: ₱' + Number(data.amountDue || 500).toLocaleString() + ' (GCash 0995 985 9549)',
    '----------------------------------------',
    'Screenshot to be sent to Messenger: https://m.me/KSoundRentals'
  ]
    .filter(Boolean)
    .join('\n');
}

function showBookingConfirmation(bookingData, dbSaved = true) {
  const formCard = document.getElementById('booking-form-card');
  const successBox = document.getElementById('success-message');
  const contentEl = document.getElementById('booking-confirmation-content');
  const stepperBar = document.querySelector('.booking-breadcrumbs-wrap');

  blockDateLocally(bookingData.date);

  if (formCard) formCard.style.display = 'none';
  if (stepperBar) stepperBar.style.display = 'none';

  const dateParts = (bookingData.date || '').split('-').map(Number);
  const dateObj = dateParts.length === 3 && !dateParts.some(isNaN)
    ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
    : new Date();

  const formattedDate = dateObj.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const pkgObj = findPackageByLabel(bookingData.packageChosen) || PACKAGES.pkg2_12;
  const totalPrice = pkgObj.price || 1299;
  const depositAmt = bookingData.amountDue || 500;
  const balanceAmt = Math.max(0, totalPrice - depositAmt);
  const fallbackMapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(bookingData.address || 'Lapu-Lapu City');
  const mapsUrl = sanitizeHttpUrl(bookingData.mapLink, fallbackMapsUrl);

  const safeId = escapeHtml(bookingData.id || 'CONFIRMED');
  const safeDeliveryTime = escapeHtml(bookingData.deliveryTime || '');
  const safeName = escapeHtml(bookingData.name || '');
  const safePhone = escapeHtml(bookingData.phone || '');
  const safeTelHref = encodeURIComponent(String(bookingData.phone || '').replace(/[^+\d]/g, ''));
  const safeFbName = escapeHtml(bookingData.fbName || '—');
  const safeAddress = escapeHtml(bookingData.address || '');
  const safeRefNo = escapeHtml(bookingData.referenceNo || '—');
  const safeProofUrl = sanitizeHttpUrl(bookingData.proofUrl, '');

  if (contentEl) {
    contentEl.innerHTML = [
      '<div class="conf-hero">',
      '  <div class="conf-success-icon" aria-hidden="true">',
      '    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
      '  </div>',
      '  <h3>Booking Submitted — Pending Verification</h3>',
      '  <p class="conf-subtitle">',
      '    Your date is reserved and your <strong><span class="peso-inline">' + pesoIconSvg(13) + depositAmt.toLocaleString() + '</span> GCash payment proof</strong> has been submitted for verification.',
      '  </p>',
      !dbSaved
        ? '  <p class="conf-subtitle" style="color:#fca5a5;margin-top:8px;">Note: Live database sync could not be confirmed. Please copy your summary below and send it to our Facebook Messenger so we can record your slot manually.</p>'
        : '',
      '</div>',
      '<!-- UNIFIED VIP RESERVATION & PAYMENT PASS -->',
      '<div class="conf-pass-card">',
      '  <!-- PASS HEADER: REFERENCE & STATUS -->',
      '  <div class="conf-pass-header">',
      '    <div class="conf-ref-pill">',
      '      <span class="ref-label">REF</span>',
      '      <strong class="ref-code">#' + safeId + '</strong>',
      '    </div>',
      '    <div class="conf-status-tag">',
      '      <span>Pending Verification • Ref #' + safeRefNo + '</span>',
      '    </div>',
      '  </div>',
      '  <!-- PACKAGE HIGHLIGHT STRIP -->',
      '  <div class="conf-pkg-strip">',
      '    <div class="conf-pkg-thumb-box">',
      '      <img src="' + (pkgObj.image || '/images/pkg-full-karaoke.png') + '" alt="' + escapeHtml(pkgObj.label || 'Package') + '" class="conf-pkg-strip-img">',
      '    </div>',
      '    <div class="conf-pkg-strip-info">',
      '      <span class="conf-pkg-strip-tier">' + escapeHtml(pkgObj.tier || 'Karaoke Package') + '</span>',
      '      <h4 class="conf-pkg-strip-name">' + formatCurrencyHtml(pkgObj.label || escapeHtml(bookingData.packageChosen), 16) + '</h4>',
      '      <span class="conf-pkg-strip-dur">' + escapeHtml(pkgObj.durationTag || '12 Hours Rental') + '</span>',
      '    </div>',
      '    <div class="conf-pkg-strip-price">',
      '      <span class="conf-rate-label">Package Rate</span>',
      '      <strong class="peso-inline conf-rate-val">' + pesoIconSvg(15) + totalPrice.toLocaleString() + '</strong>',
      '    </div>',
      '  </div>',
      '  <!-- EVENT DETAILS GRID -->',
      '  <div class="conf-pass-details">',
      '    <div class="conf-detail-cell">',
      '      <span class="conf-cell-label">',
      '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      '        <span>Schedule</span>',
      '      </span>',
      '      <strong class="conf-cell-val">' + escapeHtml(formattedDate) + ' • ' + safeDeliveryTime + '</strong>',
      '    </div>',
      '    <div class="conf-detail-cell">',
      '      <span class="conf-cell-label">',
      '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      '        <span>Customer</span>',
      '      </span>',
      '      <strong class="conf-cell-val">' + safeName + ' (<a href="tel:' + safeTelHref + '" class="conf-tel-link">' + safePhone + '</a>)</strong>',
      '    </div>',
      '    <div class="conf-detail-cell">',
      '      <span class="conf-cell-label">',
      '        <svg viewBox="0 0 24 24" width="13" height="13" fill="#0084ff"><path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.914 1.454 5.518 3.734 7.202V22l3.411-1.872c.905.251 1.867.387 2.855.387 5.523 0 10-4.145 10-9.257C22 6.145 17.523 2 12 2zm1.002 12.443-2.56-2.73-4.996 2.73 5.496-5.834 2.624 2.73 4.932-2.73-5.496 5.834z"/></svg>',
      '        <span>Facebook</span>',
      '      </span>',
      '      <strong class="conf-cell-val">' + safeFbName + '</strong>',
      '    </div>',
      '    <div class="conf-detail-cell">',
      '      <span class="conf-cell-label">',
      '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
      '        <span>GCash Proof &amp; Balance</span>',
      '      </span>',
      '      <strong class="conf-cell-val">Ref #' + safeRefNo + ' &bull; Bal: <span class="peso-inline">' + pesoIconSvg(13) + balanceAmt.toLocaleString() + '</span>' + (safeProofUrl ? ' &bull; <a href="' + escapeHtml(safeProofUrl) + '" target="_blank" rel="noopener noreferrer" class="conf-tel-link">View Proof ↗</a>' : '') + '</strong>',
      '    </div>',
      '    <div class="conf-detail-cell full-width">',
      '      <span class="conf-cell-label">',
      '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
      '        <span>Delivery Venue</span>',
      '      </span>',
      '      <div class="conf-venue-line">',
      '        <strong class="conf-cell-val">' + safeAddress + '</strong>',
      '        <a href="' + escapeHtml(mapsUrl) + '" target="_blank" rel="noopener noreferrer" class="conf-map-pill">',
      '          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
      '          <span>Map ↗</span>',
      '        </a>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<!-- PRIMARY ACTION BUTTONS -->',
      '<div class="conf-actions-container" style="margin-top: 18px;">',
      '  <a href="https://m.me/KSoundRentals" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-shine conf-messenger-btn">',
      '    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.914 1.454 5.518 3.734 7.202V22l3.411-1.872c.905.251 1.867.387 2.855.387 5.523 0 10-4.145 10-9.257C22 6.145 17.523 2 12 2zm1.002 12.443-2.56-2.73-4.996 2.73 5.496-5.834 2.624 2.73 4.932-2.73-5.496 5.834z"/></svg>',
      '    <span>Open Messenger (For Urgent Follow-ups)</span>',
      '  </a>',
      '  <div class="conf-secondary-actions">',
      '    <a href="https://www.facebook.com/KSoundRentals" target="_blank" rel="noopener noreferrer" class="btn btn-outline conf-sub-btn">',
      '      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
      '      <span>Facebook Page ↗</span>',
      '    </a>',
      '    <button type="button" id="copy-booking-summary" class="btn btn-outline conf-sub-btn">',
      '      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      '      <span>Copy Reservation Summary</span>',
      '    </button>',
      '  </div>',
      '</div>',
      '<div class="conf-new-booking">',
      '  <a href="booking.html" class="conf-reset-link">Make another reservation &rarr;</a>',
      '</div>'
    ].filter(Boolean).join('\n');

    // Attach QR lightbox trigger
    const qrTrigger = document.getElementById('conf-qr-trigger');
    const qrModal = document.getElementById('qr-lightbox-modal');
    if (qrTrigger && qrModal) {
      qrTrigger.addEventListener('click', () => {
        qrModal.style.display = 'flex';
      });
    }
  }

  if (successBox) {
    successBox.style.display = 'block';
    successBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const copySummaryBtn = document.getElementById('copy-booking-summary');
  if (copySummaryBtn) {
    copySummaryBtn.onclick = async () => {
      const text = buildBookingSummaryText(bookingData);
      try {
        await navigator.clipboard.writeText(text);
        copySummaryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span style="color:#86efac">✓ Copied</span>';
        setTimeout(() => {
          copySummaryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy Reservation Summary</span>';
        }, 2200);
      } catch {
        alert(text);
      }
    };
  }
}

async function submitToWeb3Forms(bookingPayload) {
  if (
    !WEB3FORMS_ACCESS_KEY ||
    WEB3FORMS_ACCESS_KEY === 'YOUR_WEB3FORMS_ACCESS_KEY_HERE'
  ) {
    return false;
  }

  const gmapsLink =
    bookingPayload.mapLink ||
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      bookingPayload.address || 'Lapu-Lapu City, Cebu'
    )}`;

  const response = await fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      access_key: WEB3FORMS_ACCESS_KEY,
      subject: `New Reservation [${bookingPayload.id}]: ${bookingPayload.name} - ${bookingPayload.packageChosen} (${bookingPayload.date})`,
      from_name: 'K-SoundRentals Booking System',
      'Booking Reference': bookingPayload.id,
      'Customer Full Name': bookingPayload.name,
      'Facebook Name': bookingPayload.fbName || 'Not specified',
      'Mobile Phone': bookingPayload.phone,
      'Event Date': bookingPayload.date,
      'Delivery Time': bookingPayload.deliveryTime,
      'Package Chosen': bookingPayload.packageChosen,
      'Delivery Venue Address': bookingPayload.address,
      'Google Maps Location Link': gmapsLink,
      'Deposit Amount Required': `PHP ${bookingPayload.amountDue}`,
      'Messenger Action Required': 'Customer will send ₱500 deposit screenshot to Facebook Page (m.me/KSoundRentals)'
    })
  });

  const data = await response.json();
  return Boolean(data && data.success);
}

// ===================================================
// BREADCRUMBS STEPPER NAVIGATION & VALIDATION
// ===================================================

function updateHoldTimerDisplay() {
  const mins = String(Math.floor(holdSecondsRemaining / 60)).padStart(2, '0');
  const secs = String(holdSecondsRemaining % 60).padStart(2, '0');
  const text = `${mins}:${secs}`;
  const el1 = document.getElementById('hold-timer-display');
  const el2 = document.getElementById('hold-timer-display-review');
  if (el1) el1.textContent = text;
  if (el2) el2.textContent = text;
}

function startHoldTimer() {
  if (holdTimerInterval) return;
  holdSecondsRemaining = 600;
  updateHoldTimerDisplay();
  holdTimerInterval = setInterval(() => {
    if (holdSecondsRemaining > 0) {
      holdSecondsRemaining -= 1;
      updateHoldTimerDisplay();
    } else {
      stopHoldTimer();
      alert('Your 10-minute checkout window expired. Please re-verify your selected date before confirming.');
      goToStep(1);
    }
  }, 1000);
}

function stopHoldTimer() {
  if (holdTimerInterval) {
    clearInterval(holdTimerInterval);
    holdTimerInterval = null;
  }
}

export function validateStep(stepIndex) {
  const dateInput = document.getElementById('input-date');
  const timeSelect = document.getElementById('delivery-time');
  const pkgSelect = document.getElementById('package-select');
  const addressInput = document.getElementById('input-address');
  const nameInput = document.getElementById('input-name');
  const phoneInput = document.getElementById('input-phone');
  const fbInput = document.getElementById('input-fb');

  if (stepIndex === 1) {
    let valid = true;
    const calRoot = document.getElementById('calendar-root');
    const chipsGrid = document.querySelector('.time-chips-grid');
    if (calRoot) clearError(calRoot);
    clearError(dateInput);
    if (chipsGrid) clearError(chipsGrid);
    clearError(timeSelect);

    if (!dateInput || !dateInput.value) {
      showError(calRoot || dateInput, 'Select an available date.');
      valid = false;
    } else {
      const [y, m, d] = dateInput.value.split('-').map(Number);
      const chosenDate = new Date(y, m - 1, d);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (chosenDate < today) {
        showError(calRoot || dateInput, 'Date cannot be in the past.');
        valid = false;
      } else if (isBlocked(dateInput.value)) {
        showError(calRoot || dateInput, 'This date is unavailable.');
        valid = false;
      }
    }

    if (!timeSelect || !timeSelect.value) {
      showError(chipsGrid || timeSelect, 'Select a delivery time.');
      valid = false;
    }

    return valid;
  }

  if (stepIndex === 2) {
    clearError(pkgSelect);
    if (!pkgSelect || !pkgSelect.value) {
      showError(pkgSelect, 'Select a package.');
      return false;
    }
    return true;
  }

  if (stepIndex === 3) {
    let valid = true;
    clearError(addressInput);
    clearError(nameInput);
    clearError(phoneInput);
    if (fbInput) clearError(fbInput);

    if (!addressInput || !addressInput.value.trim()) {
      showError(addressInput, 'Enter or pin your delivery address.');
      valid = false;
    }
    if (!nameInput || nameInput.value.trim().length < 2) {
      showError(nameInput, 'Enter your full name.');
      valid = false;
    }
    const phoneVal = (phoneInput?.value || '').trim().replace(/[\s-]/g, '');
    if (!/^(09|\+639)\d{9}$/.test(phoneVal)) {
      showError(phoneInput, 'Enter a valid 11-digit mobile number (09XXXXXXXXX).');
      valid = false;
    }
    if (fbInput && fbInput.value.trim().length < 2) {
      showError(fbInput, 'Enter your Facebook account name.');
      valid = false;
    }
    return valid;
  }

  if (stepIndex === 4) {
    const termsGroup = document.getElementById('terms-checkbox-group');
    const c1 = document.getElementById('agree-owner-terms');
    const c2 = document.getElementById('agree-rental-terms');
    const c3 = document.getElementById('agree-privacy');
    if (termsGroup) clearError(termsGroup);

    if (!c1?.checked || !c2?.checked || !c3?.checked) {
      showError(termsGroup, 'Please check all three boxes to accept the Terms & Conditions and Data Privacy Policy.');
      return false;
    }
    return true;
  }

  if (stepIndex === 5) {
    let valid = true;
    const refInput = document.getElementById('input-gcash-ref');
    const proofDropzone = document.getElementById('proof-upload-dropzone');
    clearError(refInput);
    if (proofDropzone) clearError(proofDropzone);

    const refDigits = (refInput?.value || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(refDigits)) {
      showError(refInput, 'Enter the last 4 digits of your GCash reference number.');
      valid = false;
    }

    if (!selectedProofFile) {
      showError(proofDropzone, 'Please upload your GCash payment screenshot.');
      valid = false;
    }

    return valid;
  }

  return true;
}

export function goToStep(targetStep) {
  if (targetStep < 1 || targetStep > 6 || targetStep === currentStep) return;

  // Validate current step(s) when moving forward
  if (targetStep > currentStep) {
    for (let s = currentStep; s < targetStep; s++) {
      if (!validateStep(s)) {
        return;
      }
    }
  }

  const direction = targetStep > currentStep ? 'forward' : 'backward';
  currentStep = targetStep;
  if (targetStep > maxStepUnlocked) {
    maxStepUnlocked = targetStep;
  }

  // 1. Update Step Panes with directional animation
  const panes = document.querySelectorAll('.wizard-step-pane');
  panes.forEach((pane) => {
    const paneIndex = Number(pane.dataset.stepIndex);
    const isActive = paneIndex === currentStep;
    pane.classList.remove('active', 'step-enter-forward', 'step-enter-backward');
    if (isActive) {
      pane.classList.add(
        'active',
        direction === 'forward' ? 'step-enter-forward' : 'step-enter-backward'
      );
    }
  });

  // 2. Update Breadcrumb Pills with pop animation
  const pills = document.querySelectorAll('.crumb-pill[data-step]');
  pills.forEach((pill) => {
    const s = Number(pill.dataset.step);
    const wasCompleted = pill.classList.contains('completed');
    pill.classList.remove('active', 'completed', 'disabled', 'crumb-pop');

    if (s === currentStep) {
      pill.classList.add('active', 'crumb-pop');
      pill.setAttribute('aria-current', 'step');
    } else if (s < currentStep || s <= maxStepUnlocked) {
      pill.classList.add('completed');
      if (!wasCompleted) {
        pill.classList.add('crumb-pop');
      }
      pill.removeAttribute('aria-current');
    } else {
      pill.classList.add('disabled');
      pill.removeAttribute('aria-current');
    }
  });

  // 3. Update Pure Green Connectors
  const connectors = document.querySelectorAll('.crumb-connector[data-connector]');
  connectors.forEach((conn) => {
    const cIndex = Number(conn.dataset.connector);
    conn.classList.toggle('completed', cIndex < currentStep);
  });

  // 4. Refresh Leaflet map size when entering Step 3
  if (currentStep === 3 && typeof window.refreshVenueMap === 'function') {
    window.refreshVenueMap();
  }

  // 5. Start 10-minute checkout timer when entering Payment or Review
  if (currentStep >= 5) {
    startHoldTimer();
  }

  // 6. Update recap
  updateLiveSummary();
}

export async function handleBooking(event) {
  event.preventDefault();

  for (let s = 1; s <= 6; s++) {
    if (!validateStep(s)) {
      goToStep(s);
      return;
    }
  }

  // Honeypot bot protection
  const honeypot = document.getElementById('booking-hp-trap');
  if (honeypot && honeypot.value.trim() !== '') {
    console.warn('Bot submission blocked via honeypot.');
    return;
  }

  const nameInput = document.getElementById('input-name');
  const phoneInput = document.getElementById('input-phone');
  const fbInput = document.getElementById('input-fb');
  const dateInput = document.getElementById('input-date');
  const addressInput = document.getElementById('input-address');
  const mapLinkInput = document.getElementById('input-map-link');
  const pkgSelect = document.getElementById('package-select');
  const timeSelect = document.getElementById('delivery-time');

  const nameVal = nameInput?.value?.trim() || '';
  if (nameVal.length < 2) {
    alert('Please enter your full name.');
    nameInput?.focus();
    return;
  }

  const phoneVal = (phoneInput?.value || '').trim().replace(/[\s-]/g, '');
  const phPhoneRegex = /^(09|\+639)\d{9}$/;
  if (!phPhoneRegex.test(phoneVal)) {
    alert('Please enter a valid 11-digit Philippine mobile number (e.g. 0917 123 4567).');
    phoneInput?.focus();
    return;
  }

  const fbVal = fbInput?.value?.trim() || '';
  if (fbVal.length < 2) {
    alert('Please enter your Facebook account name so we can verify your deposit screenshot.');
    fbInput?.focus();
    return;
  }

  const dateVal = dateInput?.value || '';
  if (!dateVal) {
    alert('Please select an event date on the calendar.');
    goToStep(1);
    return;
  }

  // Double check if date is already booked
  if (typeof isBlocked === 'function' && isBlocked(dateVal)) {
    alert('Sorry, this date is already booked or reserved. Please choose another date on the calendar.');
    goToStep(1);
    return;
  }

  // Device rate limiting / anti-spam cooldown check (120 seconds)
  const LAST_BOOKING_KEY = 'ksound_last_booking_ts';
  const lastBookingTs = Number(localStorage.getItem(LAST_BOOKING_KEY) || 0);
  const now = Date.now();
  const cooldownSecs = 120;
  const elapsedSecs = Math.floor((now - lastBookingTs) / 1000);
  if (lastBookingTs && elapsedSecs < cooldownSecs) {
    alert(`A reservation was recently submitted from this device. Please wait ${cooldownSecs - elapsedSecs}s before submitting another, or message us directly on Facebook.`);
    return;
  }

  const selectedPkg = findPackageByLabel(pkgSelect.value) || PACKAGES.pkg2_12;
  const methodObj = PAYMENT_METHODS[activePaymentChannel] || PAYMENT_METHODS.gcash;
  const amountDue = selectedPkg.deposit;
  const bookingId = 'KS-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const addressVal = addressInput.value.trim();
  const mapLinkVal = mapLinkInput?.value?.trim() || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addressVal || 'Lapu-Lapu City'));
  const refDigits = (document.getElementById('input-gcash-ref')?.value || '').replace(/\D/g, '').slice(0, 4);

  const bookingPayload = {
    id: bookingId,
    name: nameVal,
    fbName: fbVal,
    phone: phoneVal,
    date: dateVal,
    deliveryTime: timeSelect.value,
    packageChosen: pkgSelect.value,
    address: addressVal,
    mapLink: mapLinkVal,
    paymentChannel: methodObj.name,
    paymentTypeLabel: 'Reservation Deposit',
    amountDue,
    referenceNo: refDigits,
    proofUrl: ''
  };

  try {
    localStorage.setItem(LAST_BOOKING_KEY, String(Date.now()));
  } catch (e) {}

  const submitBtn = document.querySelector('.wizard-submit-btn');
  const origBtnHtml = submitBtn ? submitBtn.innerHTML : 'Confirm & Secure Booking';
  if (submitBtn) {
    submitBtn.textContent = 'Uploading Proof & Saving...';
    submitBtn.disabled = true;
  }

  try {
    if (selectedProofFile) {
      const uploadedUrl = await uploadPaymentProof(selectedProofFile, bookingId).catch(() => null);
      if (uploadedUrl) {
        bookingPayload.proofUrl = uploadedUrl;
      }
    }

    let dbSaved = false;
    try {
      await saveBookingToDB(bookingPayload);
      dbSaved = true;
    } catch (dbErr) {
      if (dbErr?.code === 'DATE_ALREADY_BOOKED' || String(dbErr?.message || '').includes('DATE_ALREADY_BOOKED')) {
        try {
          localStorage.removeItem(LAST_BOOKING_KEY);
        } catch (e) {}
        await syncBlockedDatesFromServer().catch(() => {});
        alert('Sorry, this date was just booked by another customer. Please choose another available date.');
        goToStep(1);
        return;
      }
      console.error('[K-SoundRentals] Failed to save booking to Supabase:', dbErr);
    }

    stopHoldTimer();
    await submitToWeb3Forms(bookingPayload).catch(() => false);
    showBookingConfirmation(bookingPayload, dbSaved);
  } catch {
    stopHoldTimer();
    showBookingConfirmation(bookingPayload, false);
  } finally {
    if (submitBtn) {
      submitBtn.innerHTML = origBtnHtml;
      submitBtn.disabled = false;
    }
  }
}

function initCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn[data-copy]');
    if (!btn) return;
    const valueToCopy = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(valueToCopy);
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('copied');
      }, 1800);
    } catch {
      alert(`Account number: ${valueToCopy}`);
    }
  });
}

function initBreadcrumbsInteraction() {
  const pills = document.querySelectorAll('.crumb-pill[data-step]');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const target = Number(pill.dataset.step);
      goToStep(target);
    });
  });
}

function initPaymentProofControls() {
  const refInput = document.getElementById('input-gcash-ref');
  if (refInput) {
    refInput.addEventListener('input', () => {
      refInput.value = refInput.value.replace(/\D/g, '').slice(0, 4);
      clearError(refInput);
      updateLiveSummary();
    });
  }

  const termsGroup = document.getElementById('terms-checkbox-group');
  ['agree-owner-terms', 'agree-rental-terms', 'agree-privacy'].forEach((id) => {
    const cb = document.getElementById(id);
    if (cb) {
      cb.addEventListener('change', () => {
        if (termsGroup) clearError(termsGroup);
      });
    }
  });

  const fileInput = document.getElementById('input-proof-file');
  const dropzone = document.getElementById('proof-upload-dropzone');
  const emptyBox = document.getElementById('proof-drop-empty');
  const previewBox = document.getElementById('proof-drop-preview');
  const previewImg = document.getElementById('proof-preview-img');
  const previewName = document.getElementById('proof-preview-name');

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        if (dropzone) showError(dropzone, 'Please upload a PNG, JPG, or WEBP screenshot.');
        fileInput.value = '';
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        if (dropzone) showError(dropzone, 'Screenshot must be under 8 MB.');
        fileInput.value = '';
        return;
      }
      selectedProofFile = file;
      if (dropzone) clearError(dropzone);

      const reader = new FileReader();
      reader.onload = () => {
        selectedProofDataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (previewImg && selectedProofDataUrl) previewImg.src = selectedProofDataUrl;
        if (previewName) previewName.textContent = file.name;
        if (emptyBox) emptyBox.style.display = 'none';
        if (previewBox) previewBox.style.display = 'flex';
        updateLiveSummary();
      };
      reader.readAsDataURL(file);
    });
  }
}

export function initBookingForm() {
  const form = document.getElementById('booking-stepper-form') || document.querySelector('.booking-form');
  if (!form) return;

  const params = new URLSearchParams(window.location.search);
  const selectedKey = params.get('pkg') || params.get('package');
  const pkgSelect = document.getElementById('package-select');
  const timeSelect = document.getElementById('delivery-time');
  const dateInput = document.getElementById('input-date');

  if (pkgSelect) {
    if (selectedKey && PACKAGES[selectedKey]) {
      pkgSelect.value = PACKAGES[selectedKey].label;
    } else if (!pkgSelect.value) {
      pkgSelect.value = PACKAGES.pkg2_12.label;
    }
  }

  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const calRoot = document.getElementById('calendar-root');
      if (calRoot) clearError(calRoot);
      clearError(dateInput);
      updateLiveSummary();
    });
  }

  if (timeSelect) {
    timeSelect.addEventListener('change', () => {
      const chipsGrid = document.querySelector('.time-chips-grid');
      if (chipsGrid) clearError(chipsGrid);
      clearError(timeSelect);
      updateLiveSummary();
    });
  }

  const watchedInputs = document.querySelectorAll(
    '#input-name, #input-phone, #input-fb, #input-date, #delivery-time, #input-address, #package-select'
  );
  watchedInputs.forEach((input) => {
    input.addEventListener('input', () => {
      clearError(input);
      updateLiveSummary();
    });
    input.addEventListener('change', () => {
      clearError(input);
      updateLiveSummary();
    });
  });

  initInteractiveFormPickers();
  initPaymentFlowControls();
  initPaymentProofControls();
  initBreadcrumbsInteraction();
  updatePickupHelper();
  initCopyButtons();
  updateLiveSummary();

  const qrTrigger = document.getElementById('gcash-qr-trigger');
  const qrModal = document.getElementById('qr-lightbox-modal');
  if (qrTrigger && qrModal) {
    qrTrigger.addEventListener('click', () => {
      qrModal.style.display = 'flex';
    });
  }

  window.copyGCashNumber = function(btn) {
    navigator.clipboard.writeText('09959859549').then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span style="color:#22c55e;font-weight:700;">Copied!</span>';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }).catch(() => {
      alert('GCash number: 0995 985 9549');
    });
  };

  window.handleBooking = handleBooking;
  window.goToStep = goToStep;
}
