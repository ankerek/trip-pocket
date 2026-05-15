// Single source of truth for external URLs and support handles. Importers:
// settings sheet, paywall footer, anywhere else that links out.
//
// TODO(ship): replace APP_STORE_URL with the real apple.co / apps.apple.com
// link once the listing is live; the placeholder points at the marketing
// site so an early build never opens a 404.

export const SUPPORT_EMAIL = 'info@trippocket.app';

export const TERMS_URL = 'https://trippocket.app/terms';
export const PRIVACY_URL = 'https://trippocket.app/privacy';
export const FAQ_URL = 'https://trippocket.app/faq';

export const APP_STORE_URL = 'https://trippocket.app';

// Deep-link into Apple's subscription management for the current Apple ID.
// Apple guarantees this URL across iOS versions; do not swap for an
// itms-apps:// variant — they no longer round-trip reliably.
export const MANAGE_SUBSCRIPTION_URL = 'https://apps.apple.com/account/subscriptions';
