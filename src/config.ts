import {readFileSync} from "node:fs";
import path from "node:path";

export type MailProviderName = "2925" | "gmail" | "proxiedmail" | "cloudflare" | "hotmail";

interface AppConfigFile {
    provider?: unknown;
    defaultPassword?: unknown;
    loopDelayMs?: unknown;
    gmailAccessToken?: unknown;
    gmailEmailAddress?: unknown;
    "2925EmailAddress"?: unknown;
    "2925Password"?: unknown;
    cloudflareEmailDomain?: unknown;
    cloudflareApiBaseUrl?: unknown;
    cloudflareApiKey?: unknown;
    defaultProxyUrl?: unknown;
}

export interface AppConfig {
    provider: MailProviderName;
    defaultPassword: string;
    loopDelayMs: number;
    gmailAccessToken: string;
    gmailEmailAddress: string;
    ["2925EmailAddress"]: string;
    ["2925Password"]: string;
    cloudflareEmailDomain: string;
    cloudflareApiBaseUrl: string;
    cloudflareApiKey: string;
    defaultProxyUrl: string;
}

const DEFAULT_CONFIG: AppConfig = {
    provider: "proxiedmail",
    defaultPassword: "kuaileshifu88",
    loopDelayMs: 120000,
    gmailAccessToken: "",
    gmailEmailAddress: "",
    "2925EmailAddress": "",
    "2925Password": "",
    cloudflareEmailDomain: "",
    cloudflareApiBaseUrl: "",
    cloudflareApiKey: "",
    defaultProxyUrl: "http://127.0.0.1:10808",
};

function normalizeNumber(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function normalizeProvider(value: unknown): MailProviderName {
    if (value === "2925" || value === "gmail" || value === "proxiedmail" || value === "cloudflare" || value === "hotmail") {
        return value;
    }
    return DEFAULT_CONFIG.provider;
}

function loadConfig(): AppConfig {
    const configPath = path.resolve(process.cwd(), "config.json");
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch {
        throw new Error("未找到 config.json，请先复制 config.example.json 为 config.json 并按需修改配置");
    }

    const parsed = JSON.parse(raw) as AppConfigFile;
    return {
        provider: normalizeProvider(parsed.provider),
        defaultPassword:
            typeof parsed.defaultPassword === "string" && parsed.defaultPassword.trim()
                ? parsed.defaultPassword
                : DEFAULT_CONFIG.defaultPassword,
        loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
        gmailAccessToken:
            typeof parsed.gmailAccessToken === "string"
                ? parsed.gmailAccessToken.trim()
                : DEFAULT_CONFIG.gmailAccessToken,
        gmailEmailAddress:
            typeof parsed.gmailEmailAddress === "string"
                ? parsed.gmailEmailAddress.trim()
                : DEFAULT_CONFIG.gmailEmailAddress,
        "2925EmailAddress":
            typeof parsed["2925EmailAddress"] === "string"
                ? parsed["2925EmailAddress"].trim()
                : DEFAULT_CONFIG["2925EmailAddress"],
        "2925Password":
            typeof parsed["2925Password"] === "string"
                ? parsed["2925Password"].trim()
                : DEFAULT_CONFIG["2925Password"],
        cloudflareEmailDomain:
            typeof parsed.cloudflareEmailDomain === "string" && parsed.cloudflareEmailDomain.trim()
                ? parsed.cloudflareEmailDomain.trim()
                : DEFAULT_CONFIG.cloudflareEmailDomain,
        cloudflareApiBaseUrl:
            typeof parsed.cloudflareApiBaseUrl === "string"
                ? parsed.cloudflareApiBaseUrl.trim()
                : DEFAULT_CONFIG.cloudflareApiBaseUrl,
        cloudflareApiKey:
            typeof parsed.cloudflareApiKey === "string"
                ? parsed.cloudflareApiKey.trim()
                : DEFAULT_CONFIG.cloudflareApiKey,
        defaultProxyUrl:
            typeof parsed.defaultProxyUrl === "string"
                ? parsed.defaultProxyUrl.trim()
                : DEFAULT_CONFIG.defaultProxyUrl,
    };
}

export const appConfig = loadConfig();
