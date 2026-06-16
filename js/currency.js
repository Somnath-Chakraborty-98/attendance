const BILLING_COUNTRIES = [
  { code: 'IN', label: 'India' },
  { code: 'US', label: 'United States' },
  { code: 'OTHER', label: 'Other' }
];

function currencyForCountryCode(countryCode) {
  return countryCode === 'IN' ? 'INR' : 'USD';
}

function fillCountrySelect(selectEl, selectedCode) {
  if (!selectEl) return;
  selectEl.innerHTML = BILLING_COUNTRIES.map((c) =>
    `<option value="${c.code}">${c.label}</option>`
  ).join('');
  if (selectedCode) selectEl.value = selectedCode;
}

function bindCountryBillingHint(countryEl, hintEl) {
  if (!countryEl || !hintEl) return;

  const update = () => {
    const currency = currencyForCountryCode(countryEl.value);
    hintEl.textContent = currency === 'INR'
      ? 'Plan pricing will be shown in INR (₹).'
      : 'Plan pricing will be shown in USD ($).';
  };

  if (countryEl.dataset.billingHintBound !== '1') {
    countryEl.dataset.billingHintBound = '1';
    countryEl.addEventListener('change', update);
  }
  update();
}
