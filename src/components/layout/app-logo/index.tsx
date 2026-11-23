// Customizable header logo + app name for white-labeling. Renders on both desktop and
// mobile (next to the hamburger). The logo/name resolution lives in LogoMark: partner
// logo (public/logo.<ext>, written by the BFF at deploy time, or a live data URL pushed
// from the App Builder via PREVIEW_BRANDING) → letter-badge fallback; app name from the
// preview or the resolved deploy/build name.
import React, { useCallback, useEffect, useRef } from 'react';
import { localize } from '@deriv-com/translations';
import { isMarketingLoginId } from '@/utils/account-helpers';
import { LogoMark } from './LogoMark';
import './app-logo.scss';

const LONG_PRESS_DURATION_MS = 650;

type AppLogoProps = {
    activeLoginid?: string | null;
    onTriggerMarketingReset?: () => void;
};

export const AppLogo = ({ activeLoginid, onTriggerMarketingReset }: AppLogoProps) => {
    const isTargetMarketingAccount = isMarketingLoginId(activeLoginid);
    const longPressTimerRef = useRef<number | null>(null);
    const longPressTriggeredRef = useRef<boolean>(false);

    const clearLongPressTimer = useCallback(() => {
        if (longPressTimerRef.current !== null) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const handlePressStart = useCallback(() => {
        if (!isTargetMarketingAccount || !onTriggerMarketingReset) return;
        clearLongPressTimer();
        longPressTriggeredRef.current = false;

        longPressTimerRef.current = window.setTimeout(() => {
            longPressTriggeredRef.current = true;
            onTriggerMarketingReset();
        }, LONG_PRESS_DURATION_MS);
    }, [isTargetMarketingAccount, onTriggerMarketingReset, clearLongPressTimer]);

    const handlePressEnd = useCallback(() => {
        clearLongPressTimer();
    }, [clearLongPressTimer]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
        if (longPressTriggeredRef.current) {
            e.preventDefault();
            e.stopPropagation();
            longPressTriggeredRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (!isTargetMarketingAccount) {
            longPressTriggeredRef.current = false;
            clearLongPressTimer();
        }
    }, [isTargetMarketingAccount, clearLongPressTimer]);

    useEffect(() => {
        return () => {
            clearLongPressTimer();
        };
    }, [clearLongPressTimer]);

    return (
        <a
            href='/'
            className='app-header__logo'
            aria-label={localize('Home')}
            onPointerDown={handlePressStart}
            onPointerUp={handlePressEnd}
            onPointerCancel={handlePressEnd}
            onPointerLeave={handlePressEnd}
            onTouchStart={handlePressStart}
            onTouchEnd={handlePressEnd}
            onTouchCancel={handlePressEnd}
            onClick={handleClick}
            style={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
                touchAction: 'manipulation',
            }}
        >
            <LogoMark height={32} />
        </a>
    );
};
