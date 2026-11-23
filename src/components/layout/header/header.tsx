import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import { TokenLoginModal } from '@/nexus/token-login';
import Button from '@/components/shared_ui/button';
import useActiveAccount from '@/hooks/api/account/useActiveAccount';
import { useApiBase } from '@/hooks/useApiBase';
import { useLogout } from '@/hooks/useLogout';
import { useStore } from '@/hooks/useStore';
import {
    getRotMarketingConfig,
    isMarketingLoginId,
    ROT_MARKETING_EVENT_NAME,
    ROT_MARKETING_STORAGE_KEY,
    type RotMarketingConfig,
    setRotMarketingConfig,
    TARGET_MARKETING_LOGINID,
} from '@/utils/account-helpers';
import { navigateToTransfer } from '@/utils/transfer-utils';
import { Localize } from '@deriv-com/translations';
import { Header, useDevice, Wrapper } from '@deriv-com/ui';
import { AppLogo } from '../app-logo';
import { SpeedSelector } from '../../../nexus/speed-selector';
import { SocialLinks } from '../../../nexus/social-links';
import AccountSwitcher from './account-switcher';
import MenuItems from './menu-items';
import MobileMenu from './mobile-menu';
import './header.scss';

export type { RotMarketingConfig };
export { ROT_MARKETING_EVENT_NAME, ROT_MARKETING_STORAGE_KEY };

const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
};

const AppHeader = observer(() => {
    const { isDesktop } = useDevice();
    const { isAuthorizing, activeLoginid, setIsAuthorizing, authData } = useApiBase();
    const { client } = useStore() ?? {};
    const [authTimeout, setAuthTimeout] = useState(false);
    const is_account_regenerating = client?.is_account_regenerating || false;

    const isTargetMarketingAccount = isMarketingLoginId(activeLoginid);
    const activeMarketingLoginId = isTargetMarketingAccount && activeLoginid ? activeLoginid : TARGET_MARKETING_LOGINID;

    // Secret modal state ("reset" on desktop or long-press on logo)
    const [isResetModalOpen, setIsResetModalOpen] = useState(false);
    const [draftBalance, setDraftBalance] = useState<string>('10000');
    const [draftProfitabilityEnabled, setDraftProfitabilityEnabled] = useState<boolean>(true);
    const [draftProfitability, setDraftProfitability] = useState<number>(75);
    const typedBufferRef = useRef<string>('');
    const typedResetTimerRef = useRef<number | null>(null);

    const openResetModal = useCallback(() => {
        if (!isTargetMarketingAccount || !activeLoginid) return;
        const existing = getRotMarketingConfig(activeLoginid);
        const currentNumericBalance = existing
            ? existing.balance
            : Number(client?.balance ?? authData?.balance ?? 10000);

        setDraftBalance(Number.isFinite(currentNumericBalance) ? String(currentNumericBalance) : '10000');
        setDraftProfitabilityEnabled(existing ? existing.profitabilityEnabled : true);
        setDraftProfitability(existing ? existing.profitabilityRate : 75);
        setIsResetModalOpen(true);
    }, [isTargetMarketingAccount, activeLoginid, client?.balance, authData?.balance]);

    const handleSaveMarketingConfig = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            if (!isTargetMarketingAccount || !activeLoginid) return;

            const parsedBalance = Math.max(0, Number(draftBalance));
            const safeBalance = Number.isFinite(parsedBalance) ? parsedBalance : 0;
            const safeRate = Math.max(0, Math.min(100, Number(draftProfitability) || 0));

            const savedConfig = setRotMarketingConfig({
                enabled: true,
                loginid: activeLoginid,
                balance: safeBalance,
                profitabilityEnabled: Boolean(draftProfitabilityEnabled),
                profitabilityRate: safeRate,
                updatedAt: Date.now(),
            });

            if (savedConfig && client && typeof client.setBalance === 'function') {
                client.setBalance(savedConfig.balance.toFixed(2));
            }
            setIsResetModalOpen(false);
        },
        [isTargetMarketingAccount, activeLoginid, draftBalance, draftProfitabilityEnabled, draftProfitability, client]
    );

    // Listen for typing "reset" when logged into ROT90116785 or ROT92252078
    useEffect(() => {
        if (!isTargetMarketingAccount) {
            typedBufferRef.current = '';
            setIsResetModalOpen(false);
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (isEditableTarget(event.target)) return;
            if (event.key.length !== 1) return;

            typedBufferRef.current = (typedBufferRef.current + event.key.toLowerCase()).slice(-5);

            if (typedResetTimerRef.current) {
                window.clearTimeout(typedResetTimerRef.current);
            }
            typedResetTimerRef.current = window.setTimeout(() => {
                typedBufferRef.current = '';
            }, 1500);

            if (typedBufferRef.current === 'reset') {
                typedBufferRef.current = '';
                openResetModal();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            if (typedResetTimerRef.current) {
                window.clearTimeout(typedResetTimerRef.current);
            }
        };
    }, [isTargetMarketingAccount, openResetModal]);

    // Detect OAuth callback on mount (before App.tsx cleans up the URL).
    // When ?code=...&state=... is present the full auth flow can take 7-15 s
    // (token exchange → accounts fetch → OTP → WebSocket auth), so we must
    // suppress the short fallback timeout and keep the spinner throughout.
    const [isOAuthPending, setIsOAuthPending] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return Boolean(params.get('code') && params.get('state'));
    });

    const { data: activeAccount } = useActiveAccount({
        allBalanceData: client?.all_accounts_balance,
        directBalance: client?.balance,
    });

    const handleLogout = useLogout();

    // Clear OAuth-pending flag once the account is set (auth succeeded)
    // or after a generous timeout in case something goes wrong.
    useEffect(() => {
        if (!isOAuthPending) return;

        if (activeLoginid) {
            setIsOAuthPending(false);
            return;
        }

        // Safety net: give up after 30 s and let the normal flow decide
        const timer = setTimeout(() => setIsOAuthPending(false), 30_000);
        return () => clearTimeout(timer);
    }, [isOAuthPending, activeLoginid]);

    // Handle direct URL access with legacy token param
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const account_id = urlParams.get('account_id');
        if (account_id) {
            setIsAuthorizing(true);
        }
    }, [setIsAuthorizing]);

    // Fallback timeout: show login button if auth never resolves.
    // Suppressed during the OAuth callback flow (isOAuthPending = true).
    useEffect(() => {
        if (isOAuthPending) return;

        const timer = setTimeout(() => {
            if (isAuthorizing && !activeLoginid) {
                setAuthTimeout(true);
                setIsAuthorizing(false);
            }
        }, 5000);

        if (activeLoginid || !isAuthorizing) {
            if (authTimeout) setAuthTimeout(false);
            clearTimeout(timer);
        }

        return () => clearTimeout(timer);
    }, [isAuthorizing, activeLoginid, setIsAuthorizing, authTimeout, isOAuthPending]);

    const [showTokenLogin, setShowTokenLogin] = useState(false);
    const handleSignup = useCallback(async () => {
        try {
            setIsAuthorizing(true);
            const oauthUrl = await generateOAuthURL('registration');
            if (oauthUrl) {
                window.location.replace(oauthUrl);
            } else {
                console.error('Failed to generate OAuth URL for signup');
                setIsAuthorizing(false);
            }
        } catch (error) {
            console.error('Signup redirection failed:', error);
            setIsAuthorizing(false);
        }
    }, [setIsAuthorizing]);

    const handleLogin = useCallback(async () => {
        try {
            // Set authorizing state immediately when login is clicked
            setIsAuthorizing(true);

            // Generate OAuth URL with CSRF token and PKCE parameters
            const oauthUrl = await generateOAuthURL();

            if (oauthUrl) {
                // Redirect to OAuth URL
                window.location.replace(oauthUrl);
            } else {
                console.error('Failed to generate OAuth URL');
                setIsAuthorizing(false);
            }
        } catch (error) {
            console.error('Login redirection failed:', error);
            // Reset authorizing state if redirection fails
            setIsAuthorizing(false);
        }
    }, [setIsAuthorizing]);

    const handleTransfer = useCallback(() => {
        const transferCurrency = authData?.currency;
        if (!transferCurrency) {
            console.error('No currency available for transfer');
            return;
        }
        navigateToTransfer(transferCurrency);
    }, [authData?.currency]);

    const renderAccountSection = useCallback(
        (position: 'left' | 'right' = 'right') => {
            // Show account switcher and logout when user is fully authenticated
            if (activeLoginid && !is_account_regenerating) {
                if (position === 'left' && !isDesktop) {
                    // For mobile left section - only account switcher
                    return (
                        <div className='auth-actions'>
                            <div className='account-info'>
                                <AccountSwitcher activeAccount={activeAccount} />
                            </div>
                        </div>
                    );
                } else if (position === 'right') {
                    // For right section - transfer button (and account switcher on desktop)
                    return (
                        <div className='auth-actions'>
                            {isDesktop && (
                                <div className='account-info'>
                                    <AccountSwitcher activeAccount={activeAccount} />
                                </div>
                            )}
                            <Button
                                primary
                                disabled={client?.is_logging_out || !authData?.currency}
                                onClick={handleTransfer}
                            >
                                <Localize i18n_default_text='Transfer' />
                            </Button>
                        </div>
                    );
                }
            }
            // Show login button only when fully settled (not during OAuth flow)
            else if (
                position === 'right' &&
                !isOAuthPending &&
                ((!is_account_regenerating && !isAuthorizing && !activeLoginid) || authTimeout)
            ) {
                // Disable auth buttons until the OAuth app id is configured, so the
                // click handlers (which would otherwise log "Failed to generate OAuth
                // URL") never fire. The env-not-set toast explains why.
                const isAuthConfigured = Boolean(process.env.NEXT_PUBLIC_DERIV_APP_ID);
                return (
                    <div className='auth-actions'>
                        <Button tertiary disabled={!isAuthConfigured} onClick={handleLogin}>
                            <Localize i18n_default_text='Log in' />
                        </Button>
                        <Button primary_light disabled={!isAuthConfigured} onClick={handleSignup}>
                            <Localize i18n_default_text='Sign up' />
                        </Button>
                        <Button tertiary disabled={!isAuthConfigured} onClick={() => setShowTokenLogin(true)}>
                            <Localize i18n_default_text='Token' />
                        </Button>
                        {showTokenLogin && <TokenLoginModal onClose={() => setShowTokenLogin(false)} />}
                    </div>
                );
            }
            // Default: Show spinner during loading states or when authorizing
            else if (position === 'right') {
                return (
                    <div className='auth-actions auth-actions--loading'>
                        <svg
                            className='auth-actions__spinner'
                            viewBox='0 0 24 24'
                            fill='none'
                            xmlns='http://www.w3.org/2000/svg'
                        >
                            <circle
                                cx='12'
                                cy='12'
                                r='10'
                                stroke='currentColor'
                                strokeWidth='2.5'
                                strokeLinecap='round'
                                strokeDasharray='31.416'
                                strokeDashoffset='10'
                            />
                        </svg>
                    </div>
                );
            }

            return null;
        },
        [
            isAuthorizing,
            isDesktop,
            activeLoginid,
            client,
            activeAccount,
            authTimeout,
            is_account_regenerating,
            isOAuthPending,
            authData,
            handleLogin,
            handleSignup,
            handleTransfer,
            showTokenLogin,
        ]
    );

    if (client?.should_hide_header) return null;

    return (
        <>
            <Header
                className={clsx('app-header', {
                    'app-header--desktop': isDesktop,
                    'app-header--mobile': !isDesktop,
                })}
            >
                <Wrapper variant='left'>
                    <MobileMenu onLogout={handleLogout} />
                    <AppLogo activeLoginid={activeLoginid} onTriggerMarketingReset={openResetModal} />
                    {isDesktop && <SocialLinks />}
                    {isDesktop ? <MenuItems /> : renderAccountSection('left')}
                </Wrapper>
                <Wrapper variant='right'>
                    <div className='nx-header-cluster'>
                        <SpeedSelector compact={!isDesktop} />
                        {renderAccountSection('right')}
                    </div>
                </Wrapper>
            </Header>

            {isResetModalOpen && isTargetMarketingAccount && (
                <div
                    role='dialog'
                    aria-modal='true'
                    aria-label='Marketing Account Reset'
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 99999,
                        backgroundColor: 'rgba(0, 0, 0, 0.65)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '16px',
                    }}
                >
                    <form
                        onSubmit={handleSaveMarketingConfig}
                        style={{
                            width: '100%',
                            maxWidth: '400px',
                            backgroundColor: '#15171c',
                            color: '#ffffff',
                            border: '1px solid rgba(255, 255, 255, 0.14)',
                            borderRadius: '10px',
                            padding: '20px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '14px',
                        }}
                    >
                        <div style={{ fontWeight: 700, fontSize: '16px' }}>
                            Marketing Controls ({activeMarketingLoginId})
                        </div>

                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>Set Balance</span>
                            <input
                                type='number'
                                step='any'
                                min='0'
                                value={draftBalance}
                                onChange={e => setDraftBalance(e.target.value)}
                                style={{
                                    padding: '8px 10px',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    backgroundColor: '#0e1014',
                                    color: '#ffffff',
                                }}
                                required
                            />
                        </label>

                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '10px',
                                fontSize: '13px',
                                padding: '8px 10px',
                                borderRadius: '6px',
                                backgroundColor: '#0e1014',
                                border: '1px solid rgba(255,255,255,0.14)',
                            }}
                        >
                            <span>Use Profitability Rate Override</span>
                            <input
                                type='checkbox'
                                checked={draftProfitabilityEnabled}
                                onChange={e => setDraftProfitabilityEnabled(e.target.checked)}
                            />
                        </label>

                        {draftProfitabilityEnabled && (
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>Profitability Rate</span>
                                    <strong>{draftProfitability}%</strong>
                                </div>
                                <input
                                    type='range'
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={draftProfitability}
                                    onChange={e => setDraftProfitability(Number(e.target.value))}
                                />
                            </label>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
                            <button
                                type='button'
                                onClick={() => setIsResetModalOpen(false)}
                                style={{
                                    padding: '8px 14px',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    background: 'transparent',
                                    color: '#ffffff',
                                    cursor: 'pointer',
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type='submit'
                                style={{
                                    padding: '8px 14px',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: '#ff444f',
                                    color: '#ffffff',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                }}
                            >
                                Apply
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </>
    );
});

export default AppHeader;
