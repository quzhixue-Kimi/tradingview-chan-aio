import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    TwelveDataProvider,
    normalizeTf,
    parseBarTime,
    rowToOHLCV,
    dedupeSorted,
} from '../src/data/providers/twelvedata/TwelveDataProvider';

const res = (ok: boolean, body: unknown, status = ok ? 200 : 500): Response =>
    ({ ok, status, json: () => Promise.resolve(body) }) as unknown as Response;

const TV_BARS = {
    symbol: 'NASDAQ:QQQ',
    resolution: '3',
    count: 3,
    bars: [
        { time: 1791829800000, open: 745.63, high: 745.69, low: 745.35, close: 745.37, volume: 56319 },
        { time: 1791829980000, open: 745.37, high: 745.64, low: 745.36, close: 745.58, volume: 49747 },
        { time: 1791830160000, open: 745.58, high: 745.65, low: 745.43, close: 745.5, volume: 27117 },
    ],
};

describe('TwelveData pure helpers', () => {
    it("normalizeTf maps '3m' to the 3-minute timeframe", () => {
        expect(normalizeTf('3m')).toBe('3');
        expect(normalizeTf('3')).toBe('3');
        expect(normalizeTf('5m')).toBe('5');
        expect(normalizeTf('5')).toBe('5');
    });

    it('rowToOHLCV maps a Twelve Data time-series row', () => {
        expect(
            rowToOHLCV({ datetime: '2026-10-12 14:30:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' }),
        ).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
        expect(parseBarTime('2026-10-12 14:30:00')).toBe(Date.parse('2026-10-12T14:30:00Z'));
    });

    it('dedupeSorted sorts by time and keeps the last bar per time', () => {
        const out = dedupeSorted([
            { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 0 },
            { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 },
            { time: 1, open: 9, high: 9, low: 9, close: 9, volume: 0 },
        ]);
        expect(out.map((b) => b.time)).toEqual([1, 2]);
        expect(out[0]!.open).toBe(9);
    });
});

describe('TwelveDataProvider.getBars — 3m goes to tv-ws-server, others stay on Twelve Data', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Minimal fake WebSocket capturing instances; the test drives onopen/onmessage/onclose. */
    function stubWebSocket() {
        const instances: {
            url: string;
            sent: string[];
            onopen: (() => void) | null;
            onmessage: ((ev: { data: string }) => void) | null;
            onclose: (() => void) | null;
            onerror: (() => void) | null;
            readyState: number;
            closed: boolean;
            close: () => void;
        }[] = [];
        class FakeWS {
            static OPEN = 1;
            url: string;
            sent: string[] = [];
            onopen: (() => void) | null = null;
            onmessage: ((ev: { data: string }) => void) | null = null;
            onclose: (() => void) | null = null;
            onerror: (() => void) | null = null;
            readyState = 1;
            closed = false;
            constructor(url: string) {
                this.url = url;
                instances.push(this as unknown as (typeof instances)[number]);
            }
            send(s: string) {
                this.sent.push(s);
            }
            close() {
                this.closed = true;
            }
        }
        vi.stubGlobal('WebSocket', FakeWS);
        return instances;
    }

    function stubFetch() {
        const calls: string[] = [];
        const fetchMock = vi.fn((input: string | URL) => {
            const url = input.toString();
            calls.push(url);
            if (url.includes('api.twelvedata.com/time_series'))
                return Promise.resolve(res(true, { values: [] }));
            return Promise.resolve(res(false, {}));
        });
        vi.stubGlobal('fetch', fetchMock);
        return calls;
    }

    it('advertises the 3-minute timeframe', () => {
        expect(new TwelveDataProvider('k', 'test-token').info().supportedTimeframes).toContain('3');
    });

    it('fetches 3m history over the tv-ws-server WebSocket (subscribe → history)', async () => {
        const sockets = stubWebSocket();
        const pending = new TwelveDataProvider('k', 'test-token').getBars('QQQ', '3', { limit: 500 });

        expect(sockets.length).toBe(1);
        expect(sockets[0]!.url).toBe('wss://tvws.kq2022.eu.org/tv/ws?token=test-token');
        sockets[0]!.onopen!();
        expect(sockets[0]!.sent).toEqual([
            JSON.stringify({ action: 'subscribe', symbol: 'NASDAQ:QQQ', resolution: '3', count: 500 }),
        ]);

        sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'history', bars: TV_BARS.bars }) });
        const bars = await pending;

        expect(bars.length).toBe(3);
        expect(bars[0]).toEqual({ time: 1791829800000, open: 745.63, high: 745.69, low: 745.35, close: 745.37, volume: 56319 });
        expect(bars.map((b) => b.time)).toEqual([1791829800000, 1791829980000, 1791830160000]); // ascending
        expect(sockets[0]!.closed).toBe(true); // temp socket closed after history
    });

    it("keeps other timeframes on Twelve Data (5m path untouched)", async () => {
        const calls = stubFetch();
        await new TwelveDataProvider('k', 'test-token').getBars('QQQ', '5', { limit: 10 });

        const td = calls.find((u) => u.includes('api.twelvedata.com/time_series'));
        expect(td).toBeDefined();
        expect(td!).toContain('interval=5min');
        expect(calls.some((u) => u.includes('tvws.kq2022.eu.org'))).toBe(false);
    });

    it('returns [] and warns when the tv-ws-server reports an error', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sockets = stubWebSocket();
        const pending = new TwelveDataProvider('k', 'test-token').getBars('QQQ', '3', { limit: 500 });

        sockets[0]!.onopen!();
        sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'error', code: 'load_timeout', message: 'boom' }) });

        expect(await pending).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('tv-ws-server'));
        warn.mockRestore();
    });
});

describe('TwelveDataProvider.subscribe — 3m uses the tv-ws-server WebSocket', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Minimal fake WebSocket capturing instances; the test drives onopen/onmessage/onclose. */
    function stubWebSocket() {
        const instances: {
            url: string;
            sent: string[];
            onopen: (() => void) | null;
            onmessage: ((ev: { data: string }) => void) | null;
            onclose: (() => void) | null;
            readyState: number;
            close: () => void;
        }[] = [];
        class FakeWS {
            static OPEN = 1;
            url: string;
            sent: string[] = [];
            onopen: (() => void) | null = null;
            onmessage: ((ev: { data: string }) => void) | null = null;
            onclose: (() => void) | null = null;
            readyState = 1;
            closed = false;
            constructor(url: string) {
                this.url = url;
                instances.push(this as unknown as (typeof instances)[number]);
            }
            send(s: string) {
                this.sent.push(s);
            }
            close() {
                this.closed = true;
            }
        }
        vi.stubGlobal('WebSocket', FakeWS);
        return instances;
    }

    it('subscribes with symbol/resolution/count and routes history + bar messages', () => {
        vi.useFakeTimers();
        try {
            const sockets = stubWebSocket();
            const seen: number[] = [];
            const unsub = new TwelveDataProvider('k', 'test-token').subscribe('QQQ', '3', (b) => seen.push(b.time));

            expect(sockets.length).toBe(1);
            expect(sockets[0]!.url).toBe('wss://tvws.kq2022.eu.org./tv/ws?token=test-token');
            sockets[0]!.onopen!();
            expect(sockets[0]!.sent).toEqual([
                JSON.stringify({ action: 'subscribe', symbol: 'NASDAQ:QQQ', resolution: '3', count: 500 }),
            ]);

            // history seeds the forming bar (no onBar yet)
            sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'history', bars: TV_BARS.bars }) });
            expect(seen).toEqual([]);

            // forming-bar update (same time overwrites)
            const t = 1791830160000;
            sockets[0]!.onmessage!({
                data: JSON.stringify({ type: 'bar', bar: { time: t, open: 745.58, high: 745.7, low: 745.43, close: 745.66, volume: 28000 } }),
            });
            expect(seen).toEqual([t]);

            // a newer bar starts
            const t2 = t + 180000;
            sockets[0]!.onmessage!({
                data: JSON.stringify({ type: 'bar', bar: { time: t2, open: 745.66, high: 745.8, low: 745.6, close: 745.7, volume: 100 } }),
            });
            expect(seen).toEqual([t, t2]);

            unsub();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a bare ticker untouched for Twelve Data but prefixes NASDAQ: for tv-ws', () => {
        const sockets = stubWebSocket();
        const unsub = new TwelveDataProvider('k', 'test-token').subscribe('QQQ', '3', () => {});
        sockets[0]!.onopen!();
        const sub = JSON.parse(sockets[0]!.sent[0]!);
        expect(sub.symbol).toBe('NASDAQ:QQQ');
        unsub();
    });
});
