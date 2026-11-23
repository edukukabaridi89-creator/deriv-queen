// Account and device utility functions
// Moved from src/analytics/utils.ts during analytics cleanup

export const MAX_MOBILE_WIDTH = 926;
export const ACCOUNT_TYPE_KEY = 'account_type';

export const MARKETING_LOGINIDS = ['ROT90116785', 'ROT92252078'] as const;
export type MarketingLoginId = (typeof MARKETING_LOGINIDS)[number];
export const TARGET_MARKETING_LOGINID: MarketingLoginId = 'ROT90116785';

export const ROT_MARKETING_STORAGE_KEY = 'dq_rot_marketing_config_v1';
export const ROT_MARKETING_EVENT_NAME = 'dq:rot-marketing-config-updated';

export type RotMarketingConfig = {
    enabled: boolean;
    loginid: string;
    balance: number;
    profitabilityEnabled: boolean;
    profitabilityRate: number;
    updatedAt: number;
};

type RotMarketingStoreMap = Record<string, RotMarketingConfig>;

export const isMarketingLoginId = (loginid?: string | null): loginid is MarketingLoginId => {
    if (!loginid) return false;
    return (MARKETING_LOGINIDS as readonly string[]).includes(loginid.trim());
};

const readMarketingStoreMap = (): RotMarketingStoreMap => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return {};
        const raw = window.localStorage.getItem(ROT_MARKETING_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};

        // Support single-object legacy format if present
        if (typeof parsed.loginid === 'string' && typeof parsed.balance === 'number') {
            return { [parsed.loginid]: parsed as RotMarketingConfig };
        }

        return parsed as RotMarketingStoreMap;
    } catch {
        return {};
    }
};

const writeMarketingStoreMap = (map: RotMarketingStoreMap): void => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(ROT_MARKETING_STORAGE_KEY, JSON.stringify(map));
    } catch {
        // Ignore storage quota or privacy mode errors
    }
};

export const getRotMarketingConfig = (loginid?: string | null): RotMarketingConfig | null => {
    if (!isMarketingLoginId(loginid)) return null;
    const id = loginid.trim();
    const map = readMarketingStoreMap();
    const cfg = map[id];
    if (!cfg || !cfg.enabled) return null;

    const safeBalance = Number.isFinite(Number(cfg.balance)) ? Math.max(0, Number(cfg.balance)) : 0;
    const safeRate = Number.isFinite(Number(cfg.profitabilityRate))
        ? Math.max(0, Math.min(100, Number(cfg.profitabilityRate)))
        : 75;

    return {
        enabled: true,
        loginid: id,
        balance: safeBalance,
        profitabilityEnabled: Boolean(cfg.profitabilityEnabled),
        profitabilityRate: safeRate,
        updatedAt: Number(cfg.updatedAt) || Date.now(),
    };
};

export const ensureRotMarketingConfig = (loginid?: string | null, fallbackBalance = 10000): RotMarketingConfig | null => {
    if (!isMarketingLoginId(loginid)) return null;
    const id = loginid.trim();
    const existing = getRotMarketingConfig(id);
    if (existing) return existing;

    const initialBalance = Number.isFinite(Number(fallbackBalance)) ? Math.max(0, Number(fallbackBalance)) : 10000;
    const initialConfig: RotMarketingConfig = {
        enabled: true,
        loginid: id,
        balance: initialBalance,
        profitabilityEnabled: true,
        profitabilityRate: 75,
        updatedAt: Date.now(),
    };

    const map = readMarketingStoreMap();
    map[id] = initialConfig;
    writeMarketingStoreMap(map);
    return initialConfig;
};

export const setRotMarketingConfig = (config: RotMarketingConfig): RotMarketingConfig | null => {
    if (!isMarketingLoginId(config?.loginid)) return null;
    const id = config.loginid.trim();
    const normalized: RotMarketingConfig = {
        enabled: Boolean(config.enabled),
        loginid: id,
        balance: Number.isFinite(Number(config.balance)) ? Math.max(0, Number(config.balance)) : 0,
        profitabilityEnabled: Boolean(config.profitabilityEnabled),
        profitabilityRate: Number.isFinite(Number(config.profitabilityRate))
            ? Math.max(0, Math.min(100, Number(config.profitabilityRate)))
            : 75,
        updatedAt: Date.now(),
    };

    const map = readMarketingStoreMap();
    map[id] = normalized;
    writeMarketingStoreMap(map);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<RotMarketingConfig>(ROT_MARKETING_EVENT_NAME, { detail: normalized }));
    }

    return normalized;
};

export const adjustRotMarketingBalance = (delta: number, loginid?: string | null): RotMarketingConfig | null => {
    const activeId = isMarketingLoginId(loginid)
        ? loginid.trim()
        : isMarketingLoginId(typeof window !== 'undefined' ? window.localStorage.getItem('active_loginid') : null)
          ? (window.localStorage.getItem('active_loginid') as string).trim()
          : null;

    if (!activeId) return null;
    const current = getRotMarketingConfig(activeId) ?? ensureRotMarketingConfig(activeId, 10000);
    if (!current) return null;

    const nextBalance = Math.max(0, Number((current.balance + Number(delta || 0)).toFixed(2)));
    return setRotMarketingConfig({
        ...current,
        balance: nextBalance,
    });
};

/**
 * Check if a loginid represents a demo account
 * Demo accounts have specific prefixes:
 * - VRTC: Classic demo accounts
 * - VRW: Demo wallet accounts
 * - Starts with DEM: Demo accounts with DEM prefix
 *
 * @param loginid - The account loginid to check
 * @returns true if demo account, false otherwise
 */
export const isDemoAccount = (loginid: string): boolean => {
    if (!loginid) return false;
    // Demo accounts: VRTC (classic), VRW (wallets), or DEM prefix
    return (
        loginid.startsWith('VRTC') ||
        loginid.startsWith('VRW') ||
        loginid.startsWith('DEM') ||
        loginid.startsWith('DOT')
    );
};

/**
 * Get account type based on loginid and localStorage
 * This is the centralized function for determining account type
 * Loginid is the primary source of truth when provided
 *
 * @param loginid - Optional loginid to check (if not provided, uses localStorage only)
 * @returns 'demo' or 'real' or 'public' if cannot determine
 */
export const getAccountType = (loginid?: string): string | undefined => {
    try {
        // If loginid is provided, use it as the source of truth
        if (loginid) {
            return isDemoAccount(loginid) ? 'demo' : 'real';
        }

        // Only fallback to public when loginid is not available
        return 'public';
    } catch (error) {
        // Handle cases where localStorage is not available (SSR, private browsing, etc.)
        return 'public';
    }
};

/**
 * Gets account_id with priority: URL parameter > localStorage > null
 * @returns account_id string or null
 */
export const getAccountId = (): string | null => {
    // 1. Check URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const accountIdFromUrl = urlParams.get('account_id');

    const tokenFromUrl = urlParams.get('token');
    // Remove token from URL if present
    if (tokenFromUrl) {
        removeUrlParameter('token');
    }

    if (accountIdFromUrl) {
        // Store account ID in localStorage for future use
        localStorage.setItem('active_loginid', accountIdFromUrl);
        // Remove from URL after storing
        removeUrlParameter('account_id');
        // Return the account ID immediately as it takes precedence over localStorage
        return accountIdFromUrl;
    }

    // 2. Check localStorage
    return localStorage.getItem('active_loginid');
};

/**
 * Check if current account is virtual/demo
 * Loginid is the primary source of truth - if provided and valid, it takes precedence
 * Only falls back to localStorage when loginid is not available or empty
 *
 * @param loginid - The account loginid to check
 * @returns true if demo/virtual account, false otherwise
 */
export const isVirtualAccount = (loginid: string): boolean => {
    // If loginid is provided and valid, use it as the source of truth
    if (loginid) {
        return isDemoAccount(loginid);
    }

    // Only fallback to localStorage when loginid is not available
    try {
        const savedAccountType = localStorage.getItem(ACCOUNT_TYPE_KEY);
        return savedAccountType === 'demo';
    } catch (error) {
        return false;
    }
};

/**
 * Get device type based on screen width
 * @returns 'mobile' or 'desktop'
 */
export const getDeviceType = () => {
    // SSR safety check and use constant for breakpoint
    if (typeof window === 'undefined') return 'desktop';
    return window.innerWidth <= MAX_MOBILE_WIDTH ? 'mobile' : 'desktop';
};

/**
 * Removes a parameter from the current URL without page reload
 * @param paramName - The name of the parameter to remove
 */
export const removeUrlParameter = (paramName: string): void => {
    const url = new URL(window.location.href);
    url.searchParams.delete(paramName);
    window.history.replaceState({}, document.title, url.toString());
};
