import {randomUUID} from "node:crypto";

export interface DeviceProfile {
    id: string;
    family: "desktop" | "mobile";
    browser: "chrome" | "edge";
    os: "windows" | "android";
    osVersion: string;
    userAgent: string;
    locale: string;
    languages: string[];
    acceptLanguage: string;
    timezoneId: string;
    viewportWidth: number;
    viewportHeight: number;
    screenWidth: number;
    screenHeight: number;
    outerWidth: number;
    outerHeight: number;
    deviceScaleFactor: number;
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
}

export interface DeviceClientHints {
    secChUa: string;
    secChUaFullVersionList: string;
    secChUaMobile: string;
    secChUaPlatform: string;
    secChUaPlatformVersion: string;
    secChViewportWidth: string;
}

interface LocaleProfile {
    locale: string;
    languages: string[];
    acceptLanguage: string;
    timezoneId: string;
}

const DESKTOP_LOCALES: LocaleProfile[] = [
    {locale: "en-US", languages: ["en-US", "en"], acceptLanguage: "en-US,en;q=0.9", timezoneId: "America/Los_Angeles"},
    {locale: "en-GB", languages: ["en-GB", "en"], acceptLanguage: "en-GB,en;q=0.9", timezoneId: "Europe/London"},
    {locale: "zh-CN", languages: ["zh-CN", "zh"], acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8", timezoneId: "Asia/Shanghai"},
];

const MOBILE_LOCALES: LocaleProfile[] = [
    {locale: "en-US", languages: ["en-US", "en"], acceptLanguage: "en-US,en;q=0.9", timezoneId: "America/New_York"},
    {locale: "en-GB", languages: ["en-GB", "en"], acceptLanguage: "en-GB,en;q=0.9", timezoneId: "Europe/London"},
    {locale: "zh-CN", languages: ["zh-CN", "zh"], acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8", timezoneId: "Asia/Shanghai"},
];

const DESKTOP_VIEWPORTS = [
    {viewportWidth: 1365, viewportHeight: 768, screenWidth: 1366, screenHeight: 768, deviceScaleFactor: 1},
    {viewportWidth: 1440, viewportHeight: 900, screenWidth: 1440, screenHeight: 900, deviceScaleFactor: 1},
    {viewportWidth: 1536, viewportHeight: 864, screenWidth: 1536, screenHeight: 864, deviceScaleFactor: 1.25},
    {viewportWidth: 1600, viewportHeight: 900, screenWidth: 1600, screenHeight: 900, deviceScaleFactor: 1},
    {viewportWidth: 1710, viewportHeight: 1067, screenWidth: 1728, screenHeight: 1117, deviceScaleFactor: 1.5},
    {viewportWidth: 1920, viewportHeight: 1080, screenWidth: 1920, screenHeight: 1080, deviceScaleFactor: 1},
] as const;

const MOBILE_VIEWPORTS = [
    {viewportWidth: 360, viewportHeight: 800, screenWidth: 360, screenHeight: 800, deviceScaleFactor: 3},
    {viewportWidth: 390, viewportHeight: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 3},
    {viewportWidth: 393, viewportHeight: 873, screenWidth: 393, screenHeight: 873, deviceScaleFactor: 2.75},
    {viewportWidth: 412, viewportHeight: 915, screenWidth: 412, screenHeight: 915, deviceScaleFactor: 2.625},
    {viewportWidth: 430, viewportHeight: 932, screenWidth: 430, screenHeight: 932, deviceScaleFactor: 3},
] as const;

const DEFAULT_PROFILE = buildDesktopProfile();

export const DEFAULT_USER_AGENT = DEFAULT_PROFILE.userAgent;

export function defaultDeviceProfile(): DeviceProfile {
    return {
        ...DEFAULT_PROFILE,
        languages: [...DEFAULT_PROFILE.languages],
    };
}

export function generateRandomDeviceProfile(): DeviceProfile {
    return Math.random() < 0.68 ? buildDesktopProfile() : buildMobileProfile();
}

export function getDeviceClientHints(profile: DeviceProfile): DeviceClientHints {
    const majorVersion = extractBrowserMajorVersion(profile.userAgent);
    const fullVersion = extractBrowserFullVersion(profile.userAgent);
    const brands =
        profile.browser === "edge"
            ? [
                `"Microsoft Edge";v="${majorVersion}"`,
                `"Chromium";v="${majorVersion}"`,
                `"Not.A/Brand";v="24"`,
            ]
            : [
                `"Google Chrome";v="${majorVersion}"`,
                `"Chromium";v="${majorVersion}"`,
                `"Not.A/Brand";v="24"`,
            ];
    const fullVersionBrands =
        profile.browser === "edge"
            ? [
                `"Microsoft Edge";v="${fullVersion}"`,
                `"Chromium";v="${fullVersion}"`,
                `"Not.A/Brand";v="24.0.0.0"`,
            ]
            : [
                `"Google Chrome";v="${fullVersion}"`,
                `"Chromium";v="${fullVersion}"`,
                `"Not.A/Brand";v="24.0.0.0"`,
            ];

    return {
        secChUa: brands.join(", "),
        secChUaFullVersionList: fullVersionBrands.join(", "),
        secChUaMobile: profile.isMobile ? "?1" : "?0",
        secChUaPlatform: profile.os === "android" ? '"Android"' : '"Windows"',
        secChUaPlatformVersion: profile.os === "android" ? `"${profile.osVersion}"` : '"15.0.0"',
        secChViewportWidth: `"${profile.viewportWidth}"`,
    };
}

function buildDesktopProfile(): DeviceProfile {
    const viewport = pick(DESKTOP_VIEWPORTS);
    const locale = pick(DESKTOP_LOCALES);
    const browser = Math.random() < 0.72 ? "chrome" : "edge";
    const chromeMajor = randomInt(134, 146);
    const chromeBuild = randomInt(6000, 9999);
    const chromePatch = randomInt(50, 220);
    const edgeMajor = clamp(chromeMajor + randomInt(-1, 0), 134, 146);
    const userAgent =
        browser === "edge"
            ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36 Edg/${edgeMajor}.0.${randomInt(3000, 9999)}.${randomInt(30, 220)}`
            : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36`;

    return {
        id: randomUUID(),
        family: "desktop",
        browser,
        os: "windows",
        osVersion: "10.0",
        userAgent,
        locale: locale.locale,
        languages: [...locale.languages],
        acceptLanguage: locale.acceptLanguage,
        timezoneId: locale.timezoneId,
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        screenWidth: viewport.screenWidth,
        screenHeight: viewport.screenHeight,
        outerWidth: viewport.viewportWidth + randomInt(8, 16),
        outerHeight: viewport.viewportHeight + randomInt(72, 96),
        deviceScaleFactor: viewport.deviceScaleFactor,
        hardwareConcurrency: pick([4, 8, 8, 12, 16]),
        deviceMemory: pick([4, 8, 8, 16]),
        jsHeapSizeLimit: pick([4293918720, 4294705152, 4294967296]),
        platform: "Win32",
        vendor: "Google Inc.",
        maxTouchPoints: 0,
        hasTouch: false,
        isMobile: false,
        colorDepth: 24,
        pixelDepth: 24,
    };
}

function buildMobileProfile(): DeviceProfile {
    const viewport = pick(MOBILE_VIEWPORTS);
    const locale = pick(MOBILE_LOCALES);
    const chromeMajor = randomInt(133, 146);
    const chromeBuild = randomInt(6000, 9999);
    const chromePatch = randomInt(50, 220);
    const androidMajor = pick([12, 13, 14, 15]);
    const androidModel = pick(["Pixel 7", "Pixel 8", "Pixel 8 Pro", "SM-S918B", "SM-S928B", "CPH2487", "MI 13"]);

    return {
        id: randomUUID(),
        family: "mobile",
        browser: "chrome",
        os: "android",
        osVersion: `${androidMajor}.0.0`,
        userAgent: `Mozilla/5.0 (Linux; Android ${androidMajor}; ${androidModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Mobile Safari/537.36`,
        locale: locale.locale,
        languages: [...locale.languages],
        acceptLanguage: locale.acceptLanguage,
        timezoneId: locale.timezoneId,
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        screenWidth: viewport.screenWidth,
        screenHeight: viewport.screenHeight,
        outerWidth: viewport.viewportWidth,
        outerHeight: viewport.viewportHeight,
        deviceScaleFactor: viewport.deviceScaleFactor,
        hardwareConcurrency: pick([4, 6, 8]),
        deviceMemory: pick([4, 6, 8, 8]),
        jsHeapSizeLimit: pick([2147483648, 3221225472, 4294967296]),
        platform: "Linux armv8l",
        vendor: "Google Inc.",
        maxTouchPoints: pick([5, 10]),
        hasTouch: true,
        isMobile: true,
        colorDepth: 24,
        pixelDepth: 24,
    };
}

function pick<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function extractBrowserMajorVersion(userAgent: string): string {
    const edgeMatch = /Edg\/(\d+)/.exec(userAgent);
    if (edgeMatch?.[1]) {
        return edgeMatch[1];
    }

    const chromeMatch = /Chrome\/(\d+)/.exec(userAgent);
    return chromeMatch?.[1] ?? "146";
}

function extractBrowserFullVersion(userAgent: string): string {
    const edgeMatch = /Edg\/([\d.]+)/.exec(userAgent);
    if (edgeMatch?.[1]) {
        return edgeMatch[1];
    }

    const chromeMatch = /Chrome\/([\d.]+)/.exec(userAgent);
    return chromeMatch?.[1] ?? "146.0.0.0";
}
