import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {DEFAULT_USER_AGENT} from "./constants.js";
import {defaultDeviceProfile, getDeviceClientHints, type DeviceProfile} from "./device-profile.js";
import {fetchSentinelTokenFromBrowser} from "./sentinel-browser.js";

export interface SentinelProofOfWork {
    required: boolean;
    seed: string;
    difficulty: string;
}

export interface SentinelTurnstile {
    dx?: string;
}

export interface SentinelChatRequirements {
    token?: string;
    proofofwork?: SentinelProofOfWork;
    turnstile?: SentinelTurnstile;

    [key: string]: unknown;
}

export interface SentinelEnv {
    userAgent: string;
    language: string;
    languages: string[];
    locale: string;
    timezoneId: string;
    screenWidth: number;
    screenHeight: number;
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    devicePixelRatio: number;
    hardwareConcurrency: number;
    deviceMemory: number;
    jsHeapSizeLimit: number;
    platform: string;
    vendor: string;
    maxTouchPoints: number;
    hasTouch: boolean;
    isMobile: boolean;
    colorDepth: number;
    pixelDepth: number;
    timeOrigin: number;
    scriptSources: string[];
    buildHash: string;
    documentKeys: string[];
    windowKeys: string[];
    searchParamKeys: string[];
}

export interface FetchSentinelTokenOptions {
    flow: string;
    deviceID: string;
    fetch: typeof fetch;
    reqEndpoint: string;
    userAgent?: string;
    deviceProfile?: DeviceProfile;
}

const DEFAULT_SENTINEL_DOCUMENT_KEYS = ["location"];
const DEFAULT_SENTINEL_WINDOW_KEYS = [
    "0",
    "1",
    "window",
    "self",
    "document",
    "name",
    "location",
    "customElements",
    "history",
    "navigation",
    "locationbar",
    "menubar",
    "personalbar",
    "scrollbars",
    "statusbar",
    "toolbar",
    "status",
    "closed",
    "frames",
    "length",
    "top",
    "opener",
    "parent",
    "frameElement",
    "navigator",
    "origin",
    "external",
    "screen",
    "innerWidth",
    "innerHeight",
    "scrollX",
    "pageXOffset",
    "scrollY",
    "pageYOffset",
    "visualViewport",
    "screenX",
    "screenY",
    "outerWidth",
    "outerHeight",
    "devicePixelRatio",
    "event",
    "clientInformation",
    "screenLeft",
    "screenTop",
    "styleMedia",
    "onsearch",
    "onappinstalled",
    "onbeforeinstallprompt",
    "onabort",
    "onbeforeinput",
    "onbeforematch",
    "onbeforetoggle",
    "onblur",
    "oncancel",
    "oncanplay",
    "oncanplaythrough",
    "onchange",
    "onclick",
    "onclose",
    "oncommand",
    "oncontentvisibilityautostatechange",
    "oncontextlost",
    "oncontextmenu",
    "oncontextrestored",
    "oncuechange",
    "ondblclick",
    "ondrag",
    "ondragend",
    "ondragenter",
    "ondragleave",
    "ondragover",
    "ondragstart",
    "ondrop",
    "ondurationchange",
    "onemptied",
    "onended",
    "onerror",
    "onfocus",
    "onformdata",
    "oninput",
];

function defaultScriptSources(): string[] {
    return ["https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js"];
}

function defaultBuildHash(scriptSources: string[]): string {
    const matched =
        scriptSources
            .map((src) => src.match(/c\/[^/]*\/_/))
            .find((match) => Array.isArray(match) && match[0])?.[0] ?? "";
    return matched || "20260219f9f6";
}

export function defaultSentinelEnv(deviceProfile?: DeviceProfile): SentinelEnv {
    const profile = deviceProfile ?? defaultDeviceProfile();
    const scriptSources = defaultScriptSources();
    return {
        userAgent: profile.userAgent || DEFAULT_USER_AGENT,
        language: profile.languages[0] || profile.locale,
        languages: [...profile.languages],
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        screenWidth: profile.screenWidth,
        screenHeight: profile.screenHeight,
        innerWidth: profile.viewportWidth,
        innerHeight: profile.viewportHeight,
        outerWidth: profile.outerWidth,
        outerHeight: profile.outerHeight,
        devicePixelRatio: profile.deviceScaleFactor,
        hardwareConcurrency: profile.hardwareConcurrency,
        deviceMemory: profile.deviceMemory,
        jsHeapSizeLimit: profile.jsHeapSizeLimit,
        platform: profile.platform,
        vendor: profile.vendor,
        maxTouchPoints: profile.maxTouchPoints,
        hasTouch: profile.hasTouch,
        isMobile: profile.isMobile,
        colorDepth: profile.colorDepth,
        pixelDepth: profile.pixelDepth,
        timeOrigin: Date.now(),
        scriptSources,
        buildHash: defaultBuildHash(scriptSources),
        documentKeys: DEFAULT_SENTINEL_DOCUMENT_KEYS,
        windowKeys: DEFAULT_SENTINEL_WINDOW_KEYS,
        searchParamKeys: ["sv"],
    };
}

export async function fetchSentinelToken(
    options: FetchSentinelTokenOptions,
): Promise<string> {
    const useBrowserSentinel = process.argv.includes("--st");
    const profile = options.deviceProfile ?? defaultDeviceProfile();
    if (useBrowserSentinel) {
        try {
            return await fetchSentinelTokenFromBrowser(options.flow, options.deviceID, profile);
        } catch (error) {
            console.error(
                `browserSentinelTokenFailed: flow=${options.flow} error=${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    const env = defaultSentinelEnv({
        ...profile,
        userAgent: options.userAgent?.trim() || profile.userAgent,
    });
    const generator = new SentinelGenerator(env);
    const reqToken = await generator.getRequirementsToken();

    const response = await options.fetch(options.reqEndpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "user-agent": env.userAgent,
        },
        body: JSON.stringify({
            p: reqToken,
            id: options.deviceID,
            flow: options.flow,
        }),
    });

    if (!response.ok) {
        throw new Error(
            `请求 sentinel requirements 失败: ${response.status} body=${await response.text()}`,
        );
    }

    const requirements = (await response.json()) as SentinelChatRequirements;
    const proof = await generator.getEnforcementToken(requirements);
    const turnstile = requirements.turnstile?.dx
        ? await computeTurnstileDx(requirements, reqToken, env)
        : null;

    return JSON.stringify({
        p: proof,
        t: turnstile,
        c: requirements.token,
        id: options.deviceID,
        flow: options.flow,
    });
}

class SentinelGenerator {
    private readonly answers = new Map<string, Promise<string> | string>();
    private readonly requirementsSeed = `${Math.random()}`;
    private readonly sid = randomUUID();

    constructor(private readonly env: SentinelEnv) {
    }

    async getRequirementsToken(): Promise<string> {
        if (!this.answers.has(this.requirementsSeed)) {
            this.answers.set(
                this.requirementsSeed,
                this.generateAnswer(this.requirementsSeed, "0"),
            );
        }
        return `gAAAAAC${await this.answers.get(this.requirementsSeed)}`;
    }

    async getEnforcementToken(
        requirements: SentinelChatRequirements,
    ): Promise<string | null> {
        const pow = requirements.proofofwork;
        if (!pow?.required || !pow.seed || !pow.difficulty) {
            return null;
        }

        const cached = this.answers.get(pow.seed);
        if (typeof cached === "string") {
            return cached;
        }

        if (!cached) {
            this.answers.set(pow.seed, this.generateAnswer(pow.seed, pow.difficulty));
        }
        const answer = await this.answers.get(pow.seed);
        const token = `gAAAAAB${answer}`;
        this.answers.set(pow.seed, token);
        return token;
    }

    private async generateAnswer(seed: string, difficulty: string): Promise<string> {
        const start = performanceNow();
        const data = collectFingerprintData(this.env, this.sid);

        for (let attempt = 0; attempt < 500000; attempt++) {
            data[3] = attempt;
            data[9] = Math.round(performanceNow() - start);
            const encoded = base64Json(data);
            const digest = sentinelHashHex(seed + encoded);
            if (digest.substring(0, difficulty.length) <= difficulty) {
                return `${encoded}~S`;
            }
            if ((attempt + 1) % 5000 === 0) {
                await Promise.resolve();
            }
        }

        return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${base64Json("max attempts exceeded")}`;
    }
}

function collectFingerprintData(env: SentinelEnv, sid: string): unknown[] {
    return [
        env.screenWidth + env.screenHeight,
        new Date().toString(),
        env.jsHeapSizeLimit,
        Math.random(),
        env.userAgent,
        randomPick(env.scriptSources),
        env.buildHash,
        env.language,
        env.languages.join(","),
        Math.random(),
        randomNavigatorProperty(env),
        randomPick(env.documentKeys),
        randomPick(env.windowKeys),
        performanceNow(),
        sid,
        env.searchParamKeys.join(","),
        env.hardwareConcurrency,
        env.timeOrigin,
        0,
        1,
        1,
        0,
        0,
        0,
        1,
    ];
}

function randomNavigatorProperty(env: SentinelEnv): string {
    const navigatorShape: Record<string, string | number> = {
        userAgent: env.userAgent,
        language: env.language,
        hardwareConcurrency: env.hardwareConcurrency,
    };
    const properties = Object.keys(navigatorShape);
    const key = randomPick(properties);
    return `${key}−${String(navigatorShape[key])}`;
}

async function computeTurnstileDx(
    requirements: SentinelChatRequirements,
    key: string,
    env: SentinelEnv,
): Promise<string> {
    let sdkError: unknown = null;
    try {
        const sdkResult = await computeTurnstileDxViaSdk(requirements, key, env);
        const sdkDecoded = tryDecodeBase64Utf8(sdkResult);
        if (looksLikeEncodedError(sdkDecoded)) {
            throw new Error(`sdk returned encoded error: ${sdkDecoded}`);
        }
        console.log(`sentinelTurnstileSource: sdk len=${sdkResult.length}`);
        return sdkResult;
    } catch (error) {
        sdkError = error;
        console.log(
            `sentinelTurnstileSource: vm sdkError=${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const decoded = Buffer.from(requirements.turnstile?.dx ?? "", "base64").toString(
        "latin1",
    );
    const source = xorCipher(decoded, key);
    const program = JSON.parse(source) as unknown[][];
    const vm = new TurnstileVM(env);
    let result: unknown;
    try {
        result = await vm.run(program);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const sdkMessage = sdkError == null
            ? ""
            : ` sdkError=${sdkError instanceof Error ? sdkError.message : String(sdkError)}`;
        throw new Error(
            `turnstile dx 执行失败: ops=${program.length} decodedLen=${decoded.length} sourceLen=${source.length}${sdkMessage} ${message}`,
        );
    }
    const encoded = String(result);
    if (encoded.length <= 8) {
        throw new Error(
            `turnstile dx 结果异常过短: ops=${program.length} encoded=${encoded} raw=${JSON.stringify(encoded)}`,
        );
    }
    console.log(`sentinelTurnstileSource: vm len=${encoded.length}`);
    return encoded;
}

let cachedSdkRunner: ((requirements: SentinelChatRequirements, key: string, dx: string) => Promise<string>) | null = null;

async function computeTurnstileDxViaSdk(
    requirements: SentinelChatRequirements,
    key: string,
    env: SentinelEnv,
): Promise<string> {
    const runner = await loadSdkTurnstileRunner(env);
    return runner(requirements, key, requirements.turnstile?.dx ?? "");
}

async function loadSdkTurnstileRunner(
    env: SentinelEnv,
): Promise<(requirements: SentinelChatRequirements, key: string, dx: string) => Promise<string>> {
    if (cachedSdkRunner) {
        return cachedSdkRunner;
    }

    const sdkPath = new URL("../sdk.js", import.meta.url);
    const sdkSource = await readFile(sdkPath, "utf8");
    const patchedSource = sdkSource.replace(
        "t.init=we,t.sessionObserverToken=async function(t){",
        "t.__codexTurnstileDx=function(requirements,key,dx){D(requirements,key);return _n(requirements,dx)},t.init=we,t.sessionObserverToken=async function(t){",
    );
    if (patchedSource === sdkSource) {
        throw new Error("sdk.js patch hook not found");
    }

    const windowObject = buildWindowObject(env);
    const navigator = createNavigatorObject(env);
    const localStorage = createStorageStub();
    const sessionStorage = createStorageStub();
    const location = {
        href: `https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=${env.buildHash}`,
        pathname: "/backend-api/sentinel/frame.html",
        search: `?sv=${env.buildHash}`,
    };
    const document = {
        scripts: envScripts(env),
        currentScript: {
            src: env.scriptSources[0],
        },
        head: createDomStub(),
        body: createDomStub(),
        createElement: () => createDomStub(),
        documentElement: createDomStub({
            getAttribute: (name: string) => (name === "data-build" ? env.buildHash : null),
        }),
        cookie: "",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        TextEncoder,
        URL,
        URLSearchParams,
        Math,
        Date,
        JSON,
        Object,
        Reflect: {
            ...Reflect,
            set(target: object, propertyKey: PropertyKey, value: unknown, receiver?: unknown): boolean {
                if ((typeof target !== "object" && typeof target !== "function") || target == null) {
                    return true;
                }
                const actualReceiver =
                    (typeof receiver === "object" || typeof receiver === "function") && receiver != null
                        ? receiver
                        : target;
                try {
                    return Reflect.set(target, propertyKey, value, actualReceiver);
                } catch {
                    return true;
                }
            },
        },
        Array,
        Promise,
        String,
        Number,
        Boolean,
        Map,
        WeakMap,
        Set,
        WeakSet,
        Buffer,
        atob: (value: string) => Buffer.from(value, "base64").toString("latin1"),
        btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"),
        navigator,
        screen: {
            width: env.screenWidth,
            height: env.screenHeight,
        },
        performance: {
            now: () => performanceNow(),
            timeOrigin: env.timeOrigin,
            memory: {
                jsHeapSizeLimit: env.jsHeapSizeLimit,
            },
        },
        crypto: {
            getRandomValues: (target: Uint8Array) => {
                const bytes = randomBytes(target.length);
                target.set(bytes);
                return target;
            },
            randomUUID,
        },
        requestIdleCallback: (callback: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void) => {
            return setTimeout(() => callback({timeRemaining: () => 1, didTimeout: false}), 0);
        },
        fetch: async () => ({
            ok: false,
            json: async () => ({}),
        }),
        location,
        document,
        localStorage,
        sessionStorage,
    } as Record<string, unknown>;

    const windowRef = {
        ...windowObject,
        location,
        document,
        navigator,
        screen: sandbox.screen,
        performance: sandbox.performance,
        crypto: sandbox.crypto,
        requestIdleCallback: sandbox.requestIdleCallback,
        localStorage,
        sessionStorage,
        addEventListener: () => undefined,
        postMessage: () => undefined,
    } as Record<string, unknown>;
    windowRef.window = windowRef;
    windowRef.self = windowRef;
    windowRef.parent = windowRef;
    windowRef.top = {};

    sandbox.window = windowRef;
    sandbox.self = windowRef;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    const script = new vm.Script(`${patchedSource}\n;globalThis.__codexSentinelSdk = SentinelSDK;`, {
        filename: "sdk.js",
    });
    script.runInContext(sandbox, {
        timeout: 10000,
    });

    const sdk = sandbox.__codexSentinelSdk as {
        __codexTurnstileDx?: (requirements: SentinelChatRequirements, key: string, dx: string) => Promise<string>;
    };
    if (typeof sdk?.__codexTurnstileDx !== "function") {
        throw new Error("sdk turnstile runner not available");
    }
    cachedSdkRunner = sdk.__codexTurnstileDx.bind(sdk);
    return cachedSdkRunner;
}

class TurnstileVM {
    private readonly state = new Map<number, unknown>();
    private readonly handlers = new Map<number, Function>();
    private instructionCount = 0;
    private readonly trace: unknown[][] = [];
    private readonly debug = false;
    private settled = false;
    private resolveRun: ((value: unknown) => void) | null = null;
    private rejectRun: ((error: Error) => void) | null = null;

    constructor(private readonly env: SentinelEnv) {
        this.install();
    }

    async run(program: unknown[][]): Promise<unknown> {
        this.state.set(9, [...program]);
        return new Promise<unknown>((resolve, reject) => {
            this.settled = false;
            this.resolveRun = resolve;
            this.rejectRun = reject;
            const timer = setTimeout(() => {
                if (this.settled) {
                    return;
                }
                this.settled = true;
                resolve(String(this.instructionCount));
            }, 500);
            this.drain()
                .then(() => {
                    if (!this.settled) {
                        this.settled = true;
                        clearTimeout(timer);
                        reject(
                            new Error(
                                `turnstile vm completed without return callback: instructionCount=${this.instructionCount} queueEmpty=true recent=${JSON.stringify(this.trace.slice(-12))} slots=${JSON.stringify(this.dumpSlots([0, 1, 3, 4, 9, 10, 14, 18, 19, 28, 29, 35, 72, 79, 80, 85]))} largeSlots=${JSON.stringify(this.dumpLargeStringSlots())}`,
                            ),
                        );
                    }
                })
                .catch((error) => {
                    if (!this.settled) {
                        this.settled = true;
                        clearTimeout(timer);
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                });
        });
    }

    private readRef(ref: unknown): unknown {
        if (typeof ref === "number" && Number.isFinite(ref) && this.state.has(ref)) {
            return this.state.get(ref);
        }
        const num = Number(ref);
        if (Number.isFinite(num) && this.state.has(num)) {
            return this.state.get(num);
        }
        return ref;
    }

    private preview(value: unknown): string {
        if (typeof value === "string") {
            return value.length > 160 ? `${JSON.stringify(value.slice(0, 160))}...` : JSON.stringify(value);
        }
        try {
            const text = JSON.stringify(value);
            if (text == null) {
                return String(value);
            }
            return text.length > 160 ? `${text.slice(0, 160)}...` : text;
        } catch {
            return String(value);
        }
    }

    private dumpSlots(slotIds: number[]): Record<string, string> {
        return Object.fromEntries(
            slotIds.map((slotIdValue) => [
                String(slotIdValue),
                this.preview(this.state.get(slotIdValue)),
            ]),
        );
    }

    private dumpLargeStringSlots(): Array<{ slot: string; length: number; preview: string }> {
        const result: Array<{ slot: string; length: number; preview: string }> = [];
        for (const [key, value] of this.state.entries()) {
            if (typeof value !== "string" || value.length < 80) {
                continue;
            }
            result.push({
                slot: String(key),
                length: value.length,
                preview: value.slice(0, 120),
            });
        }
        result.sort((left, right) => right.length - left.length);
        return result.slice(0, 12);
    }

    private debugLog(message: string, details?: Record<string, unknown>): void {
        if (!this.debug) {
            return;
        }
        const suffix = details
            ? ` ${Object.entries(details)
                .map(([key, value]) => `${key}=${this.preview(value)}`)
                .join(" ")}`
            : "";
        console.log(`[sentinel] ${message}${suffix}`);
    }

    private invokeFunction(fn: (...args: unknown[]) => unknown, args: unknown[]): unknown {
        const actualArgs = args.map((arg) => this.readRef(arg));
        this.debugLog("invoke", {
            args,
            actualArgs,
        });
        return fn(...actualArgs);
    }

    private install(): void {
        this.state.set(0, async (payload: string) => {
            const nestedSource = xorCipher(
                Buffer.from(payload, "base64").toString("latin1"),
                String(this.state.get(16) ?? ""),
            );
            const nested = JSON.parse(nestedSource) as unknown[][];
            const previousQueue = [...((this.state.get(9) as unknown[][]) ?? [])];
            this.state.set(9, nested);
            try {
                await this.drain();
                return Buffer.from(`${this.instructionCount}: undefined`, "latin1").toString("base64");
            } catch (error) {
                return Buffer.from(`${this.instructionCount}: ${String(error)}`, "latin1").toString("base64");
            } finally {
                this.state.set(9, previousQueue);
            }
        });
        this.state.set(1, (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            const left = String(this.state.get(dst) ?? "");
            const right = String(this.state.get(src) ?? "");
            this.state.set(
                dst,
                xorCipher(left, right),
            );
            this.debugLog("xor", {
                dst,
                src,
                left,
                right,
                out: this.state.get(dst),
            });
        });
        this.state.set(2, (dst: number, value: unknown) => {
            this.state.set(slotId(dst), value);
        });
        this.state.set(5, (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            const current = this.state.get(dst);
            if (Array.isArray(current)) {
                current.push(this.state.get(src));
            } else {
                this.state.set(dst, `${current ?? ""}${this.state.get(src) ?? ""}`);
            }
        });
        this.state.set(6, (dst: number, src: number, index: number) => {
            dst = slotId(dst);
            src = slotId(src);
            index = slotId(index);
            const container = this.state.get(src) as Record<string, unknown> | unknown[] | string;
            const key = this.state.get(index) as string | number;
            const indexedContainer = container as Record<string | number, unknown>;
            this.state.set(dst, indexedContainer[key]);
        });
        this.state.set(7, (fnSlot: number, ...argSlots: number[]) => {
            fnSlot = slotId(fnSlot);
            const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
            return this.invokeFunction(fn, argSlots);
        });
        this.state.set(8, (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            this.state.set(dst, this.state.get(src));
        });
        this.state.set(10, buildWindowObject(this.env));
        this.state.set(11, (dst: number, needleSlot: number) => {
            dst = slotId(dst);
            needleSlot = slotId(needleSlot);
            const needle = String(this.readRef(needleSlot) ?? "");
            const script =
                envScripts(this.env)
                    .map((entry) => entry.src?.match(needle))
                    .find((match) => Array.isArray(match) && match[0])?.[0] ?? null;
            this.state.set(dst, script);
        });
        this.state.set(12, (dst: number) => {
            this.state.set(slotId(dst), this.state);
        });
        this.state.set(13, (dst: number, fnSlot: number, ...argSlots: number[]) => {
            try {
                dst = slotId(dst);
                fnSlot = slotId(fnSlot);
                const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
                fn(...argSlots);
            } catch (error) {
                this.state.set(slotId(dst), String(error));
            }
        });
        this.state.set(14, (dst: unknown, src: unknown) => {
            const dstKey = slotId(dst);
            const raw = String(this.readRef(src) ?? "");
            this.debugLog("json-parse", {dst: dstKey, src, raw});
            try {
                this.state.set(dstKey, JSON.parse(raw));
            } catch (error) {
                try {
                    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
                        const decoded = Buffer.from(raw, "base64").toString("latin1");
                        this.state.set(dstKey, JSON.parse(decoded));
                        return;
                    }
                } catch {
                    // fall through to detailed error below
                }
                const preview = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
                throw new Error(
                    `JSON.parse failed for src ${String(src)}: ${String(error)} raw=${JSON.stringify(preview)} recent=${JSON.stringify(this.trace.slice(-12))} slots=${JSON.stringify({
                        src: this.preview(this.readRef(src)),
                        slot50_16: this.preview(this.state.get(50.16)),
                        slot93_78: this.preview(this.state.get(93.78)),
                        slot78_35: this.preview(this.state.get(78.35)),
                        slot57_61: this.preview(this.state.get(57.61)),
                        slot57_92: this.preview(this.state.get(57.92)),
                        slot31_71: this.preview(this.state.get(31.71)),
                    })}`,
                );
            }
        });
        this.state.set(15, (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            this.state.set(dst, JSON.stringify(this.state.get(src)));
        });
        this.state.set(17, async (dst: number, fnSlot: number, ...argSlots: number[]) => {
            try {
                dst = slotId(dst);
                fnSlot = slotId(fnSlot);
                const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
                const result = this.invokeFunction(fn, argSlots);
                this.state.set(dst, await Promise.resolve(result));
            } catch (error) {
                this.state.set(slotId(dst), String(error));
            }
        });
        this.state.set(18, (slot: number) => {
            slot = slotId(slot);
            const value = Buffer.from(String(this.state.get(slot) ?? ""), "base64").toString(
                "latin1",
            );
            this.state.set(slot, value);
        });
        this.state.set(19, (slot: number) => {
            slot = slotId(slot);
            this.state.set(
                slot,
                Buffer.from(String(this.state.get(slot) ?? ""), "latin1").toString("base64"),
            );
        });
        this.state.set(20, (leftSlot: number, rightSlot: number, fnSlot: number, ...argSlots: number[]) => {
            leftSlot = slotId(leftSlot);
            rightSlot = slotId(rightSlot);
            fnSlot = slotId(fnSlot);
            if (this.state.get(leftSlot) === this.state.get(rightSlot)) {
                const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
                return fn(...argSlots);
            }
            return null;
        });
        this.state.set(21, (leftSlot: number, rightSlot: number, thresholdSlot: number, fnSlot: number, ...argSlots: number[]) => {
            leftSlot = slotId(leftSlot);
            rightSlot = slotId(rightSlot);
            thresholdSlot = slotId(thresholdSlot);
            fnSlot = slotId(fnSlot);
            const left = Number(this.state.get(leftSlot) ?? 0);
            const right = Number(this.state.get(rightSlot) ?? 0);
            const threshold = Number(this.state.get(thresholdSlot) ?? 0);
            if (Math.abs(left - right) > threshold) {
                const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
                return fn(...argSlots);
            }
            return null;
        });
        this.state.set(22, async (dst: number, nested: unknown[][]) => {
            dst = slotId(dst);
            const prev = [...((this.state.get(9) as unknown[][]) ?? [])];
            this.state.set(9, [...nested]);
            try {
                await this.drain();
            } catch (error) {
                this.state.set(dst, String(error));
            } finally {
                this.state.set(9, prev);
            }
        });
        this.state.set(23, (slot: number, fnSlot: number, ...argSlots: number[]) => {
            slot = slotId(slot);
            fnSlot = slotId(fnSlot);
            this.debugLog("guard-call", {
                slot,
                slotValue: this.state.get(slot),
                fnSlot,
                fnValueType: typeof this.state.get(fnSlot),
                argSlots,
                argValues: argSlots.map((arg) => this.state.get(slotId(arg))),
            });
            if (this.state.get(slot) !== undefined) {
                const fn = this.state.get(fnSlot) as (...args: unknown[]) => unknown;
                return fn(...argSlots);
            }
            return null;
        });
        this.state.set(24, (dst: unknown, objSlot: unknown, methodSlot: unknown) => {
            const dstKey = slotId(dst);
            const obj = this.readRef(objSlot) as Record<string, unknown>;
            const method = String(this.readRef(methodSlot) ?? "");
            const value = obj[method];
            this.state.set(dstKey, (value as Function).bind(obj));
        });
        this.state.set(27, (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            const current = this.state.get(dst);
            if (Array.isArray(current)) {
                const target = this.state.get(src);
                current.splice(current.findIndex((item) => item === target), 1);
            } else {
                this.state.set(dst, Number(current ?? 0) - Number(this.state.get(src) ?? 0));
            }
        });
        this.state.set(28, () => {
        });
        this.state.set(25, () => {
        });
        this.state.set(26, () => {
        });
        this.state.set(29, (dst: number, leftSlot: number, rightSlot: number) => {
            dst = slotId(dst);
            leftSlot = slotId(leftSlot);
            rightSlot = slotId(rightSlot);
            this.state.set(
                dst,
                Number(this.state.get(leftSlot) ?? 0) < Number(this.state.get(rightSlot) ?? 0),
            );
        });
        this.state.set(30, (dst: number, resultSlot: number, argSlotsOrQueue: unknown, maybeQueue?: unknown) => {
            dst = slotId(dst);
            resultSlot = slotId(resultSlot);
            const argSlots = Array.isArray(maybeQueue)
                ? (argSlotsOrQueue as number[]).map((slot) => slotId(slot))
                : [];
            const queue = (Array.isArray(maybeQueue) ? maybeQueue : argSlotsOrQueue) as unknown[][];
            this.state.set(dst, async (...callbackArgs: unknown[]) => {
                const prev = [...((this.state.get(9) as unknown[][]) ?? [])];
                argSlots.forEach((slot, index) => this.state.set(slot, callbackArgs[index]));
                this.state.set(9, [...queue]);
                try {
                    await this.drain();
                    return this.state.get(resultSlot);
                } catch (error) {
                    return `${error}`;
                } finally {
                    this.state.set(9, prev);
                }
            });
        });
        this.state.set(33, (dst: number, leftSlot: number, rightSlot: number) => {
            dst = slotId(dst);
            leftSlot = slotId(leftSlot);
            rightSlot = slotId(rightSlot);
            this.state.set(
                dst,
                Number(this.state.get(leftSlot) ?? 0) * Number(this.state.get(rightSlot) ?? 0),
            );
        });
        this.state.set(34, async (dst: number, src: number) => {
            dst = slotId(dst);
            src = slotId(src);
            this.state.set(dst, await Promise.resolve(this.state.get(src)));
        });
        this.state.set(35, (dst: number, leftSlot: number, rightSlot: number) => {
            dst = slotId(dst);
            leftSlot = slotId(leftSlot);
            rightSlot = slotId(rightSlot);
            const divisor = Number(this.state.get(rightSlot) ?? 0);
            this.state.set(
                dst,
                divisor === 0 ? 0 : Number(this.state.get(leftSlot) ?? 0) / divisor,
            );
        });
        this.state.set(3, (value: unknown) => {
            if (this.settled) {
                return;
            }
            this.settled = true;
            this.resolveRun?.(Buffer.from(String(value), "latin1").toString("base64"));
        });
        this.state.set(4, (value: unknown) => {
            if (this.settled) {
                return;
            }
            this.settled = true;
            this.rejectRun?.(
                new Error(Buffer.from(String(value), "latin1").toString("base64")),
            );
        });

        for (const opcode of [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 33, 34, 35,
        ]) {
            const handler = this.state.get(opcode);
            if (typeof handler === "function") {
                this.handlers.set(opcode, handler);
            }
        }
    }

    private async drain(): Promise<unknown> {
        const queue = this.state.get(9) as unknown[][];
        while (queue.length > 0 && !this.settled) {
            const [opcodeRaw, ...args] = queue.shift() ?? [];
            this.trace.push([opcodeRaw, ...args]);
            if (this.trace.length > 20) {
                this.trace.shift();
            }
            const opcodeKey = Number(opcodeRaw);
            const opcode = Math.trunc(opcodeKey);

            const handler =
                this.state.get(opcodeKey) ??
                this.handlers.get(opcode) ??
                this.state.get(opcode);
            if (typeof handler !== "function") {
                throw new Error(
                    `unsupported opcode ${opcode} raw=${String(opcodeRaw)} valueType=${typeof handler} value=${String(handler)} recent=${JSON.stringify(this.trace)}`,
                );
            }
            await handler(...args);
            this.instructionCount += 1;
        }
        return this.state.get(3);
    }
}

function slotId(value: unknown): number {
    return Number(value);
}

function createAnyStub(seed: Record<string, unknown> = {}): any {
    const fn = function stubFn() {
        return undefined;
    };
    Object.assign(fn, seed);
    return new Proxy(fn, {
        get(target, prop, receiver) {
            if (Reflect.has(target, prop)) {
                return Reflect.get(target, prop, receiver);
            }
            if (prop === Symbol.toPrimitive) {
                return () => "";
            }
            if (prop === Symbol.toStringTag) {
                return "Function";
            }
            if (prop === "length") {
                return 0;
            }
            if (prop === "then") {
                return undefined;
            }
            const nested = createAnyStub();
            Reflect.set(target, prop, nested, target);
            return nested;
        },
        apply() {
            return undefined;
        },
        construct() {
            return createAnyStub();
        },
        set(target, prop, value) {
            Reflect.set(target, prop, value, target);
            return true;
        },
    });
}

function createDomStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const target: Record<string, unknown> = {
        style: {},
        children: [] as unknown[],
        childNodes: [] as unknown[],
        appendChild(child: unknown) {
            (this.children as unknown[]).push(child);
            (this.childNodes as unknown[]).push(child);
            return child;
        },
        removeChild(child: unknown) {
            const items = this.children as unknown[];
            const index = items.findIndex((item) => item === child);
            if (index >= 0) {
                items.splice(index, 1);
            }
            const childNodes = this.childNodes as unknown[];
            const childNodeIndex = childNodes.findIndex((item) => item === child);
            if (childNodeIndex >= 0) {
                childNodes.splice(childNodeIndex, 1);
            }
            return child;
        },
        setAttribute: () => undefined,
        getAttribute: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        postMessage: () => undefined,
        focus: () => undefined,
        blur: () => undefined,
        click: () => undefined,
        contentWindow: {
            postMessage: () => undefined,
        },
        ...overrides,
    };

    return createAnyStub(target);
}

function createStorageStub(): Record<string, unknown> {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key: string) {
            return entries.get(String(key)) ?? null;
        },
        key(index: number) {
            return [...entries.keys()][Number(index)] ?? null;
        },
        removeItem(key: string) {
            entries.delete(String(key));
        },
        setItem(key: string, value: unknown) {
            entries.set(String(key), String(value));
        },
    };
}

function createNavigatorObject(env: SentinelEnv): Record<string, unknown> {
    const plugins = [
        {
            name: "PDF Viewer",
            filename: "internal-pdf-viewer",
            description: "Portable Document Format",
        },
    ];
    const mimeTypes = [
        {
            type: "application/pdf",
            suffixes: "pdf",
            description: "Portable Document Format",
        },
    ];
    const clientHints = getDeviceClientHints({
        id: "sentinel",
        family: env.isMobile ? "mobile" : "desktop",
        browser: env.userAgent.includes("Edg/") ? "edge" : "chrome",
        os: env.platform === "Win32" ? "windows" : "android",
        osVersion: env.platform === "Win32" ? "10.0" : /Android (\d+)/.exec(env.userAgent)?.[1] ? `${/Android (\d+)/.exec(env.userAgent)?.[1]}.0.0` : "14.0.0",
        userAgent: env.userAgent,
        locale: env.locale,
        languages: env.languages,
        acceptLanguage: env.languages.join(","),
        timezoneId: env.timezoneId,
        viewportWidth: env.innerWidth,
        viewportHeight: env.innerHeight,
        screenWidth: env.screenWidth,
        screenHeight: env.screenHeight,
        outerWidth: env.outerWidth,
        outerHeight: env.outerHeight,
        deviceScaleFactor: env.devicePixelRatio,
        hardwareConcurrency: env.hardwareConcurrency,
        deviceMemory: env.deviceMemory,
        jsHeapSizeLimit: env.jsHeapSizeLimit,
        platform: env.platform,
        vendor: env.vendor,
        maxTouchPoints: env.maxTouchPoints,
        hasTouch: env.hasTouch,
        isMobile: env.isMobile,
        colorDepth: env.colorDepth,
        pixelDepth: env.pixelDepth,
    });

    return {
        userAgent: env.userAgent,
        language: env.language,
        languages: env.languages,
        hardwareConcurrency: env.hardwareConcurrency,
        deviceMemory: env.deviceMemory,
        connection: {
            effectiveType: "4g",
            rtt: env.isMobile ? 150 : 50,
            downlink: env.isMobile ? 9.5 : 10,
            saveData: false,
        },
        cookieEnabled: true,
        webdriver: false,
        plugins,
        mimeTypes,
        pdfViewerEnabled: true,
        platform: env.platform,
        vendor: env.vendor,
        appCodeName: "Mozilla",
        appName: "Netscape",
        appVersion: env.userAgent,
        product: "Gecko",
        productSub: "20030107",
        maxTouchPoints: env.maxTouchPoints,
        onLine: true,
        userAgentData: {
            mobile: env.isMobile,
            platform: env.platform === "Win32" ? "Windows" : "Android",
            brands: clientHints.secChUa
                .split(", ")
                .map((entry) => {
                    const match = entry.match(/^"(.+)";v="(.+)"$/);
                    return match ? {brand: match[1], version: match[2]} : null;
                })
                .filter(Boolean),
            fullVersionList: clientHints.secChUaFullVersionList
                .split(", ")
                .map((entry) => {
                    const match = entry.match(/^"(.+)";v="(.+)"$/);
                    return match ? {brand: match[1], version: match[2]} : null;
                })
                .filter(Boolean),
            getHighEntropyValues: async (hints: string[]) => {
                const values = {
                    architecture: env.platform === "Win32" ? "x86" : "arm",
                    bitness: env.platform === "Win32" ? "64" : "64",
                    mobile: env.isMobile,
                    model: env.isMobile ? (env.userAgent.match(/Android [^;]+; ([^)]+)/)?.[1] ?? "") : "",
                    platform: env.platform === "Win32" ? "Windows" : "Android",
                    platformVersion: env.platform === "Win32" ? "15.0.0" : (/Android (\d+)/.exec(env.userAgent)?.[1] ? `${/Android (\d+)/.exec(env.userAgent)?.[1]}.0.0` : "14.0.0"),
                    uaFullVersion: env.userAgent.match(/(?:Chrome|Edg)\/([\d.]+)/)?.[1] ?? "146.0.0.0",
                    fullVersionList: clientHints.secChUaFullVersionList
                        .split(", ")
                        .map((entry) => {
                            const match = entry.match(/^"(.+)";v="(.+)"$/);
                            return match ? {brand: match[1], version: match[2]} : null;
                        })
                        .filter(Boolean),
                    wow64: false,
                } as Record<string, unknown>;

                const output: Record<string, unknown> = {};
                for (const hint of hints) {
                    if (hint in values) {
                        output[hint] = values[hint];
                    }
                }
                return output;
            },
        },
    };
}

function buildWindowObject(env: SentinelEnv): Record<string, unknown> {
    const localStorage = createStorageStub();
    const sessionStorage = createStorageStub();
    const navigator = createNavigatorObject(env);
    const document = {
        scripts: envScripts(env),
        head: createDomStub(),
        body: createDomStub(),
        documentElement: createDomStub({
            getAttribute: (name: string) => (name === "data-build" ? env.buildHash : null),
        }),
        createElement: () => createDomStub(),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const performance = {
        now: () => performanceNow(),
        timeOrigin: env.timeOrigin,
        memory: {
            jsHeapSizeLimit: env.jsHeapSizeLimit,
        },
    };
    const permissions = {
        query: async (descriptor?: { name?: string }) => ({
            name: descriptor?.name ?? "",
            state: descriptor?.name === "notifications" ? "default" : "granted",
            onchange: null,
        }),
    };
    const mediaCapabilities = {
        decodingInfo: async () => ({
            supported: true,
            smooth: true,
            powerEfficient: true,
        }),
        encodingInfo: async () => ({
            supported: true,
            smooth: true,
            powerEfficient: true,
        }),
    };
    const chromeObject = {
        app: {
            isInstalled: false,
            InstallState: {
                DISABLED: "disabled",
                INSTALLED: "installed",
                NOT_INSTALLED: "not_installed",
            },
            RunningState: {
                CANNOT_RUN: "cannot_run",
                READY_TO_RUN: "ready_to_run",
                RUNNING: "running",
            },
        },
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 }),
    };

    const windowObject: Record<string, unknown> = {
        location: {
            href: `https://sentinel.openai.com/backend-api/sentinel/frame.html${buildSearchString(env.searchParamKeys, env.buildHash)}`,
            pathname: "/backend-api/sentinel/frame.html",
            search: buildSearchString(env.searchParamKeys, env.buildHash),
        },
        document,
        navigator,
        screen: {
            width: env.screenWidth,
            height: env.screenHeight,
            availWidth: env.screenWidth,
            availHeight: env.screenHeight,
            colorDepth: env.colorDepth,
            pixelDepth: env.pixelDepth,
        },
        performance,
        innerWidth: env.innerWidth,
        innerHeight: env.innerHeight,
        outerWidth: env.outerWidth,
        outerHeight: env.outerHeight,
        devicePixelRatio: env.devicePixelRatio,
        origin: "https://sentinel.openai.com",
        screenX: 0,
        screenY: 0,
        screenLeft: 0,
        screenTop: 0,
        scrollX: 0,
        pageXOffset: 0,
        scrollY: 0,
        pageYOffset: 0,
        name: "",
        navigation: {},
        history: {
            length: 1,
            state: null,
            back: () => undefined,
            forward: () => undefined,
            go: () => undefined,
            pushState: () => undefined,
            replaceState: () => undefined,
        },
        locationbar: {},
        menubar: {},
        personalbar: {},
        scrollbars: {},
        statusbar: {},
        toolbar: {},
        status: "",
        closed: false,
        length: 0,
        opener: null,
        frameElement: null,
        external: {},
        visualViewport: {
            width: env.innerWidth,
            height: env.innerHeight,
            scale: env.devicePixelRatio,
        },
        event: undefined,
        chrome: chromeObject,
        permissions,
        mediaCapabilities,
        clientInformation: {
            userAgent: env.userAgent,
            language: env.language,
            languages: env.languages,
            hardwareConcurrency: env.hardwareConcurrency,
            deviceMemory: env.deviceMemory,
        },
        ontouchstart: env.hasTouch ? (() => undefined) : undefined,
        navigatorConnection: {
            effectiveType: "4g",
            rtt: env.isMobile ? 150 : 50,
            downlink: env.isMobile ? 9.5 : 10,
            saveData: false,
        },
        styleMedia: {},
        localStorage,
        sessionStorage,
        Date,
        Math,
        JSON,
        Object,
        Reflect,
        Array,
        Promise,
        String,
        Number,
        Boolean,
        Map,
        WeakMap,
        Set,
        WeakSet,
        URL,
        URLSearchParams,
        TextEncoder,
        atob: (value: string) => Buffer.from(value, "base64").toString("latin1"),
        btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"),
        setTimeout,
        clearTimeout,
        globalThis,
    };
    windowObject.window = windowObject;
    windowObject.self = windowObject;
    windowObject.top = windowObject;
    windowObject.parent = windowObject;
    return windowObject;
}

function envScripts(env: SentinelEnv): Array<{ src: string }> {
    return env.scriptSources.map((src) => ({src}));
}

function buildSearchString(keys: string[], buildHash?: string): string {
    if (keys.length === 0) {
        return "";
    }
    return `?${keys.map((key) => `${key}=${key === "sv" ? (buildHash ?? "") : ""}`).join("&")}`;
}

function base64Json(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function sentinelHashHex(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 2246822507) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 3266489909) >>> 0;
    hash ^= hash >>> 16;
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function xorCipher(text: string, key: string): string {
    if (!key) {
        return text;
    }
    let output = "";
    for (let index = 0; index < text.length; index++) {
        output += String.fromCharCode(
            text.charCodeAt(index) ^ key.charCodeAt(index % key.length),
        );
    }
    return output;
}

function tryDecodeBase64Utf8(value: string): string {
    try {
        return Buffer.from(String(value), "base64").toString("utf8");
    } catch {
        return "";
    }
}

function looksLikeEncodedError(value: string): boolean {
    const text = String(value ?? "");
    return /^\d+:\s*(TypeError|Error|ReferenceError|SyntaxError)/.test(text);
}


function randomPick<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function performanceNow(): number {
    return Number(process.hrtime.bigint() / BigInt(1_000_000));
}

function randomUUID(): string {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [
        bytes.subarray(0, 4).toString("hex"),
        bytes.subarray(4, 6).toString("hex"),
        bytes.subarray(6, 8).toString("hex"),
        bytes.subarray(8, 10).toString("hex"),
        bytes.subarray(10, 16).toString("hex"),
    ].join("-");
}
