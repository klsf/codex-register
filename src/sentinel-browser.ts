import {existsSync} from "node:fs";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright-core";
import {appConfig} from "./config.js";
import type {DeviceProfile} from "./device-profile.js";

const SENTINEL_FRAME_URL = "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6";
const SENTINEL_COOKIE_DOMAIN = "sentinel.openai.com";
const SENTINEL_SCRIPT_READY_TIMEOUT_MS = 20000;

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let pagePromise: Promise<Page> | null = null;
let contextProfileKey = "";

declare global {
    interface Window {
        SentinelSDK?: {
            token(flow: string): Promise<string>;
        };
    }
}

function resolveBrowserExecutablePath(): string {
    const candidates = [
        process.env.SENTINEL_BROWSER_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean) as string[];

    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) {
        throw new Error("未找到可用浏览器，请设置 SENTINEL_BROWSER_PATH");
    }
    return matched;
}

async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        browserPromise = chromium.launch({
            headless: true,
            executablePath: resolveBrowserExecutablePath(),
            proxy: appConfig.defaultProxyUrl
                ? {
                    server: appConfig.defaultProxyUrl,
                }
                : undefined,
        });
    }
    return browserPromise;
}

function buildProfileKey(profile: DeviceProfile): string {
    return JSON.stringify({
        userAgent: profile.userAgent,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        viewportWidth: profile.viewportWidth,
        viewportHeight: profile.viewportHeight,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
    });
}

async function closeCurrentContext(): Promise<void> {
    if (pagePromise) {
        const page = await pagePromise.catch(() => null);
        pagePromise = null;
        await page?.close().catch(() => undefined);
    }
    if (contextPromise) {
        const context = await contextPromise.catch(() => null);
        contextPromise = null;
        await context?.close().catch(() => undefined);
    }
    contextProfileKey = "";
}

async function getContext(profile: DeviceProfile): Promise<BrowserContext> {
    const nextProfileKey = buildProfileKey(profile);
    if (contextPromise && contextProfileKey !== nextProfileKey) {
        await closeCurrentContext();
    }

    if (!contextPromise) {
        contextPromise = (async () => {
            const browser = await getBrowser();
            return browser.newContext({
                viewport: {
                    width: profile.viewportWidth,
                    height: profile.viewportHeight,
                },
                screen: {
                    width: profile.screenWidth,
                    height: profile.screenHeight,
                },
                deviceScaleFactor: profile.deviceScaleFactor,
                locale: profile.locale,
                timezoneId: profile.timezoneId,
                userAgent: profile.userAgent,
                isMobile: profile.isMobile,
                hasTouch: profile.hasTouch,
                extraHTTPHeaders: {
                    "accept-language": profile.acceptLanguage,
                    "sec-ch-ua-mobile": profile.isMobile ? "?1" : "?0",
                },
            });
        })().catch((error) => {
            contextPromise = null;
            contextProfileKey = "";
            throw error;
        });
        contextProfileKey = nextProfileKey;
    }
    return contextPromise;
}

async function getSentinelPage(profile: DeviceProfile): Promise<Page> {
    if (!pagePromise) {
        pagePromise = (async () => {
            const context = await getContext(profile);
            return context.newPage();
        })().catch((error) => {
            pagePromise = null;
            throw error;
        });
    }
    return pagePromise;
}

async function ensureDeviceCookie(page: Page, deviceID: string): Promise<void> {
    const context = page.context();
    await context.addCookies([
        {
            name: "oai-did",
            value: deviceID,
            domain: SENTINEL_COOKIE_DOMAIN,
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "None",
        },
    ]);
}

async function loadSentinelFrame(page: Page): Promise<void> {
    await page.goto(SENTINEL_FRAME_URL, {
        waitUntil: "domcontentloaded",
        timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS,
    });
    await page.reload({
        waitUntil: "domcontentloaded",
        timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS,
    });
    await page.waitForFunction(() => {
        return typeof window.SentinelSDK?.token === "function";
    }, {timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS});
}

export async function fetchSentinelTokenFromBrowser(
    flow: string,
    deviceID: string,
    profile: DeviceProfile,
): Promise<string> {
    const page = await getSentinelPage(profile);
    await ensureDeviceCookie(page, deviceID);
    await loadSentinelFrame(page);

    const result = await page.evaluate(async ({runtimeFlow}) => {
        if (typeof window.SentinelSDK?.token !== "function") {
            throw new Error("SentinelSDK.token 不可用");
        }
        return await window.SentinelSDK.token(runtimeFlow);
    }, {runtimeFlow: flow});

    if (typeof result !== "string" || !result.trim()) {
        throw new Error(`浏览器 SentinelSDK 返回异常: ${JSON.stringify(result)}`);
    }

    console.log(`browserSentinelTokenSuccess: flow=${flow}`);
    return result;
}
