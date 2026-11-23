import { api_base } from '@/external/bot-skeleton';
import { LogTypes } from '@/external/bot-skeleton/constants/messages';
import { observer as bus } from '@/external/bot-skeleton/utils/observer';
import {
    adjustRotMarketingBalance,
    getRotMarketingConfig,
    isMarketingLoginId,
    type RotMarketingConfig,
} from '@/utils/account-helpers';
import { buyParameters, type BuyRequest } from './buy-params';
import { positions } from './positions';
import { nexus } from './store';

export type TradeReq = BuyRequest & { source: string }; // source: hedge | bulk | manual | auto | ...
export type TradeResult = { contract_id?: number; profit?: number; won?: boolean; error?: string };

type SimulatedContractState = {
    contract_id: number;
    buy_id: number;
    sell_id: number;
    buy_price: number;
    payout: number;
    sell_price: number;
    profit: number;
    won: boolean;
    currency: string;
    contract_type: string;
    underlying: string;
    shortcode: string;
    date_start: number;
    entry_spot: string;
    exit_spot: string;
    settled: boolean;
    loginid: string;
};

type BatchItem = {
    req: TradeReq;
    buy: any;
    buyPrice: number;
    numericContractId: number;
    numericBuyId: number;
    startTime: number;
    currency: string;
    loginid: string;
    cfg: RotMarketingConfig;
};

const MARKUP_MULTIPLIER = 0.97;
const MIN_STAKE = 0.35;

const open = new Map<number, (r: TradeResult) => void>();
const simulatedContracts = new Map<number, SimulatedContractState>();
let wired_api: unknown = null;

let pendingBatch: BatchItem[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

const send = (payload: object): Promise<any> =>
    Promise.resolve(api_base.api.send(payload)).catch((e: any) => ({
        error: e?.error ?? { message: e?.message ?? 'Request failed' },
    }));

const getActiveMarketingSession = (): { loginid: string; cfg: RotMarketingConfig } | null => {
    const loginid =
        nexus.getLoginid() ||
        (api_base.account_info as any)?.loginid ||
        nexus.root?.client?.loginid ||
        (typeof window !== 'undefined' ? window.localStorage.getItem('active_loginid') : null);

    if (!isMarketingLoginId(loginid)) return null;
    const cfg = getRotMarketingConfig(loginid);
    if (!cfg || !cfg.enabled) return null;
    return { loginid, cfg };
};

const syncMarketingClientBalance = (nextBalance: number | null, loginid: string) => {
    if (nextBalance === null || !Number.isFinite(nextBalance)) return;
    const client = nexus.root?.client;
    if (client && typeof client.setBalance === 'function' && client.loginid === loginid) {
        client.setBalance(nextBalance.toFixed(2));
    }
};

const getMinStakeForContract = (_contractType?: string): number => MIN_STAKE;

const extractBarrier = (req: TradeReq): number | undefined => {
    const raw = (req as any).barrier ?? (req as any).prediction;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
};

const getNetProfitMultiplier = (contractType: string, barrierRaw?: unknown, source?: string): number => {
    const t = String(contractType || '').toUpperCase();
    const barrierNum = Number(barrierRaw);
    const hasBarrier = Number.isFinite(barrierNum);
    const flooredBarrier = hasBarrier ? Math.floor(barrierNum) : undefined;

    if (t === 'DIGITEVEN' || t === 'DIGITODD') {
        return 0.85;
    }
    if (t === 'DIGITMATCH') {
        return Number((7.5 * MARKUP_MULTIPLIER).toFixed(4));
    }
    if (t === 'DIGITOVER' && flooredBarrier !== undefined && flooredBarrier >= 8) {
        return Number((7.5 * MARKUP_MULTIPLIER).toFixed(4));
    }
    if (t === 'DIGITUNDER' && flooredBarrier !== undefined && flooredBarrier <= 1) {
        return Number((7.5 * MARKUP_MULTIPLIER).toFixed(4));
    }
    if (String(source || '') === 'hedge' && (t === 'DIGITOVER' || t === 'DIGITUNDER')) {
        return Number((1.26 * MARKUP_MULTIPLIER).toFixed(4));
    }
    if ((t === 'DIGITOVER' && flooredBarrier === 4) || (t === 'DIGITUNDER' && flooredBarrier === 5)) {
        return 0.85;
    }
    if (t === 'DIGITDIFF') {
        return Number((0.1 * MARKUP_MULTIPLIER).toFixed(4));
    }
    if (t === 'DIGITOVER' || t === 'DIGITUNDER') {
        return Number((1.26 * MARKUP_MULTIPLIER).toFixed(4));
    }
    return 0.85;
};

const computeProfitAndSell = (
    buyPrice: number,
    won: boolean,
    contractType: string,
    barrierRaw?: unknown,
    source?: string
) => {
    const stake = Number(buyPrice || MIN_STAKE);
    if (!won) {
        return {
            profit: Number((-Math.abs(stake)).toFixed(2)),
            sellPrice: 0,
            payout: 0,
        };
    }
    const netProfitMult = getNetProfitMultiplier(contractType, barrierRaw, source);
    const profit = Number((stake * netProfitMult).toFixed(2));
    const sellPrice = Number((stake + profit).toFixed(2));
    return {
        profit,
        sellPrice,
        payout: sellPrice,
    };
};

const createLocalMarketingBuyResponse = (req: TradeReq, stake: number) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const contractId = Number(`${nowSec}${Math.floor(100 + Math.random() * 899)}`);
    const txId = Number(`${nowSec}${Math.floor(100 + Math.random() * 899)}`);
    const safeStake = Number(stake || MIN_STAKE);
    const netProfitMult = getNetProfitMultiplier(req.contract_type, extractBarrier(req), req.source);
    const netPayout = Number((safeStake * (1 + netProfitMult)).toFixed(2));
    return {
        buy: {
            contract_id: contractId,
            transaction_id: txId,
            buy_price: safeStake,
            payout: netPayout,
            start_time: nowSec,
            shortcode: `${req.contract_type}_${req.symbol}_${contractId}`,
        },
    };
};

const shouldFavorWin = (cfg: RotMarketingConfig, naturalProb = 0.485): boolean => {
    if (!cfg.profitabilityEnabled) {
        return Math.random() < naturalProb;
    }
    const clamped = Math.max(0, Math.min(100, cfg.profitabilityRate));
    if (clamped <= 0) return false;
    if (clamped >= 100) return true;
    return Math.random() * 100 < clamped;
};

const doesContractWinForDigit = (contractType: string, digit: number, barrierRaw?: number): boolean => {
    const t = String(contractType || '').toUpperCase();
    if (t === 'DIGITEVEN') return digit % 2 === 0;
    if (t === 'DIGITODD') return digit % 2 !== 0;
    if (t === 'DIGITOVER') {
        const barrier = typeof barrierRaw === 'number' ? Math.max(0, Math.min(8, Math.floor(barrierRaw))) : 5;
        return digit > barrier;
    }
    if (t === 'DIGITUNDER') {
        const barrier = typeof barrierRaw === 'number' ? Math.max(1, Math.min(9, Math.floor(barrierRaw))) : 4;
        return digit < barrier;
    }
    if (t === 'DIGITMATCH') {
        const target = typeof barrierRaw === 'number' ? Math.max(0, Math.min(9, Math.floor(barrierRaw))) : 5;
        return digit === target;
    }
    if (t === 'DIGITDIFF') {
        const target = typeof barrierRaw === 'number' ? Math.max(0, Math.min(9, Math.floor(barrierRaw))) : 5;
        return digit !== target;
    }
    return false;
};

const pickDigitForContract = (contractType: string, won: boolean, barrierRaw?: number): number | null => {
    const t = String(contractType || '').toUpperCase();
    if (t === 'DIGITEVEN') {
        const pool = won ? [0, 2, 4, 6, 8] : [1, 3, 5, 7, 9];
        return pool[Math.floor(Math.random() * pool.length)];
    }
    if (t === 'DIGITODD') {
        const pool = won ? [1, 3, 5, 7, 9] : [0, 2, 4, 6, 8];
        return pool[Math.floor(Math.random() * pool.length)];
    }
    if (t === 'DIGITOVER') {
        const barrier = typeof barrierRaw === 'number' ? Math.max(0, Math.min(8, Math.floor(barrierRaw))) : 5;
        const pool = won
            ? Array.from({ length: 9 - barrier }, (_, idx) => barrier + 1 + idx)
            : Array.from({ length: barrier + 1 }, (_, idx) => idx);
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : won ? 7 : 4;
    }
    if (t === 'DIGITUNDER') {
        const barrier = typeof barrierRaw === 'number' ? Math.max(1, Math.min(9, Math.floor(barrierRaw))) : 4;
        const pool = won
            ? Array.from({ length: barrier }, (_, idx) => idx)
            : Array.from({ length: 10 - barrier }, (_, idx) => barrier + idx);
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : won ? 2 : 5;
    }
    if (t === 'DIGITMATCH' || t === 'DIGITDIFF') {
        const targetDigit = typeof barrierRaw === 'number' ? Math.max(0, Math.min(9, Math.floor(barrierRaw))) : 5;
        const shouldMatchDigit = t === 'DIGITMATCH' ? won : !won;
        if (shouldMatchDigit) return targetDigit;
        const others = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => d !== targetDigit);
        return others[Math.floor(Math.random() * others.length)];
    }
    return null;
};

const buildCoherentSpots = (
    contractType: string,
    won: boolean,
    startTime: number,
    barrierRaw?: number,
    forcedExitDigit?: number | null,
    sharedBaseEntry?: number
) => {
    const baseNum =
        typeof sharedBaseEntry === 'number'
            ? sharedBaseEntry
            : 100 + ((startTime % 850) + Math.random() * 40);
    const chosenDigit =
        typeof forcedExitDigit === 'number' ? forcedExitDigit : pickDigitForContract(contractType, won, barrierRaw);

    if (chosenDigit !== null) {
        const scaledInt = Math.round(baseNum * 100);
        const adjustedInt = Math.floor(scaledInt / 10) * 10 + chosenDigit;
        const sameSpot = (adjustedInt / 100).toFixed(2);
        return {
            entrySpot: sameSpot,
            exitSpot: sameSpot,
        };
    }

    const entrySpotNum = Number(baseNum.toFixed(2));
    const t = String(contractType || '').toUpperCase();
    const move = 0.25 + Math.random() * 0.35;
    const exitSpotNum =
        t === 'PUT'
            ? Number((entrySpotNum + (won ? -move : move)).toFixed(2))
            : Number((entrySpotNum + (won ? move : -move)).toFixed(2));

    return {
        entrySpot: entrySpotNum.toFixed(2),
        exitSpot: exitSpotNum.toFixed(2),
    };
};

const registerSimulatedState = (
    item: BatchItem,
    won: boolean,
    forcedExitDigit?: number | null,
    sharedBaseEntry?: number
) => {
    const barrier = extractBarrier(item.req);
    const { profit, sellPrice, payout } = computeProfitAndSell(
        item.buyPrice,
        won,
        item.req.contract_type,
        barrier,
        item.req.source
    );
    const { entrySpot, exitSpot } = buildCoherentSpots(
        item.req.contract_type,
        won,
        item.startTime,
        barrier,
        forcedExitDigit,
        sharedBaseEntry
    );

    const sim: SimulatedContractState = {
        contract_id: item.numericContractId,
        buy_id: item.numericBuyId,
        sell_id: item.numericBuyId + 1,
        buy_price: item.buyPrice,
        payout,
        sell_price: sellPrice,
        profit,
        won,
        currency: item.currency,
        contract_type: item.req.contract_type,
        underlying: item.req.symbol,
        shortcode: item.buy.shortcode || `${item.req.contract_type}_${item.req.symbol}_${item.numericContractId}`,
        date_start: item.startTime,
        entry_spot: entrySpot,
        exit_spot: exitSpot,
        settled: false,
        loginid: item.loginid,
    };
    simulatedContracts.set(item.numericContractId, sim);

    setTimeout(() => {
        const currentSim = simulatedContracts.get(item.numericContractId);
        if (currentSim && !currentSim.settled) {
            settleSimulatedContract(currentSim);
        }
    }, 1000);
};

const flushBatch = () => {
    if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
    }
    const items = pendingBatch.splice(0, pendingBatch.length);
    if (!items.length) return;

    const cfg = items[0].cfg;
    const src = String(items[0].req.source || '');
    const sharedBaseEntry = 100 + ((items[0].startTime % 850) + Math.random() * 40);

    if (src === 'hedge') {
        const favorWin = shouldFavorWin(cfg, 0.65);
        let exitDigit = Math.floor(Math.random() * 10);

        if (cfg.profitabilityEnabled) {
            const matchingDigits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d =>
                items.some(it => doesContractWinForDigit(it.req.contract_type, d, extractBarrier(it.req)))
            );
            const losingBothDigits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
                d => !items.some(it => doesContractWinForDigit(it.req.contract_type, d, extractBarrier(it.req)))
            );
            if (favorWin && matchingDigits.length) {
                exitDigit = matchingDigits[Math.floor(Math.random() * matchingDigits.length)];
            } else if (!favorWin && losingBothDigits.length) {
                exitDigit = losingBothDigits[Math.floor(Math.random() * losingBothDigits.length)];
            }
        }

        items.forEach(item => {
            const won = doesContractWinForDigit(item.req.contract_type, exitDigit, extractBarrier(item.req));
            registerSimulatedState(item, won, exitDigit, sharedBaseEntry);
        });
        return;
    }

    if (src === 'bulk') {
        const firstType = String(items[0].req.contract_type || '').toUpperCase();
        const firstBarrier = extractBarrier(items[0].req);
        const allSameTypeAndBarrier = items.every(
            it =>
                String(it.req.contract_type || '').toUpperCase() === firstType &&
                extractBarrier(it.req) === firstBarrier
        );
        const batchWon = shouldFavorWin(cfg, 0.485);
        const sharedDigit = allSameTypeAndBarrier ? pickDigitForContract(firstType, batchWon, firstBarrier) : null;

        items.forEach(item => {
            const won = allSameTypeAndBarrier ? batchWon : shouldFavorWin(cfg, 0.485);
            registerSimulatedState(item, won, sharedDigit, sharedBaseEntry);
        });
        return;
    }

    items.forEach(item => {
        const won = shouldFavorWin(cfg, 0.485);
        registerSimulatedState(item, won, null, sharedBaseEntry);
    });
};

const enqueueRotBatchItem = (item: BatchItem) => {
    pendingBatch.push(item);
    const src = String(item.req.source || '');
    const isGroupedSource = src === 'hedge' || src === 'bulk';

    if (!isGroupedSource) {
        flushBatch();
        return;
    }

    if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, 90);
    }
};

const buildSimulatedContractPayload = (sim: SimulatedContractState, isSold: boolean) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        accountID: sim.loginid,
        contract_id: sim.contract_id,
        buy_price: sim.buy_price,
        sell_price: isSold ? sim.sell_price : 0,
        bid_price: isSold ? sim.sell_price : Number((sim.buy_price * (sim.won ? 1.35 : 0.65)).toFixed(2)),
        payout: sim.payout,
        profit: isSold ? sim.profit : 0,
        currency: sim.currency,
        contract_type: sim.contract_type,
        underlying: sim.underlying,
        underlying_symbol: sim.underlying,
        shortcode: sim.shortcode,
        date_start: sim.date_start,
        date_expiry: nowSec + 2,
        entry_spot: sim.entry_spot,
        entry_tick: sim.entry_spot,
        entry_tick_time: sim.date_start,
        exit_spot: isSold ? sim.exit_spot : undefined,
        exit_tick: isSold ? sim.exit_spot : undefined,
        exit_tick_time: isSold ? nowSec : undefined,
        transaction_ids: {
            buy: sim.buy_id,
            ...(isSold ? { sell: sim.sell_id } : {}),
        },
        status: isSold ? (sim.won ? 'won' : 'lost') : 'open',
        is_sold: isSold ? 1 : 0,
        is_expired: isSold ? 1 : 0,
        is_valid_to_sell: isSold ? 0 : 1,
    };
};

const settleSimulatedContract = (sim: SimulatedContractState) => {
    if (sim.settled) return;
    sim.settled = true;

    const done = open.get(sim.contract_id);
    if (!done) return;
    open.delete(sim.contract_id);
    simulatedContracts.delete(sim.contract_id);

    const updatedCfg = adjustRotMarketingBalance(sim.sell_price, sim.loginid);
    if (updatedCfg) {
        syncMarketingClientBalance(updatedCfg.balance, sim.loginid);
    }

    const soldPayload = buildSimulatedContractPayload(sim, true);
    bus.emit('bot.contract', soldPayload);
    positions.upsert(soldPayload);
    bus.emit('contract.status', { id: 'contract.sold', data: sim.sell_id, contract: soldPayload });
    bus.emit('ui.log.success', {
        log_type: sim.profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
        extra: { currency: sim.currency, profit: Number(sim.profit.toFixed(2)) },
    });
    nexus.endTrade();
    done({ contract_id: sim.contract_id, profit: sim.profit, won: sim.won });
};

/** Same payload shape the trade engine broadcasts for every proposal_open_contract update. */
const onContractUpdate = ({ data }: any) => {
    const c = data?.proposal_open_contract;
    if (data?.msg_type !== 'proposal_open_contract' || !c) return;
    const done = open.get(c.contract_id);
    if (!done) return;

    const sim = simulatedContracts.get(c.contract_id);
    if (sim) {
        if (!c.is_sold) {
            const livePayload = buildSimulatedContractPayload(sim, false);
            bus.emit('bot.contract', livePayload);
            positions.upsert(livePayload);
            return;
        }
        settleSimulatedContract(sim);
        return;
    }

    bus.emit('bot.contract', { accountID: nexus.getLoginid(), ...c }); // -> Summary + Transactions
    positions.upsert(c);
    if (!c.is_sold) return;

    open.delete(c.contract_id);
    if (data.subscription?.id) send({ forget: data.subscription.id });
    const profit = Number(c.sell_price) - Number(c.buy_price);
    bus.emit('contract.status', { id: 'contract.sold', data: c.transaction_ids?.sell, contract: c });
    bus.emit('ui.log.success', {
        log_type: profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
        extra: { currency: c.currency, profit: Number(profit.toFixed(2)) },
    }); // -> Journal
    nexus.endTrade();
    done({ contract_id: c.contract_id, profit, won: profit > 0 });
};

/**
 * THE single entry point for every trade placed outside Bot Builder. It follows the exact event sequence the
 * trade engine uses (Purchase.js + OpenContract.js), so the trade shows up in Summary, Transactions and Journal
 * as if the bot had placed it. The buy request is sent synchronously (no awaits before it).
 */
export const dispatch = (req: TradeReq): Promise<TradeResult> => {
    if (!api_base.api) return Promise.resolve({ error: 'Not connected — log in first.' });
    if (wired_api !== api_base.api) {
        wired_api = api_base.api; // re-wire after account switches / reconnects
        api_base.api.onMessage().subscribe(onContractUpdate);
    }
    const currency = (api_base.account_info as any)?.currency || nexus.root?.client?.currency || 'USD';
    const marketingSession = getActiveMarketingSession();
    const stakeAmount = Number(req.maxPrice ?? req.stake);

    if (marketingSession) {
        const minStake = getMinStakeForContract(req.contract_type);
        const currentBalance = Number(marketingSession.cfg.balance ?? 0);
        if (!Number.isFinite(stakeAmount) || stakeAmount < minStake) {
            const errMsg = `Minimum stake for ${req.contract_type} is ${minStake.toFixed(2)} ${currency}.`;
            bus.emit('ui.log.notify', { className: 'error', message: errMsg, sound: 'silent' });
            return Promise.resolve({ error: errMsg });
        }
        if (currentBalance <= 0 || currentBalance + 1e-9 < stakeAmount) {
            const errMsg = `Insufficient marketing balance (${currentBalance.toFixed(2)}) for stake ${stakeAmount.toFixed(2)}.`;
            bus.emit('ui.log.notify', { className: 'error', message: errMsg, sound: 'silent' });
            return Promise.resolve({ error: errMsg });
        }
    }

    nexus.beginTrade();
    bus.emit('contract.status', { id: 'contract.purchase_sent', data: req.stake });
    nexus.mirror({ ...req, currency }); // copy-trading followers get the identical order
    const pending = marketingSession
        ? Promise.resolve(createLocalMarketingBuyResponse(req, stakeAmount))
        : send({ buy: 1, price: stakeAmount, parameters: buyParameters(req, currency) });

    return pending.then(async (res: any) => {
        if (res?.error) {
            bus.emit('ui.log.notify', { className: 'error', message: res.error.message, sound: 'silent' }); // -> Journal
            nexus.endTrade();
            return { error: res.error.message as string };
        }
        const buy = res?.buy;
        if (!buy) {
            nexus.endTrade();
            return { error: 'No purchase confirmation received' };
        }

        const numericContractId = Number(buy.contract_id);
        const numericBuyId = Number(buy.transaction_id) || Date.now();
        const buyPrice = Number(buy.buy_price ?? req.stake);
        const startTime = Number(buy.start_time) || Math.floor(Date.now() / 1000);

        if (marketingSession) {
            const afterStakeCfg = adjustRotMarketingBalance(-buyPrice, marketingSession.loginid);
            if (afterStakeCfg) {
                syncMarketingClientBalance(afterStakeCfg.balance, marketingSession.loginid);
            }

            enqueueRotBatchItem({
                req,
                buy,
                buyPrice,
                numericContractId,
                numericBuyId,
                startTime,
                currency,
                loginid: marketingSession.loginid,
                cfg: marketingSession.cfg,
            });
        }

        bus.emit('contract.status', { id: 'contract.purchase_received', data: buy.transaction_id, buy });
        bus.emit('ui.log.success', {
            log_type: LogTypes.PURCHASE,
            extra: { transaction_id: buy.transaction_id, buy_price: buyPrice, currency },
        });
        bus.emit('bot.contract', {
            accountID: nexus.getLoginid(),
            contract_id: buy.contract_id,
            buy_price: buyPrice,
            date_start: buy.start_time,
            contract_type: req.contract_type,
            underlying: req.symbol,
            shortcode: buy.shortcode,
            transaction_ids: { buy: buy.transaction_id },
            payout: buy.payout,
            currency,
            is_sold: 0,
        });
        positions.upsert({
            contract_id: buy.contract_id,
            contract_type: req.contract_type,
            underlying: req.symbol,
            buy_price: buyPrice,
            is_sold: 0,
        });
        return new Promise<TradeResult>(resolve => {
            open.set(numericContractId, resolve);
            if (!marketingSession) {
                send({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
            }
        });
    });
};
